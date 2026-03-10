// ── Reconciliation Script ─────────────────────────────────────────────────────
// Run manually: npm run reconcile
// Or schedule via cron for nightly checks.
//
// Validates: Treasury Balance ≈ Σ(Active Session Balances) + Σ(Pending LNURL commitments)
// Any significant discrepancy should be investigated.

import dotenv from 'dotenv';
dotenv.config();

import { getDb } from '../db/database';
import { getWalletBalance } from '../services/blink';

async function reconcile() {
  const db = getDb();
  console.log('\n=== ARTSAT RECONCILIATION ===');
  console.log('Run at:', new Date().toISOString());
  console.log('');

  // Active ledger balances
  const ledgerResult = db.prepare(`
    SELECT
      COUNT(*) as session_count,
      COALESCE(SUM(b.amount_sats), 0) as total_sats
    FROM sessions s
    JOIN balances b ON b.session_token = s.token
    WHERE b.status = 'active' AND s.expires_at > ?
  `).get(Date.now()) as { session_count: number; total_sats: number };

  // Committed LNURL withdrawals (printed but not yet redeemed)
  const committed = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount_sats), 0) as total_sats
    FROM lnurl_withdrawals WHERE status = 'pending'
  `).get() as { count: number; total_sats: number };

  // All-time totals
  const allTime = db.prepare(`
    SELECT type, status, COUNT(*) as count, SUM(ABS(amount_sats)) as sats
    FROM transactions GROUP BY type, status ORDER BY type, status
  `).all() as { type: string; status: string; count: number; sats: number }[];

  console.log('LEDGER');
  console.log(`  Active sessions with balance: ${ledgerResult.session_count}`);
  console.log(`  Total active ledger sats:     ${ledgerResult.total_sats}`);
  console.log('');
  console.log('COMMITTED (printed, not redeemed)');
  console.log(`  Outstanding vouchers: ${committed.count}`);
  console.log(`  Committed sats:       ${committed.total_sats}`);
  console.log('');
  console.log('ALL-TIME TRANSACTIONS');
  allTime.forEach(r => {
    console.log(`  ${r.type.padEnd(16)} ${r.status.padEnd(12)} count=${r.count} sats=${r.sats}`);
  });
  console.log('');

  // Treasury balance from Blink
  try {
    const treasurySats = await getWalletBalance(
      process.env.BLINK_TREASURY_WALLET_ID!,
      process.env.BLINK_TREASURY_API_KEY!
    );
    const expected = ledgerResult.total_sats + committed.total_sats;
    const discrepancy = treasurySats - expected;

    console.log('RECONCILIATION');
    console.log(`  Treasury wallet balance: ${treasurySats} sats`);
    console.log(`  Expected (ledger + committed): ${expected} sats`);
    console.log(`  Discrepancy: ${discrepancy} sats`);
    console.log('');

    if (Math.abs(discrepancy) < 10) {
      console.log('  STATUS: ✓ OK (within 10 sat tolerance for routing fees)');
    } else {
      console.log('  STATUS: ⚠ DISCREPANCY — investigate transaction log');
      process.exit(1);
    }
  } catch (err: any) {
    console.log('  Could not fetch Treasury balance:', err.message);
    console.log('  Manual reconciliation required.');
  }

  console.log('\n============================\n');
}

reconcile().catch(console.error);
