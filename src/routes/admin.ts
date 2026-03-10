import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { getWalletBalance } from '../services/blink';

export const adminRouter = Router();

// ── GET /admin/status ─────────────────────────────────────────────────────────
// Live system overview for the admin dashboard.
// Shows wallet balances, ledger totals, and reconciliation status.

adminRouter.get('/status', async (_req: Request, res: Response) => {
  const db = getDb();

  // Ledger totals
  const ledger = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(CASE WHEN b.status = 'active' THEN 1 ELSE 0 END) as active_sessions,
      SUM(b.amount_sats) as total_ledger_sats,
      SUM(CASE WHEN b.status = 'active' THEN b.amount_sats ELSE 0 END) as active_balance_sats
    FROM sessions s JOIN balances b ON b.session_token = s.token
  `).get() as {
    total_sessions: number; active_sessions: number;
    total_ledger_sats: number; active_balance_sats: number;
  };

  // Outstanding LNURL commitments
  const committed = db.prepare(`
    SELECT COALESCE(SUM(amount_sats), 0) as committed_sats, COUNT(*) as count
    FROM lnurl_withdrawals WHERE status = 'pending'
  `).get() as { committed_sats: number; count: number };

  // Recent transactions
  const recentTxns = db.prepare(`
    SELECT type, status, COUNT(*) as count, SUM(ABS(amount_sats)) as total_sats
    FROM transactions
    WHERE created_at > ?
    GROUP BY type, status
    ORDER BY type, status
  `).all(Date.now() - 24 * 60 * 60 * 1000);

  // Pending (stuck) transactions — may need manual review
  const pendingTxns = db.prepare(`
    SELECT id, session_token, type, amount_sats, created_at
    FROM transactions WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all();

  // Wallet balances from Blink
  let wallets = null;
  try {
    const [atmBalance, treasuryBalance] = await Promise.all([
      getWalletBalance(process.env.BLINK_ATM_WALLET_ID!, process.env.BLINK_ATM_API_KEY!),
      getWalletBalance(process.env.BLINK_TREASURY_WALLET_ID!, process.env.BLINK_TREASURY_API_KEY!),
    ]);
    wallets = { atm_sats: atmBalance, treasury_sats: treasuryBalance };
  } catch (err: any) {
    wallets = { error: 'Could not fetch wallet balances: ' + err.message };
  }

  // Reconciliation check:
  // Treasury should equal active ledger balances + committed LNURL amounts
  // Discrepancy indicates a potential accounting error
  let reconciliation = null;
  if (wallets && 'treasury_sats' in wallets) {
    const expected = ledger.active_balance_sats + committed.committed_sats;
    const discrepancy = wallets.treasury_sats - expected;
    reconciliation = {
      treasury_sats: wallets.treasury_sats,
      expected_sats: expected,
      discrepancy_sats: discrepancy,
      status: Math.abs(discrepancy) < 10 ? 'OK' : 'DISCREPANCY',
      note: 'Small discrepancy (<10 sats) may be routing fees'
    };
  }

  return res.json({
    timestamp: new Date().toISOString(),
    wallets,
    ledger,
    committed_withdrawals: committed,
    recent_transactions: recentTxns,
    pending_transactions: pendingTxns,
    reconciliation,
  });
});
