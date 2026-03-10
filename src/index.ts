import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { sessionsRouter }    from './routes/sessions';
import { vouchersRouter }    from './routes/vouchers';
import { tipsRouter }        from './routes/tips';
import { withdrawalsRouter } from './routes/withdrawals';
import { donationsRouter }   from './routes/donations';
import { artworksRouter }    from './routes/artworks';
import { adminRouter }       from './routes/admin';
import { rateLimit }         from './middleware/rateLimit';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// CORS — allow your webapp domain in production
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/sessions',    rateLimit(30), sessionsRouter);
app.use('/vouchers',    rateLimit(20), vouchersRouter);
app.use('/tips',        rateLimit(30), tipsRouter);
app.use('/withdraw',    rateLimit(60), withdrawalsRouter);  // higher limit — wallets poll this
app.use('/donations',   rateLimit(20), donationsRouter);
app.use('/artworks',    rateLimit(60), artworksRouter);
app.use('/admin',       adminRouter);   // restrict to your IP in production

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Artsat server running on port ${PORT}`);
  console.log(`Base URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}`);
});
