import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import { getSatsPerEur, satsToEur } from '../services/price';

export const sessionsRouter = Router();

const EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '24');

// ── POST /sessions ────────────────────────────────────────────────────────────
// Called by entry terminal to create a new visitor session.
// Returns the session token and a webapp URL for the QR code.

sessionsRouter.post('/', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const token = randomUUID();
    const now = Date.now();
    const expiresAt = now + EXPIRY_HOURS * 60 * 60 * 1000;

    // Generate a short human-readable display ID for staff reference
    const displayId = '#' + Math.floor(1000 + Math.random() * 9000).toString();

    db.prepare(`
      INSERT INTO sessions (token, created_at, expires_at, display_id)
      VALUES (?, ?, ?, ?)
    `).run(token, now, expiresAt, displayId);

    db.prepare(`
      INSERT INTO balances (session_token, amount_sats, status, updated_at)
      VALUES (?, 0, 'active', ?)
    `).run(token, now);

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    res.json({
      token,
      display_id: displayId,
      webapp_url: `${baseUrl}/session/${token}`,
      expires_at: new Date(expiresAt).toISOString(),
    });
  } catch (err) {
    console.error('[sessions] POST error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── GET /sessions/:token ──────────────────────────────────────────────────────
// Called by webapp and exit terminal to fetch current balance.

sessionsRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { token } = req.params;

    const session = db.prepare(`
      SELECT s.token, s.display_id, s.expires_at,
             b.amount_sats, b.status
      FROM sessions s
      JOIN balances b ON b.session_token = s.token
      WHERE s.token = ?
    `).get(token) as {
      token: string; display_id: string; expires_at: number;
      amount_sats: number; status: string;
    } | undefined;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const now = Date.now();
    if (now > session.expires_at) {
      return res.status(410).json({ error: 'Session expired' });
    }

    // Get price for fiat display — non-fatal if unavailable
    let fiatDisplay = null;
    try {
      const { satsPerEur, stale } = await getSatsPerEur();
      fiatDisplay = {
        amount_eur: satsToEur(session.amount_sats, satsPerEur),
        currency: 'EUR',
        price_stale: stale,
      };
    } catch (_) {}

    return res.json({
      token: session.token,
      display_id: session.display_id,
      balance_sats: session.amount_sats,
      balance_status: session.status,
      fiat: fiatDisplay,
      expires_at: new Date(session.expires_at).toISOString(),
    });
  } catch (err) {
    console.error('[sessions] GET error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});
