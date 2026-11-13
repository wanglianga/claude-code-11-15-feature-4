import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { Express } from 'express';

/**
 * 端到端集成测试：独立测试库 ccdev_test，覆盖
 * 幂等并表 / 版本不可变 / 确认-修订落库先后裁定 / 复盘归因口径 / 报损窗口 / 盘点差异剔除。
 */

const ADMIN_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev';
process.env.DATABASE_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev_test';

let app: Express;
let db: typeof import('../src/db');
let hqToken = '';
let store1Token = '';
let store2Token = '';
let store1 = 0;
let skuBo = 0;
let arrival = '';
let today = '';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query('DROP DATABASE IF EXISTS ccdev_test WITH (FORCE)');
  await admin.query('CREATE DATABASE ccdev_test');
  await admin.end();

  db = await import('../src/db');
  await db.migrate();
  const pool = db.pool();

  // 最小确定性夹具
  const s = await pool.query(
    `INSERT INTO stores (code, name) VALUES ('T01','测试一店'),('T02','测试二店') RETURNING id`,
  );
  store1 = s.rows[0].id;
  const c = await pool.query(
    `INSERT INTO categories (code, name, default_cu, default_co) VALUES
       ('LEAFY','叶菜',8,2),('ROOT','根茎',2,2) RETURNING id, code`,
  );
  const leafy = c.rows.find((r) => r.code === 'LEAFY').id;
  const sku = await pool.query(
    `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost)
     VALUES ($1,'BOC','菠菜','份',1,6.5,2.5) RETURNING id`,
    [leafy],
  );
  skuBo = sku.rows[0].id;

  const { hashPassword } = await import('../src/auth');
  await pool.query(
    `INSERT INTO users (username, password_hash, role, store_id) VALUES
       ('hq', $1, 'hq', NULL), ('store1', $2, 'manager', $3), ('store2', $2, 'manager', $4)`,
    [hashPassword('hq123456'), hashPassword('store123456'), store1, s.rows[1].id],
  );

  // 8 个有效还原样本：[10,12,...,24]，τ=0.8 → 经验分位 21.2 → 向上取整 22
  const { todayStr, addDays } = await import('../src/lib/dates');
  today = todayStr();
  arrival = addDays(today, 1);
  const vals = [10, 12, 14, 16, 18, 20, 22, 24];
  for (let i = 0; i < vals.length; i++) {
    await pool.query(
      `INSERT INTO demand_samples
         (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag,
          in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded, source)
       VALUES ($1,$2,$3,13,$4,false,13,$5,$6,false,false,'seed')`,
      [store1, skuBo, addDays(today, -(i + 1)), vals[i], vals[i] / 13, vals[i]],
    );
  }

  const appMod = await import('../src/app');
  app = appMod.createApp();

  hqToken = (await request(app).post('/api/auth/login').send({ username: 'hq', password: 'hq123456' })).body.token;
  store1Token = (await request(app).post('/api/auth/login').send({ username: 'store1', password: 'store123456' })).body.token;
  store2Token = (await request(app).post('/api/auth/login').send({ username: 'store2', password: 'store123456' })).body.token;
  expect(hqToken).toBeTruthy();
}, 30000);

afterAll(async () => {
  await db.closePool();
});

describe('建议生成：临界分位 + 向上取整 + 幂等并表', () => {
  it('首版建议：τ=0.8，经验分位 21.2 → 建议 22（最小订货单位 1）', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-1' });
    expect(res.status).toBe(200);
    expect(res.body.versionNo).toBe(1);

    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(hqToken));
    const item = detail.body.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.quantile)).toBeCloseTo(0.8);
    expect(Number(item.raw_qty)).toBeCloseTo(21.2);
    expect(Number(item.suggested_qty)).toBe(22);
    expect(detail.body.currentVersion.feature_snapshot.baseline).toBe('restored_demand');
  });

  it('同一幂等键重复提交 → 并成一张表，不产生新版本', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-1' });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.versionNo).toBe(1);
    const v = await db.pool().query('SELECT COUNT(*)::int n FROM suggestion_versions');
    expect(v.rows[0].n).toBe(1);
  });

  it('降温事件触发重算 → 新修订版本 v2，v1 原样保留（不可变）', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({
        storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-2',
        triggerEvent: 'temp_drop', features: { tempDrop: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.versionNo).toBe(2);

    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(hqToken));
    expect(detail.body.versions).toHaveLength(2);
    const v1 = detail.body.versions.find((v: { version_no: number }) => v.version_no === 1);
    expect(v1.status).toBe('superseded');
    // v2: 21.2 × 0.9 = 19.08 → 20
    const item = detail.body.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.suggested_qty)).toBe(20);
    // v1 内容未被改写
    const v1Detail = await request(app)
      .get(`/api/suggestions/versions/${v1.id}`).set(auth(hqToken));
    expect(Number(v1Detail.body.items[0].suggested_qty)).toBe(22);
  });
});

describe('确认与修订：按落库先后裁定', () => {
  it('基于旧版本确认 → 409 VERSION_CONFLICT', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const v1 = detail.body.versions.find((v: { version_no: number }) => v.version_no === 1);
    const res = await request(app)
      .post(`/api/versions/${v1.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 22 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('基于最新版本确认 → 成功，版本锁定', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const res = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 20, reasonCode: '降温减量' }] });
    expect(res.status).toBe(200);
    expect(res.body.orderId).toBeTruthy();
  });

  it('确认已落库后总部修订 → 409 REVISION_CONFLICT', async () => {
    const res = await request(app)
      .post('/api/suggestions/generate')
      .set(auth(hqToken))
      .send({ storeId: store1, arrivalDate: arrival, idempotencyKey: 'it-gen-3', triggerEvent: 'promo_cancelled' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('同一幂等键重复确认 → 幂等返回原订单；新键重复确认 → 409', async () => {
    const detail = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`).set(auth(store1Token));
    const again = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-1', items: [{ skuId: skuBo, qty: 20 }] });
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);

    const dup = await request(app)
      .post(`/api/versions/${detail.body.currentVersion.id}/confirm`)
      .set(auth(store1Token))
      .send({ idempotencyKey: 'it-order-2', items: [{ skuId: skuBo, qty: 20 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_CONFIRMED');
    const n = await db.pool().query('SELECT COUNT(*)::int n FROM orders');
    expect(n.rows[0].n).toBe(1);
  });

  it('门店账号不能操作他店数据', async () => {
    const res = await request(app)
      .get(`/api/suggestions?storeId=${store1}&arrivalDate=${arrival}`)
      .set(auth(store2Token));
    expect(res.status).toBe(403);
  });
});

describe('收市复盘：观测需求口径归因 + 样本回流', () => {
  let reviewId = 0;

  it('创建复盘（幂等），归因基准固定为观测需求', async () => {
    const orders = await request(app)
      .get(`/api/orders?storeId=${store1}&arrivalDate=${arrival}`).set(auth(hqToken));
    const orderId = orders.body.orders[0].id;
    const r1 = await request(app).post(`/api/orders/${orderId}/review`).set(auth(hqToken));
    expect(r1.status).toBe(200);
    reviewId = r1.body.reviewId;
    const r2 = await request(app).post(`/api/orders/${orderId}/review`).set(auth(hqToken));
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.reviewId).toBe(reviewId);
  });

  it('售罄日录入：按有货速率外推观测需求，缺货损失按版本快照 Cu 归因', async () => {
    // 实销 15，15:30 售罄 → 有货 7.5h，速率 2 → 观测需求 26，缺货损失 11×Cu8=88
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/entry`)
      .set(auth(hqToken))
      .send({ skuId: skuBo, actualSales: 15, stockoutFlag: true, selloutTime: '15:30', wasteQty: 2 });
    expect(res.status).toBe(200);
    const reviews = await request(app)
      .get(`/api/reviews?storeId=${store1}&arrivalDate=${arrival}`).set(auth(hqToken));
    const review = reviews.body.reviews[0];
    expect(review.baseline).toBe('restored_demand');
    const item = review.items.find((i: { sku_id: number }) => i.sku_id === skuBo);
    expect(Number(item.restored_demand)).toBeCloseTo(26);
    expect(Number(item.stockout_loss_qty)).toBeCloseTo(11);
    expect(Number(item.stockout_loss_amount)).toBeCloseTo(88);
    expect(Number(item.waste_cost)).toBeCloseTo(4); // 2 × Co2
  });

  it('当日样本回流需求还原（截断观测形态）', async () => {
    const s = await db.pool().query(
      'SELECT * FROM demand_samples WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].source).toBe('review_reflow');
    expect(s.rows[0].is_censored).toBe(true);
    expect(Number(s.rows[0].restored_demand)).toBeCloseTo(26);
    expect(s.rows[0].excluded_from_training).toBe(false);
  });
});

describe('报损补录窗口与盘点差异剔除', () => {
  let reviewId = 0;
  beforeAll(async () => {
    const r = await db.pool().query('SELECT id FROM reviews LIMIT 1');
    reviewId = r.rows[0].id;
  });

  it('窗口内补录 → 结转重算（报损量与金额累加重算）', async () => {
    const res = await request(app)
      .post('/api/waste-records')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, qty: 3 });
    expect(res.body.withinWindow).toBe(true);
    expect(res.body.disposition).toBe('recalc');
    const item = await db.pool().query(
      'SELECT waste_qty, waste_cost FROM review_items WHERE review_id=$1 AND sku_id=$2',
      [reviewId, skuBo],
    );
    expect(Number(item.rows[0].waste_qty)).toBe(5);       // 2 + 3
    expect(Number(item.rows[0].waste_cost)).toBeCloseTo(10); // 5 × Co2
  });

  it('过窗补录 → 单独存档注明出处，复盘归因保持原样', async () => {
    const late = new Date(`${arrival}T00:00:00`);
    late.setDate(late.getDate() + 2); // 窗口（次日 12:00）之后
    const res = await request(app)
      .post('/api/waste-records')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, qty: 4, recordedAt: late.toISOString() });
    expect(res.body.withinWindow).toBe(false);
    expect(res.body.disposition).toBe('archived');
    const item = await db.pool().query(
      'SELECT waste_qty FROM review_items WHERE review_id=$1 AND sku_id=$2',
      [reviewId, skuBo],
    );
    expect(Number(item.rows[0].waste_qty)).toBe(5); // 未变
  });

  it('盘点对不上 → 以盘点为准留差异记录，差异批次样本剔除出训练', async () => {
    const res = await request(app)
      .post('/api/stocktakes')
      .set(auth(hqToken))
      .send({ storeId: store1, skuId: skuBo, businessDate: arrival, actualQty: 5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.difference)).toBe(5);
    expect(res.body.excluded).toBe(true);
    const s = await db.pool().query(
      'SELECT excluded_from_training, exclude_reason FROM demand_samples WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(s.rows[0].excluded_from_training).toBe(true);
    expect(s.rows[0].exclude_reason).toContain('盘点差异');
    // 以盘点为准：系统库存已修正为实盘数
    const inv = await db.pool().query(
      'SELECT system_qty FROM inventory_snapshots WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [store1, skuBo, arrival],
    );
    expect(Number(inv.rows[0].system_qty)).toBe(5);
  });
});
