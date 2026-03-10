import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';

export const artworksRouter = Router();

// ── GET /artworks ─────────────────────────────────────────────────────────────
artworksRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const artworks = db.prepare('SELECT id, name, artist, ln_address FROM artworks ORDER BY name').all();
  res.json(artworks);
});

// ── GET /artworks/:id ─────────────────────────────────────────────────────────
artworksRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const artwork = db.prepare('SELECT id, name, artist, ln_address FROM artworks WHERE id = ?').get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found' });
  return res.json(artwork);
});

// ── POST /artworks (admin) ────────────────────────────────────────────────────
artworksRouter.post('/', (req: Request, res: Response) => {
  const { name, artist, ln_address } = req.body;
  if (!name || !ln_address) return res.status(400).json({ error: 'name and ln_address are required' });

  const db = getDb();
  const id = randomUUID();
  db.prepare(`INSERT INTO artworks (id, name, artist, ln_address, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, artist || null, ln_address, Date.now());

  return res.status(201).json({ id, name, artist, ln_address });
});
