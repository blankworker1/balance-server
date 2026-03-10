import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';

export const donationsRouter = Router();

// ── POST /donations ───────────────────────────────────────────────────────────
// Visitor donates their balance to the artists.
// Zeros the ledger balance. Sats remain in Treasury wallet.

donationsRouter.post('/', (req: Request, res: Response) => {
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
  if (session.amount_sats <= 0) return res.status(402).json({ error: 'No balance to donate' });

  const donated = session.amount_sats;
  const now = Date.now();
  const txnId = randomUUID();

  db.transaction(() => {
    db.prepare(`UPDATE balances SET amount_sats = 0, status = 'donated', updated_at = ? WHERE session_token = ?`)
      .run(now, session_token);
    db.prepare(`
      INSERT INTO transactions (id, session_token, type, amount_sats, status, created_at, updated_at)
      VALUES (?, ?, 'donation', ?, 'confirmed', ?, ?)
    `).run(txnId, session_token, -donated, now, now);
  })();

  return res.json({
    success: true,
    donated_sats: donated,
    transaction_id: txnId,
  });
});
