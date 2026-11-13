import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DATE 列按 'YYYY-MM-DD' 字符串返回，避免 node-pg 默认转 Date 带来的时区漂移
pg.types.setTypeParser(1082, (v) => v);

const DEFAULT_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev';

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_URL });
  }
  return _pool;
}

export async function migrate(): Promise<void> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  await pool().query(sql);
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
