import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { bech32 } from 'bech32';
import { getDb } from '../db/database';
import { payLightningInvoice } from '../services/blink';

export const withdrawalsRouter = Router();

const EXPIRY_DAYS = parseInt(process.env.WITHDRAWAL_EXPIRY_DAYS || '90');

// ── Encode LNURL ──────────────────────────────────────────────────────────────
function encodeLnurl(url: string): string {
  const words = bech32.toWords(Buffer.from(url, 'utf8'));
  return bech32.encode('lnurl', words, 2000).toUpperCase();
}

// ── POST /withdrawals ─────────────────────────────────────────────────────────
// Called by exit terminal when visitor chooses "Print Voucher".
// Creates an LNURL-Withdraw record, marks balance as committed,
// returns the LNURL string for printing.

withdrawalsRouter.post('/', async (req: Request, res: Response) => {
  const { session_token } = req.body;

  if (!session_token) {
    return res.status(400).json({ error: 'session_token is required' });
  }

  const db = getDb();

  const session = db.prepare(`
    SELECT s.expires_at, b.amount_sats, b.status
    FROM sessions s JOIN balances b ON b.session_token = s.token
    WHERE s.token = ?
  `).get(session_token) as { expires_at: number; amount_sats: number; status: string } | undefined;

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') return res.status(409).json({ error: `Session status: ${session.status}` });
  if (session.amount_sats <= 0) return res.status(402).json({ error: 'No balance to withdraw' });

  const id = randomUUID();
  const k1 = randomUUID().replace(/-/g, ''); // random challenge for LNURL flow
  const now = Date.now();
  const expiresAt = now + EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const amountSats = session.amount_sats;
  const amountMsats = amountSats * 1000;

  const baseUrl = process.env.BASE_URL!;

  // The LNURL-Withdraw spec requires this URL structure
  const withdrawUrl = `${baseUrl}/withdraw/callback?k1=${k1}`;
  const infoUrl = `${baseUrl}/withdraw/${id}`;
  const lnurl = encodeLnurl(infoUrl);

  // ── Commit balance and create withdrawal record atomically ────────────────
  db.transaction(() => {
    db.prepare(`
      INSERT INTO lnurl_withdrawals (id, session_token, amount_sats, k1, lnurl, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, session_token, amountSats, k1, lnurl, now, expiresAt);

    db.prepare(`UPDATE balances SET status = 'cashing_out', updated_at = ? WHERE session_token = ?`)
      .run(now, session_token);
  })();

  return res.json({
    id,
    lnurl,
    amount_sats: amountSats,
    expires_at: new Date(expiresAt).toISOString(),
  });
});

// ── GET /withdraw/:id ─────────────────────────────────────────────────────────
// LNURL-Withdraw spec: Step 1.
// Visitor's Lightning wallet hits this URL after decoding the LNURL QR.
// Returns the withdraw parameters so the wallet knows how much to request.

withdrawalsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const withdrawal = db.prepare(`
    SELECT id, k1, amount_sats, status, expires_at
    FROM lnurl_withdrawals WHERE id = ?
  `).get(id) as { id: string; k1: string; amount_sats: number; status: string; expires_at: number } | undefined;

  if (!withdrawal) return res.status(404).json({ status: 'ERROR', reason: 'Withdrawal not found' });
  if (withdrawal.status === 'paid') return res.status(410).json({ status: 'ERROR', reason: 'Already withdrawn' });
  if (withdrawal.status === 'expired' || Date.now() > withdrawal.expires_at) {
    return res.status(410).json({ status: 'ERROR', reason: 'Withdrawal expired' });
  }

  const baseUrl = process.env.BASE_URL!;
  const amountMsats = withdrawal.amount_sats * 1000;

  // LNURL-Withdraw spec response (LUD-03)
  return res.json({
    tag: 'withdrawRequest',
    callback: `${baseUrl}/withdraw/callback`,
    k1: withdrawal.k1,
    defaultDescription: 'Art installation withdrawal',
    minWithdrawable: amountMsats,
    maxWithdrawable: amountMsats,
  });
});

// ── GET /withdraw/callback ────────────────────────────────────────────────────
// LNURL-Withdraw spec: Step 2.
// Visitor's wallet sends the payment request (Lightning invoice) here.
// We pay it using the Treasury wallet via Blink.

withdrawalsRouter.get('/callback', async (req: Request, res: Response) => {
  const { k1, pr } = req.query as { k1: string; pr: string };

  if (!k1 || !pr) {
    return res.json({ status: 'ERROR', reason: 'Missing k1 or pr' });
  }

  const db = getDb();

  const withdrawal = db.prepare(`
    SELECT id, session_token, amount_sats, status, expires_at
    FROM lnurl_withdrawals WHERE k1 = ?
  `).get(k1) as { id: string; session_token: string; amount_sats: number; status: string; expires_at: number } | undefined;

  if (!withdrawal) return res.json({ status: 'ERROR', reason: 'Invalid k1' });
  if (withdrawal.status === 'paid') return res.json({ status: 'ERROR', reason: 'Already paid' });
  if (withdrawal.status === 'expired' || Date.now() > withdrawal.expires_at) {
    return res.json({ status: 'ERROR', reason: 'Expired' });
  }

  // Mark as processing immediately to prevent double-pay race condition
  db.prepare(`UPDATE lnurl_withdrawals SET status = 'processing', updated_at = ? WHERE id = ?`)
    .run(Date.now(), withdrawal.id);

  try {
    const paymentRef = await payLightningInvoice(pr);

    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE lnurl_withdrawals SET status = 'paid', paid_at = ?, payment_ref = ?, updated_at = ? WHERE id = ?
      `).run(now, paymentRef, now, withdrawal.id);

      // Zero the balance and mark session withdrawn
      db.prepare(`UPDATE balances SET amount_sats = 0, status = 'withdrawn', updated_at = ? WHERE session_token = ?`)
        .run(now, withdrawal.session_token);

      db.prepare(`
        INSERT INTO transactions (id, session_token, type, amount_sats, status, external_ref, created_at, updated_at)
        VALUES (?, ?, 'withdrawal', ?, 'confirmed', ?, ?, ?)
      `).run(randomUUID(), withdrawal.session_token, -withdrawal.amount_sats, paymentRef, now, now);
    })();

    return res.json({ status: 'OK' });

  } catch (err: any) {
    console.error('[withdrawals] Payment error:', err.message);
    // Reset to pending so they can try again
    db.prepare(`UPDATE lnurl_withdrawals SET status = 'pending', updated_at = ? WHERE id = ?`)
      .run(Date.now(), withdrawal.id);
    return res.json({ status: 'ERROR', reason: 'Payment failed — please try again' });
  }
});
