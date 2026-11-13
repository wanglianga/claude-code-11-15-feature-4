import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from './db';

const SECRET = process.env.AUTH_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export interface AuthUser {
  id: number;
  username: string;
  role: 'hq' | 'manager';
  storeId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pw, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function signToken(userId: number): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(`${uid}.${exp}`).digest('hex');
  if (sig !== expect) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(uid);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const uid = token ? verifyToken(token) : null;
  if (!uid) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '未登录或登录已过期' } });
    return;
  }
  const r = await pool().query('SELECT id, username, role, store_id FROM users WHERE id=$1', [uid]);
  const u = r.rows[0];
  if (!u) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '用户不存在' } });
    return;
  }
  req.user = { id: u.id, username: u.username, role: u.role, storeId: u.store_id };
  next();
}

export function requireRole(role: 'hq' | 'manager') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || req.user.role !== role) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要 ' + role + ' 角色' } });
      return;
    }
    next();
  };
}

/** 门店账号只能操作本店数据；总部不限 */
export function scopeStoreId(req: Request, requested: number): number | null {
  if (!req.user) return null;
  if (req.user.role === 'hq') return requested;
  if (req.user.storeId !== requested) return null;
  return requested;
}
