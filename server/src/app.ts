import express, { type NextFunction, type Request, type Response } from 'express';
import { pool } from './db';
import { requireAuth, requireRole, scopeStoreId, signToken, verifyPassword } from './auth';
import { confirmOrder, generateSuggestion, ConflictError, NotFoundError } from './services/suggestionService';
import { addStocktake, addWasteRecord, createReview, submitReviewEntry } from './services/reviewService';
import {
  checkGraduation,
  confirmTrialOrder,
  createDecision,
  createPlan,
  deleteObservation,
  graduatePlan,
  getPlanDetail,
  invalidateReferences,
  listPlans,
  referenceCatalog,
  saveReferences,
  upsertObservation,
} from './services/trialService';

function num(v: unknown, name: string): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || Number.isNaN(n)) {
    throw new ConflictError('BAD_REQUEST', `参数 ${name} 缺失或非法`);
  }
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConflictError('BAD_REQUEST', `参数 ${name} 缺失或非法`);
  }
  return v.trim();
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 门店账号强制本店范围；总部可任意门店 */
function resolveStore(req: Request, storeIdRaw: unknown): number {
  const storeId = num(storeIdRaw, 'storeId');
  const scoped = scopeStoreId(req, storeId);
  if (scoped === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
  return scoped;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const username = str(req.body?.username, 'username');
      const password = str(req.body?.password, 'password');
      const r = await pool().query('SELECT * FROM users WHERE username=$1', [username]);
      const u = r.rows[0];
      if (!u || !verifyPassword(password, u.password_hash)) {
        res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
        return;
      }
      res.json({
        token: signToken(u.id),
        user: { id: u.id, username: u.username, role: u.role, storeId: u.store_id },
      });
    } catch (e) { next(e); }
  });

  app.use('/api', requireAuth);

  // ---------- 基础数据 ----------
  app.get('/api/meta', async (_req, res, next) => {
    try {
      const [stores, categories, skus, costParams, params] = await Promise.all([
        pool().query('SELECT id, code, name, store_type, district FROM stores ORDER BY id'),
        pool().query('SELECT id, code, name, default_cu, default_co FROM categories ORDER BY id'),
        pool().query('SELECT id, category_id, code, name, unit, min_order_unit, price, cost, spec, is_new FROM skus ORDER BY id'),
        pool().query('SELECT store_id, category_id, cu, co FROM cost_params ORDER BY id'),
        pool().query('SELECT key, value FROM system_params'),
      ]);
      res.json({
        stores: stores.rows, categories: categories.rows, skus: skus.rows,
        costParams: costParams.rows,
        params: Object.fromEntries(params.rows.map((r) => [r.key, r.value])),
      });
    } catch (e) { next(e); }
  });

  // ---------- 需求还原样本 ----------
  app.get('/api/samples', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const categoryId = req.query.categoryId ? num(req.query.categoryId, 'categoryId') : null;
      const dateFrom = optStr(req.query.dateFrom) ?? '1900-01-01';
      const dateTo = optStr(req.query.dateTo) ?? '2999-12-31';
      const r = await pool().query(
        `SELECT ds.*, s.code AS sku_code, s.name AS sku_name, s.category_id, c.code AS category_code, c.name AS category_name
           FROM demand_samples ds
           JOIN skus s ON s.id = ds.sku_id
           JOIN categories c ON c.id = s.category_id
          WHERE ds.store_id=$1 AND ds.business_date BETWEEN $2 AND $3
            AND ($4::int IS NULL OR s.category_id=$4)
          ORDER BY ds.business_date DESC, s.id`,
        [storeId, dateFrom, dateTo, categoryId],
      );
      res.json({ samples: r.rows });
    } catch (e) { next(e); }
  });

  // ---------- 建议表 / 版本 ----------
  app.get('/api/suggestions', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = str(req.query.arrivalDate, 'arrivalDate');
      const tbl = await pool().query(
        'SELECT * FROM suggestion_tables WHERE store_id=$1 AND arrival_date=$2',
        [storeId, arrivalDate],
      );
      const table = tbl.rows[0];
      if (!table) {
        res.json({ table: null, versions: [], currentVersion: null, items: [], order: null });
        return;
      }
      const versions = await pool().query(
        'SELECT id, table_id, version_no, revision_of, trigger_event, status, created_by, created_at, feature_snapshot, cost_snapshot FROM suggestion_versions WHERE table_id=$1 ORDER BY version_no DESC',
        [table.id],
      );
      const current = versions.rows[0];
      const items = current
        ? await pool().query(
            `SELECT si.*, s.code AS sku_code, s.name AS sku_name, s.unit, s.min_order_unit, s.is_new,
                    c.id AS category_id, c.code AS category_code, c.name AS category_name
               FROM suggestion_items si
               JOIN skus s ON s.id = si.sku_id
               JOIN categories c ON c.id = s.category_id
              WHERE si.version_id=$1 ORDER BY si.sku_id`,
            [current.id],
          )
        : { rows: [] };
      const orderRes = await pool().query('SELECT * FROM orders WHERE table_id=$1', [table.id]);
      const order = orderRes.rows[0] ?? null;
      let orderItems: unknown[] = [];
      if (order) {
        const oi = await pool().query(
          `SELECT oi.*, s.name AS sku_name, s.code AS sku_code FROM order_items oi JOIN skus s ON s.id=oi.sku_id WHERE oi.order_id=$1 ORDER BY oi.sku_id`,
          [order.id],
        );
        orderItems = oi.rows;
      }
      res.json({ table, versions: versions.rows, currentVersion: current ?? null, items: items.rows, order, orderItems });
    } catch (e) { next(e); }
  });

  // 生成 / 修订（同一入口；事件触发重算产生新修订版本；幂等键并表）
  app.post('/api/suggestions/generate', requireRole('hq'), async (req, res, next) => {
    try {
      const result = await generateSuggestion({
        storeId: num(req.body?.storeId, 'storeId'),
        arrivalDate: str(req.body?.arrivalDate, 'arrivalDate'),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        triggerEvent: optStr(req.body?.triggerEvent) ?? 'manual',
        features: req.body?.features ?? {},
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/suggestions/versions/:id', async (req, res, next) => {
    try {
      const v = await pool().query('SELECT * FROM suggestion_versions WHERE id=$1', [num(req.params.id, 'id')]);
      if (!v.rows[0]) throw new NotFoundError('版本不存在');
      const items = await pool().query(
        `SELECT si.*, s.code AS sku_code, s.name AS sku_name, c.code AS category_code, c.name AS category_name
           FROM suggestion_items si JOIN skus s ON s.id=si.sku_id JOIN categories c ON c.id=s.category_id
          WHERE si.version_id=$1 ORDER BY si.sku_id`,
        [v.rows[0].id],
      );
      res.json({ version: v.rows[0], items: items.rows });
    } catch (e) { next(e); }
  });

  // ---------- 门店确认 ----------
  app.post('/api/versions/:id/confirm', requireRole('manager'), async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) throw new ConflictError('BAD_REQUEST', '确认明细不能为空');
      const result = await confirmOrder({
        versionId: num(req.params.id, 'id'),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        confirmedBy: req.user!.username,
        items: items.map((it: Record<string, unknown>) => ({
          skuId: num(it.skuId, 'items.skuId'),
          qty: num(it.qty, 'items.qty'),
          reasonCode: optStr(it.reasonCode) ?? undefined,
        })),
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // ---------- 订单 / 复盘 ----------
  app.get('/api/orders', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = optStr(req.query.arrivalDate);
      const r = await pool().query(
        `SELECT o.*, v.version_no FROM orders o JOIN suggestion_versions v ON v.id=o.version_id
          WHERE o.store_id=$1 AND ($2::date IS NULL OR o.arrival_date=$2) ORDER BY o.arrival_date DESC`,
        [storeId, arrivalDate],
      );
      res.json({ orders: r.rows });
    } catch (e) { next(e); }
  });

  app.post('/api/orders/:id/review', async (req, res, next) => {
    try {
      const result = await createReview(num(req.params.id, 'id'));
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/reviews', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const arrivalDate = optStr(req.query.arrivalDate);
      const r = await pool().query(
        `SELECT r.*, v.version_no FROM reviews r JOIN suggestion_versions v ON v.id=r.version_id
          WHERE r.store_id=$1 AND ($2::date IS NULL OR r.arrival_date=$2) ORDER BY r.arrival_date DESC`,
        [storeId, arrivalDate],
      );
      const reviews = [];
      for (const review of r.rows) {
        const items = await pool().query(
          `SELECT ri.*, s.code AS sku_code, s.name AS sku_name, s.unit, c.name AS category_name, c.code AS category_code
             FROM review_items ri JOIN skus s ON s.id=ri.sku_id JOIN categories c ON c.id=s.category_id
            WHERE ri.review_id=$1 ORDER BY ri.sku_id`,
          [review.id],
        );
        reviews.push({ ...review, items: items.rows });
      }
      res.json({ reviews });
    } catch (e) { next(e); }
  });

  app.post('/api/reviews/:id/entry', async (req, res, next) => {
    try {
      await submitReviewEntry({
        reviewId: num(req.params.id, 'id'),
        skuId: num(req.body?.skuId, 'skuId'),
        actualSales: num(req.body?.actualSales, 'actualSales'),
        stockoutFlag: req.body?.stockoutFlag === null || req.body?.stockoutFlag === undefined
          ? null : Boolean(req.body.stockoutFlag),
        selloutTime: optStr(req.body?.selloutTime),
        wasteQty: req.body?.wasteQty === undefined || req.body?.wasteQty === null ? 0 : num(req.body.wasteQty, 'wasteQty'),
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- 报损单 / 盘点 ----------
  app.post('/api/waste-records', async (req, res, next) => {
    try {
      const result = await addWasteRecord({
        storeId: resolveStore(req, req.body?.storeId),
        skuId: num(req.body?.skuId, 'skuId'),
        businessDate: str(req.body?.businessDate, 'businessDate'),
        qty: num(req.body?.qty, 'qty'),
        recordedAt: req.body?.recordedAt ? new Date(req.body.recordedAt) : undefined,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/waste-records', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const businessDate = optStr(req.query.businessDate);
      const r = await pool().query(
        `SELECT w.*, s.name AS sku_name, s.code AS sku_code FROM waste_records w JOIN skus s ON s.id=w.sku_id
          WHERE w.store_id=$1 AND ($2::date IS NULL OR w.business_date=$2) ORDER BY w.recorded_at DESC`,
        [storeId, businessDate],
      );
      res.json({ records: r.rows });
    } catch (e) { next(e); }
  });

  app.post('/api/stocktakes', async (req, res, next) => {
    try {
      const result = await addStocktake({
        storeId: resolveStore(req, req.body?.storeId),
        skuId: num(req.body?.skuId, 'skuId'),
        businessDate: str(req.body?.businessDate, 'businessDate'),
        actualQty: num(req.body?.actualQty, 'actualQty'),
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/stocktakes', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const businessDate = optStr(req.query.businessDate);
      const r = await pool().query(
        `SELECT st.*, s.name AS sku_name, s.code AS sku_code FROM stocktakes st JOIN skus s ON s.id=st.sku_id
          WHERE st.store_id=$1 AND ($2::date IS NULL OR st.business_date=$2) ORDER BY st.created_at DESC`,
        [storeId, businessDate],
      );
      res.json({ stocktakes: r.rows });
    } catch (e) { next(e); }
  });

  // ---------- 新店新品试销 ----------
  // 参照商品目录：按 店型/商圈/规格 给出各营业时段等价有货小时
  app.get('/api/trials/catalog', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      const out = await referenceCatalog(storeId, optStr(req.query.spec));
      res.json(out);
    } catch (e) { next(e); }
  });

  app.get('/api/trials', async (req, res, next) => {
    try {
      const storeId = resolveStore(req, req.query.storeId);
      res.json({ plans: await listPlans(storeId) });
    } catch (e) { next(e); }
  });

  app.post('/api/trials', async (req, res, next) => {
    try {
      const result = await createPlan({
        storeId: resolveStore(req, req.body?.storeId),
        skuId: num(req.body?.skuId, 'skuId'),
        arrivalDate: str(req.body?.arrivalDate, 'arrivalDate'),
        periods: req.body?.periods,
        references: Array.isArray(req.body?.references)
          ? req.body.references.map((r: Record<string, unknown>) => ({
              period: str(r.period, 'references.period'),
              refSkuId: num(r.refSkuId, 'references.refSkuId'),
              hours: r.hours === undefined || r.hours === null ? undefined : num(r.hours, 'references.hours'),
            }))
          : undefined,
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/trials/:id', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const detail = await getPlanDetail(planId);
      const scoped = scopeStoreId(req, detail.plan.store_id);
      if (scoped === null) throw new ConflictError('FORBIDDEN', '门店账号只能查看本店数据');
      res.json(detail);
    } catch (e) { next(e); }
  });

  // 参照设定（按版本保存）
  app.post('/api/trials/:id/references', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      if (lines.length === 0) throw new ConflictError('BAD_REQUEST', '参照明细不能为空');
      const result = await saveReferences({
        planId,
        lines: lines.map((l: Record<string, unknown>) => ({
          period: str(l.period, 'lines.period'),
          refSkuId: num(l.refSkuId, 'lines.refSkuId'),
          hours: l.hours === undefined || l.hours === null ? undefined : num(l.hours, 'lines.hours'),
        })),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // 参照失效：只重估未确认计划，已确认订货记录保留
  app.post('/api/trials/:id/references/invalidate', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const result = await invalidateReferences({
        planId,
        reason: str(req.body?.reason, 'reason'),
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // 每日观测（修订号管理；importKey 幂等；重复导入不重复累加）
  app.post('/api/trials/:id/observations', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const result = await upsertObservation({
        planId,
        businessDate: str(req.body?.businessDate, 'businessDate'),
        period: str(req.body?.period, 'period'),
        status: str(req.body?.status, 'status'),
        actualSales: req.body?.actualSales === undefined ? 0 : num(req.body.actualSales, 'actualSales'),
        inStockHours: req.body?.inStockHours === undefined || req.body?.inStockHours === null
          ? null : num(req.body.inStockHours, 'inStockHours'),
        selloutTime: optStr(req.body?.selloutTime),
        wasteQty: req.body?.wasteQty === undefined || req.body?.wasteQty === null ? 0 : num(req.body.wasteQty, 'wasteQty'),
        importKey: optStr(req.body?.importKey),
        revisionReason: optStr(req.body?.revisionReason),
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.delete('/api/trials/:id/observations/:obsId', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const result = await deleteObservation({
        planId, observationId: num(req.params.obsId, 'obsId'), createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // 试销决策：add 加订 / observe 继续观察 / stop 停止试销
  app.post('/api/trials/:id/decisions', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const action = str(req.body?.action, 'action');
      if (!['add', 'observe', 'stop'].includes(action)) throw new ConflictError('BAD_REQUEST', '未知决策动作');
      const result = await createDecision({
        planId,
        action: action as 'add' | 'observe' | 'stop',
        batchQty: req.body?.batchQty === undefined || req.body?.batchQty === null
          ? undefined : num(req.body.batchQty, 'batchQty'),
        note: optStr(req.body?.note),
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        estimateId: req.body?.estimateId === undefined || req.body?.estimateId === null
          ? undefined : num(req.body.estimateId, 'estimateId'),
        createdBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // 店长确认订货记录（首批 / 追加）；停止后确认旧决策 → 409 + 待处理列表
  app.post('/api/trials/:id/confirmations', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const kind = str(req.body?.kind, 'kind');
      if (kind !== 'initial' && kind !== 'add') throw new ConflictError('BAD_REQUEST', 'kind 只能是 initial / add');
      const result = await confirmTrialOrder({
        planId,
        decisionId: req.body?.decisionId === undefined || req.body?.decisionId === null
          ? undefined : num(req.body.decisionId, 'decisionId'),
        qty: num(req.body?.qty, 'qty'),
        kind,
        idempotencyKey: str(req.body?.idempotencyKey, 'idempotencyKey'),
        confirmedBy: req.user!.username,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // 转正检查 / 转正
  app.get('/api/trials/:id/graduation', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能查看本店数据');
      res.json(await checkGraduation(planId));
    } catch (e) { next(e); }
  });

  app.post('/api/trials/:id/graduate', async (req, res, next) => {
    try {
      const planId = num(req.params.id, 'id');
      const check = await getPlanDetail(planId);
      if (scopeStoreId(req, check.plan.store_id) === null) throw new ConflictError('FORBIDDEN', '门店账号只能操作本店数据');
      const result = await graduatePlan({ planId, createdBy: req.user!.username });
      res.json(result);
    } catch (e) { next(e); }
  });

  // ---------- 统一错误处理 ----------
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConflictError) {
      const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'FORBIDDEN' ? 403 : 409;
      res.status(status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return app;
}
