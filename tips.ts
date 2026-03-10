import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import { payLightningAddress } from '../services/blink';

export const tipsRouter = Router();

// ── POST /tips ────────────────────────────────────────────────────────────────
// Visitor tips an artwork. Deducts from ledger (as pending), calls Blink to pay
// the artwork's Lightning address, then confirms or refunds.

tipsRouter.post('/', async (req: Request, res: Response) => {
  const { session_token, artwork_id, amount_sats } = req.body;

  if (!session_token || !artwork_id || !amount_sats) {
    return res.status(400).json({ error: 'session_token, artwork_id, and amount_sats are required' });
  }
  if (!Number.isInteger(amount_sats) || amount_sats <= 0) {
    return res.status(400).json({ error: 'amount_sats must be a positive integer' });
  }

  const db = getDb();

  // ── Validate session ──────────────────────────────────────────────────────
  const session = db.prepare(`
    SELECT s.expires_at, b.amount_sats, b.status
    FROM sessions s JOIN balances b ON b.session_token = s.token
    WHERE s.token = ?
  `).get(session_token) as { expires_at: number; amount_sats: number; status: string } | undefined;

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (Date.now() > session.expires_at) return res.status(410).json({ error: 'Session expired' });
  if (session.status !== 'active') return res.status(409).json({ error: 'Session not active' });
  if (session.amount_sats < amount_sats) {
    return res.status(402).json({ error: 'Insufficient balance', balance_sats: session.amount_sats });
  }

  // ── Lookup artwork ────────────────────────────────────────────────────────
  const artwork = db.prepare('SELECT id, name, ln_address FROM artworks WHERE id = ?').get(artwork_id) as
    { id: string; name: string; ln_address: string } | undefined;

  if (!artwork) return res.status(404).json({ error: 'Artwork not found' });

  const txnId = randomUUID();
  const now = Date.now();

  // ── Deduct from ledger as PENDING ─────────────────────────────────────────
  // Critical: deduct first so balance can't be double-spent while payment is in flight.
  db.transaction(() => {
    db.prepare('UPDATE balances SET amount_sats = amount_sats - ?, updated_at = ? WHERE session_token = ?')
      .run(amount_sats, now, session_token);
    db.prepare(`
      INSERT INTO transactions (id, session_token, type, amount_sats, status, artwork_id, created_at, updated_at)
      VALUES (?, ?, 'tip', ?, 'pending', ?, ?, ?)
    `).run(txnId, session_token, -amount_sats, artwork_id, now, now);
  })();

  // ── Call Blink to pay artwork ─────────────────────────────────────────────
  try {
    const blinkRef = await payLightningAddress(
      artwork.ln_address,
      amount_sats,
      `Tip for ${artwork.name}`
    );

    // Confirm transaction
    db.prepare(`UPDATE transactions SET status = 'confirmed', external_ref = ?, updated_at = ? WHERE id = ?`)
      .run(blinkRef, Date.now(), txnId);

    const balance = db.prepare('SELECT amount_sats FROM balances WHERE session_token = ?').get(session_token) as
      { amount_sats: number };

    return res.json({
      success: true,
      tipped_sats: amount_sats,
      artwork: artwork.name,
      new_balance_sats: balance.amount_sats,
      transaction_id: txnId,
    });

  } catch (err: any) {
    // ── Payment failed — refund the ledger ───────────────────────────────
    console.error('[tips] Payment failed, refunding:', err.message);

    db.transaction(() => {
      db.prepare('UPDATE balances SET amount_sats = amount_sats + ?, updated_at = ? WHERE session_token = ?')
        .run(amount_sats, Date.now(), session_token);
      db.prepare(`UPDATE transactions SET status = 'failed', notes = ?, updated_at = ? WHERE id = ?`)
        .run(err.message, Date.now(), txnId);
    })();

    return res.status(502).json({
      error: 'Payment to artwork failed — your balance has been restored',
      detail: err.message,
    });
  }
});
