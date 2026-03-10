import { getDb } from '../db/database';
import { fetchBtcEurPrice } from './blink';

const STALENESS_MS = parseInt(process.env.PRICE_STALENESS_MINUTES || '15') * 60 * 1000;

// Returns sats per EUR from cache, refreshing if stale.
// Falls back to last known good price if fetch fails.
export async function getSatsPerEur(): Promise<{ satsPerEur: number; stale: boolean }> {
  const db = getDb();
  const cached = db.prepare('SELECT sats_per_eur, fetched_at FROM price_cache WHERE id = 1').get() as
    { sats_per_eur: number; fetched_at: number } | undefined;

  const now = Date.now();
  const isStale = !cached || (now - cached.fetched_at) > STALENESS_MS;

  if (!isStale && cached) {
    return { satsPerEur: cached.sats_per_eur, stale: false };
  }

  try {
    const fresh = await fetchBtcEurPrice();
    db.prepare(`
      INSERT INTO price_cache (id, sats_per_eur, fetched_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sats_per_eur = excluded.sats_per_eur, fetched_at = excluded.fetched_at
    `).run(fresh, now);
    return { satsPerEur: fresh, stale: false };
  } catch (err) {
    // Fetch failed — return last known good with stale flag
    if (cached) {
      console.error('[price] Fetch failed, using stale price:', err);
      return { satsPerEur: cached.sats_per_eur, stale: true };
    }
    throw new Error('No price data available and fetch failed');
  }
}

export function satsToEur(sats: number, satsPerEur: number): string {
  return (sats / satsPerEur).toFixed(2);
}
