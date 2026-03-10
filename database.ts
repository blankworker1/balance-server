import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'artsat.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`

    -- Visitor sessions
    CREATE TABLE IF NOT EXISTS sessions (
      token         TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      display_id    TEXT NOT NULL
    );

    -- Current sat balance per session
    CREATE TABLE IF NOT EXISTS balances (
      session_token TEXT PRIMARY KEY REFERENCES sessions(token),
      amount_sats   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',
      updated_at    INTEGER NOT NULL
    );

    -- Full transaction ledger
    CREATE TABLE IF NOT EXISTS transactions (
      id            TEXT PRIMARY KEY,
      session_token TEXT NOT NULL REFERENCES sessions(token),
      type          TEXT NOT NULL,
      amount_sats   INTEGER NOT NULL,
      status        TEXT NOT NULL,
      external_ref  TEXT,
      artwork_id    TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      notes         TEXT
    );

    -- ATM vouchers
    CREATE TABLE IF NOT EXISTS vouchers (
      code          TEXT PRIMARY KEY,
      amount_sats   INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      redeemed_at   INTEGER,
      redeemed_by   TEXT REFERENCES sessions(token),
      blink_ref     TEXT
    );

    -- LNURL-Withdraw records for printed exit vouchers
    CREATE TABLE IF NOT EXISTS lnurl_withdrawals (
      id            TEXT PRIMARY KEY,
      session_token TEXT NOT NULL REFERENCES sessions(token),
      amount_sats   INTEGER NOT NULL,
      k1            TEXT NOT NULL UNIQUE,
      lnurl         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      paid_at       INTEGER,
      payment_ref   TEXT
    );

    -- Artwork registry
    CREATE TABLE IF NOT EXISTS artworks (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      artist        TEXT,
      ln_address    TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    -- BTC price cache
    CREATE TABLE IF NOT EXISTS price_cache (
      id            INTEGER PRIMARY KEY DEFAULT 1,
      sats_per_eur  REAL NOT NULL,
      fetched_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_session ON transactions(session_token);
    CREATE INDEX IF NOT EXISTS idx_transactions_status  ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_lnurl_k1             ON lnurl_withdrawals(k1);
    CREATE INDEX IF NOT EXISTS idx_lnurl_status         ON lnurl_withdrawals(status);

  `);
}
