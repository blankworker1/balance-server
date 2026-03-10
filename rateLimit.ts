import { Request, Response, NextFunction } from 'express';

// Simple in-memory rate limiter — good enough for a single-event POC.
// For production, replace with redis-backed limiter.

const hits: Map<string, number[]> = new Map();

export function rateLimit(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;

    const timestamps = (hits.get(key) || []).filter(t => now - t < windowMs);
    timestamps.push(now);
    hits.set(key, timestamps);

    if (timestamps.length > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    return next();
  };
}
