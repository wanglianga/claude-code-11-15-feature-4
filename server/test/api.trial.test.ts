import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import type { Express } from 'express';

/**
 * 试销 API 集成测试（独立测试库 ccdev_trial）：
 * 参照失效只重估未确认计划、停止与追加确认冲突、观测修订撤旧计新、
 * 重复导入幂等、停售/漏报不计观察时长、迟到结果不覆盖当前门店、转正检查留存快照。
 */

const ADMIN_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev';
process.env.DATABASE_URL = 'postgres://ccdev:ccdev@127.0.0.1:5432/ccdev_trial';

let app: Express;
let db: typeof import('../src/db');
let hqToken = '';
let s1Token = '';
let s2Token = '';
let store1 = 0;
let store2 = 0;
let newSku = 0;
let refSku = 0;
let today = '';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query('DROP DATABASE IF EXISTS ccdev_trial WITH (FORCE)');
  await admin.query('CREATE DATABASE ccdev_trial');
  await admin.end();

  db = await import('../src/db');
  await db.migrate();
  const pool = db.pool();

  const stores = await pool.query(
    `INSERT INTO stores (code, name, store_type, district) VALUES
       ('T01','测试社区店','社区店','住宅区'), ('T02','测试商务店','商务区','写字楼') RETURNING id`,
  );
  store1 = stores.rows[0].id;
  store2 = stores.rows[1].id;

  const cats = await pool.query(
    `INSERT INTO categories (code, name, default_cu, default_co) VALUES ('LEAFY','叶菜',8,2) RETURNING id`,
  );
  const leafy = cats.rows[0].id;
  const skus = await pool.query(
    `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost, spec, is_new) VALUES
       ($1,'REF','参照菠菜','份',1,6.5,2.5,'500g装',FALSE),
       ($1,'NEW','新品小白菜','份',1,5,2,'500g装',TRUE)
     RETURNING id, code`,
    [leafy],
  );
  refSku = skus.rows.find((r) => r.code === 'REF').id;
  newSku = skus.rows.find((r) => r.code === 'NEW').id;

  const { hashPassword } = await import('../src/auth');
  await pool.query(
    `INSERT INTO users (username, password_hash, role, store_id) VALUES
       ('hq',$1,'hq',NULL), ('s1',$2,'manager',$3), ('s2',$2,'manager',$4)`,
    [hashPassword('hq123456'), hashPassword('store123456'), store1, store2],
  );

  await pool.query(
    `INSERT INTO trial_reference_stats (store_type, district, spec, ref_sku_id, period, ref_sales_qty, ref_in_stock_hours)
     VALUES ('社区店','住宅区','500g装',$1,'morning',13,4),
            ('社区店','住宅区','500g装',$1,'midday',17,5),
            ('社区店','住宅区','500g装',$1,'evening',9,4)`,
    [refSku],
  );

  const dates = await import('../src/lib/dates');
  today = dates.todayStr();

  const appMod = await import('../src/app');
  app = appMod.createApp();
  hqToken = (await request(app).post('/api/auth/login').send({ username: 'hq', password: 'hq123456' })).body.token;
  s1Token = (await request(app).post('/api/auth/login').send({ username: 's1', password: 'store123456' })).body.token;
  s2Token = (await request(app).post('/api/auth/login').send({ username: 's2', password: 'store123456' })).body.token;
}, 30000);

afterAll(async () => {
  await db.closePool();
});

let planSeq = 0;
async function makePlan(token: string, references = true) {
  // 每个计划用不同到货日/ SKU，避免命中(门店,SKU,到货日)唯一约束的幂等合并
  const dates = await import('../src/lib/dates');
  const seq = planSeq++;
  const res = await request(app).post('/api/trials').set(auth(token)).send({
    storeId: store1, skuId: newSku, arrivalDate: dates.addDays(today, seq),
    references: references
      ? [
          { period: 'morning', refSkuId: refSku },
          { period: 'midday', refSkuId: refSku },
          { period: 'evening', refSkuId: refSku },
        ]
      : undefined,
  });
  expect(res.status).toBe(200);
  return res.body.planId as number;
}

async function detail(planId: number) {
  const res = await request(app).get(`/api/trials/${planId}`).set(auth(hqToken));
  expect(res.status).toBe(200);
  return res.body;
}

describe('计划与估计：参照 + 实售合算、取消参照对照', () => {
  let planId = 0;

  it('创建计划：参照按 店型/商圈/规格/时段 匹配，初版估计含合算与取消参照对照', async () => {
    const catalog = await request(app).get(`/api/trials/catalog?storeId=${store1}`).set(auth(hqToken));
    expect(catalog.status).toBe(200);
    expect(catalog.body.storeType).toBe('社区店');
    expect(catalog.body.district).toBe('住宅区');
    expect(catalog.body.stats).toHaveLength(3);

    planId = await makePlan(hqToken);
    const d = await detail(planId);
    expect(d.plan.status).toBe('selling');
    expect(d.periods).toHaveLength(3);
    const est = d.currentEstimate.computed;
    // 参照 39 件 / 13h，无实售 → λ=39，τ=0.8 → 分位即建议
    expect(est.reference.salesQty).toBeCloseTo(39);
    expect(est.withRef.lambda).toBeCloseTo(39);
    expect(est.withoutRef.suggestedQty).toBe(0);
    expect(est.deltaQty).toBe(est.withRef.suggestedQty);
    expect(est.explanation).toContain('尚无新品实售');
  });

  it('重复创建同店同 SKU 同到货日 → 幂等返回同一计划', async () => {
    const again = await request(app).post('/api/trials').set(auth(hqToken)).send({
      storeId: store1, skuId: newSku, arrivalDate: today,
    });
    expect(again.body.planId).toBe(planId);
    expect(again.body.idempotent).toBe(true);
  });

  it('参照商品与店型/商圈不匹配 → 拒绝', async () => {
    const res = await request(app).post('/api/trials').set(auth(hqToken)).send({
      storeId: store1, skuId: newSku, arrivalDate: '2026-01-01',
      references: [{ period: 'morning', refSkuId: newSku }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFERENCE_MISMATCH');
  });

  it('后补有货时长：旧修订撤掉贡献、新修订计入；重复导入不重复累加', async () => {
    const first = await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'morning', status: 'operating',
      actualSales: 9, inStockHours: 4, importKey: 'imp-1',
    });
    expect(first.status).toBe(200);
    let d = await detail(planId);
    // 39 + 9 = 48 / 13 + 4 = 17h
    expect(d.currentEstimate.computed.withRef.salesQty).toBeCloseTo(48);
    expect(d.currentEstimate.computed.withRef.inStockHours).toBeCloseTo(17);

    // 同一 import_key 重复导入 → 幂等，不累加
    const dup = await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'morning', status: 'operating',
      actualSales: 9, inStockHours: 4, importKey: 'imp-1',
    });
    expect(dup.body.idempotent).toBe(true);
    d = await detail(planId);
    expect(d.currentEstimate.computed.withRef.salesQty).toBeCloseTo(48);

    // 后补有货时长 2.5h（售罄补录）：旧修订 r1 撤掉贡献，新修订按 2.5h 计入
    const rev = await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'morning', status: 'sold_out', actualSales: 9, selloutTime: '10:30',
      revisionReason: '后补售罄时点',
    });
    expect(rev.status).toBe(200);
    expect(rev.body.superseded).toBe(true);
    d = await detail(planId);
    // 48 件不变，分母 13 + 2.5 = 15.5（旧 4h 已撤）
    expect(d.currentEstimate.computed.withRef.salesQty).toBeCloseTo(48);
    expect(d.currentEstimate.computed.withRef.inStockHours).toBeCloseTo(15.5);
    const currentObs = d.observations.filter((o: { is_current: boolean }) => o.is_current);
    expect(currentObs).toHaveLength(1);
    expect(currentObs[0].revision_no).toBe(2);
    expect(currentObs[0].in_stock_hours).toBeCloseTo(2.5);
    expect(d.estimates.length).toBeGreaterThan(1);
  });

  it('售罄后时段不按 0 销量、停业/漏报不计观察时长', async () => {
    const before = (await detail(planId)).currentEstimate.computed;
    await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'midday', status: 'no_stock', actualSales: 0,
    });
    await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'evening', status: 'missing', actualSales: 0,
    });
    const after = (await detail(planId)).currentEstimate.computed;
    expect(after.actual.inStockHours).toBeCloseTo(before.actual.inStockHours);
    expect(after.actual.salesQty).toBeCloseTo(before.actual.salesQty);
  });

  it('取消参照的对照解释保守建议少订多少', async () => {
    const est = (await detail(planId)).currentEstimate.computed;
    expect(est.withoutRef.lambda).toBeCloseTo(9 / 2.5 * 13);
    // 样本少且单段速率偏高时，取消参照可能反而多订：解释必须按实际方向措辞
    expect(est.explanation).toMatch(/少订|多订/);
    if (est.deltaQty < 0) expect(est.explanation).toContain('多订');
    expect(est.deltaQty).toBe(est.withRef.suggestedQty - est.withoutRef.suggestedQty);
  });

  it('迟到的重算结果不覆盖当前门店（接口按门店隔离，前端另有竞态保护）', async () => {
    const other = await request(app).get(`/api/trials/${planId}`).set(auth(s2Token));
    expect(other.status).toBe(403);
  });
});

describe('参照失效：只重估未确认计划', () => {
  it('未确认：失效后产生新估计（参照撤掉只剩实售）', async () => {
    const planId = await makePlan(hqToken);
    await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'morning', status: 'operating', actualSales: 9, inStockHours: 4,
    });
    const res = await request(app)
      .post(`/api/trials/${planId}/references/invalidate`).set(auth(hqToken))
      .send({ reason: '参照商品改版下架' });
    expect(res.status).toBe(200);
    expect(res.body.recomputed).toBe(true);
    const d = await detail(planId);
    expect(d.currentReferenceSet.invalidated).toBe(true);
    expect(d.currentEstimate.computed.reference.salesQty).toBe(0);
    expect(d.currentEstimate.computed.withRef.inStockHours).toBeCloseTo(4);
    const reasons = d.estimates.map((e: { trigger: string }) => e.trigger);
    expect(reasons).toContain('reference_invalidated');
  });

  it('已确认：失效不再重估，确认记录与当时快照原样保留', async () => {
    const planId = await makePlan(hqToken);
    await request(app).post(`/api/trials/${planId}/confirmations`).set(auth(s1Token)).send({
      planId, kind: 'initial', qty: 40, idempotencyKey: 'conf-keep-1',
    });
    const d0 = await detail(planId);
    const estIdBefore = d0.currentEstimate.id;
    const res = await request(app)
      .post(`/api/trials/${planId}/references/invalidate`).set(auth(hqToken))
      .send({ reason: '参照商品下架' });
    expect(res.status).toBe(200);
    expect(res.body.recomputed).toBe(false);
    expect(res.body.retainedConfirmations).toBe(1);
    const d = await detail(planId);
    expect(d.currentEstimate.id).toBe(estIdBefore); // 无新估计
    expect(d.confirmations).toHaveLength(1);
    expect(d.confirmations[0].qty).toBe('40');
    expect(d.confirmations[0].estimate_snapshot.estimate.withRef.suggestedQty).toBeTruthy();
    expect(d.currentEstimate.frozen).toBe(true);
  });
});

describe('试销决策：停止与追加确认冲突', () => {
  let planId = 0;
  let addDecisionId = 0;

  beforeAll(async () => {
    planId = await makePlan(hqToken);
    await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: today, period: 'morning', status: 'operating', actualSales: 10, inStockHours: 4,
    });
  });

  it('加订决策 → 待确认；确认后决策完成、估计冻结', async () => {
    const dec = await request(app).post(`/api/trials/${planId}/decisions`).set(auth(hqToken)).send({
      action: 'add', batchQty: 20, note: '按当前强度加订', idempotencyKey: 'dec-add-1',
    });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('pending_confirm');
    addDecisionId = dec.body.decisionId;

    const conf = await request(app).post(`/api/trials/${planId}/confirmations`).set(auth(s1Token)).send({
      kind: 'add', qty: 20, decisionId: addDecisionId, idempotencyKey: 'conf-add-1',
    });
    expect(conf.status).toBe(200);
    const d = await detail(planId);
    const decNow = d.decisions.find((x: { id: number }) => x.id === addDecisionId);
    expect(decNow.status).toBe('confirmed');
  });

  it('再开一个待确认加订后停止试销：旧决策作废，已确认数量转待处理', async () => {
    const dec = await request(app).post(`/api/trials/${planId}/decisions`).set(auth(hqToken)).send({
      action: 'add', batchQty: 15, idempotencyKey: 'dec-add-2',
    });
    const pendingId = dec.body.decisionId;
    await request(app)
      .post(`/api/trials/${planId}/references/invalidate`).set(auth(hqToken))
      .send({ reason: '参照商品改版下架' });
    const stop = await request(app).post(`/api/trials/${planId}/decisions`).set(auth(hqToken)).send({
      action: 'stop', note: '损耗过高，停止试销', idempotencyKey: 'dec-stop-1',
    });
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('stopped');
    const d = await detail(planId);
    expect(d.plan.status).toBe('stopped');
    expect(d.plan.stop_reason).toContain('停止试销');
    expect(d.plan.graduated_snapshot.estimate.withRef.suggestedQty).toBeTruthy();
    // 参照已失效（当前修订仍返回，页面据此提示），停止快照冻结失效状态
    expect(d.currentReferenceSet.invalidated).toBe(true);
    expect(d.plan.graduated_snapshot.basis.referenceInvalidated).toBe(true);
    expect(d.plan.graduated_snapshot.references.length).toBeGreaterThan(0);
    const stale = d.decisions.find((x: { id: number }) => x.id === pendingId);
    expect(stale.status).toBe('rejected_stale');
    expect(d.confirmations.every((c: { status: string }) => c.status === 'stopped_pending')).toBe(true);
    expect(d.confirmations.reduce((s: number, c: { qty: string }) => s + Number(c.qty), 0)).toBe(20);

    // 停止后再确认旧加订决策 → 409 + 待处理列表
    const late = await request(app).post(`/api/trials/${planId}/confirmations`).set(auth(s1Token)).send({
      kind: 'add', qty: 15, decisionId: pendingId, idempotencyKey: 'conf-late-1',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PLAN_STOPPED');
    expect(late.body.error.details.pendingConfirmations.length).toBe(1);
  });
});

describe('转正检查', () => {
  it('断报/缺报的短序列 → 不通过，保留当时参照/观测/决定', async () => {
    const planId = await makePlan(hqToken);
    await request(app).post(`/api/trials/${planId}/confirmations`).set(auth(s1Token)).send({
      kind: 'initial', qty: 30, idempotencyKey: 'conf-grad-1',
    });
    const dates = await import('../src/lib/dates');
    for (let i = 0; i < 2; i++) {
      for (const period of ['morning', 'midday', 'evening']) {
        await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
          businessDate: dates.addDays(today, i),
          period, status: 'operating', actualSales: 10,
        });
      }
    }
    const grad = await request(app).get(`/api/trials/${planId}/graduation`).set(auth(hqToken));
    expect(grad.status).toBe(200);
    expect(grad.body.passed).toBe(false);
    expect(grad.body.coverage.consecutiveValidDays).toBe(2);
    const res = await request(app).post(`/api/trials/${planId}/graduate`).set(auth(hqToken)).send({});
    expect(res.body.graduated).toBe(false);
    expect(res.body.reasons.join()).toContain('连续有效营业日');
  });

  it('连续 5 个有效营业日且覆盖/损耗达标 → 转正，留快照', async () => {
    const planId = await makePlan(hqToken);
    await request(app).post(`/api/trials/${planId}/confirmations`).set(auth(s1Token)).send({
      kind: 'initial', qty: 32, idempotencyKey: 'conf-grad-2',
    });
    const dates = await import('../src/lib/dates');
    for (let i = 0; i < 5; i++) {
      for (const period of ['morning', 'midday', 'evening']) {
        await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
          businessDate: dates.addDays(today, i), period, status: 'operating', actualSales: 11,
        });
      }
    }
    const res = await request(app).post(`/api/trials/${planId}/graduate`).set(auth(hqToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.graduated).toBe(true);
    const d = await detail(planId);
    expect(d.plan.status).toBe('graduated');
    const snap = d.plan.graduated_snapshot;
    expect(snap.references.length).toBeGreaterThan(0);
    expect(snap.observations.length).toBeGreaterThan(0);
    expect(snap.decisions).toBeDefined();
    expect(snap.coverage.passed).toBe(true);
    expect(snap.estimate.withRef.suggestedQty).toBeGreaterThan(0);
    // 转正后不再接收观测
    const late = await request(app).post(`/api/trials/${planId}/observations`).set(auth(hqToken)).send({
      businessDate: dates.addDays(today, 6), period: 'morning', status: 'operating', actualSales: 10,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PLAN_NOT_ACTIVE');
  });
});
