import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';

export const vouchersRouter = Router();

// ── POST /vouchers/redeem ─────────────────────────────────────────────────────
// Called by visitor webapp after scanning ATM voucher QR.
// The voucher was already created and funded by the ATM wallet.
// Redemption moves sats from ATM wallet to Treasury wallet via Blink,
// then credits the visitor's ledger balance.
//
// NOTE: In the Blink voucher model, the "redemption" is handled by Blink
// internally when the voucher code is presented. Your backend records the
// credit. Adjust the Blink API call below to match Blink's actual voucher
// redemption endpoint once confirmed in Phase 0A testing.

vouchersRouter.post('/redeem', async (req: Request, res: Response) => {
  const { voucher_code, session_token } = req.body;

  if (!voucher_code || !session_token) {
    return res.status(400).json({ error: 'voucher_code and session_token are required' });
  }

  const db = getDb();

  // ── Check session is valid ────────────────────────────────────────────────
  const session = db.prepare(`
    SELECT s.token, s.expires_at, b.status
    FROM sessions s JOIN balances b ON b.session_token = s.token
    WHERE s.token = ?
  `).get(session_token) as { token: string; expires_at: number; status: string } | undefined;

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (Date.now() > session.expires_at) return res.status(410).json({ error: 'Session expired' });
  if (session.status !== 'active') return res.status(409).json({ error: 'Session not active' });

  // ── Check voucher not already redeemed (idempotency guard) ───────────────
  const existing = db.prepare('SELECT code, redeemed_at, amount_sats FROM vouchers WHERE code = ?').get(voucher_code) as
    { code: string; redeemed_at: number | null; amount_sats: number } | undefined;

  if (existing?.redeemed_at) {
    return res.status(409).json({ error: 'Voucher already redeemed' });
  }

  // ── Call Blink API to redeem voucher ─────────────────────────────────────
  // TODO: Replace with actual Blink voucher redemption API call once confirmed.
  // The call should move sats from ATM wallet to Treasury wallet.
  // On success, Blink returns the sat amount and a transaction reference.
  //
  // Example structure (verify against Blink docs):
  //   POST to Blink ATM wallet API with voucher code
  //   Returns: { amount_sats, transaction_id }

  let amountSats: number;
  let blinkRef: string;

  try {
    // --- PLACEHOLDER: replace with real Blink voucher redemption ---
    // const result = await redeemBlinkVoucher(voucher_code);
    // amountSats = result.amount_sats;
    // blinkRef = result.transaction_id;

    // For now throw to indicate this needs wiring up
    throw new Error('Blink voucher redemption not yet implemented — see Phase 0A');
  } catch (err: any) {
    console.error('[vouchers] Blink redemption error:', err.message);
    return res.status(502).json({ error: 'Voucher redemption failed', detail: err.message });
  }

  // ── Atomic DB update ──────────────────────────────────────────────────────
  // Mark voucher redeemed AND credit balance in a single transaction.
  // If either fails, neither happens.

  const txnId = randomUUID();
  const now = Date.now();

  try {
    db.transaction(() => {
      // Record or update voucher
      db.prepare(`
        INSERT INTO vouchers (code, amount_sats, created_at, redeemed_at, redeemed_by, blink_ref)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          redeemed_at = excluded.redeemed_at,
          redeemed_by = excluded.redeemed_by,
          blink_ref   = excluded.blink_ref
      `).run(voucher_code, amountSats!, now, now, session_token, blinkRef!);

      // Credit balance
      db.prepare(`
        UPDATE balances SET amount_sats = amount_sats + ?, updated_at = ?
        WHERE session_token = ?
      `).run(amountSats!, now, session_token);

      // Log transaction
      db.prepare(`
        INSERT INTO transactions (id, session_token, type, amount_sats, status, external_ref, created_at, updated_at)
        VALUES (?, ?, 'voucher_redeem', ?, 'confirmed', ?, ?, ?)
      `).run(txnId, session_token, amountSats!, voucher_code, now, now);
    })();

    // Return updated balance
    const balance = db.prepare('SELECT amount_sats FROM balances WHERE session_token = ?').get(session_token) as
      { amount_sats: number };

    return res.json({
      success: true,
      credited_sats: amountSats!,
      new_balance_sats: balance.amount_sats,
      transaction_id: txnId,
    });
  } catch (err) {
    console.error('[vouchers] DB update error:', err);
    return res.status(500).json({ error: 'Failed to update balance after redemption' });
  }
});
