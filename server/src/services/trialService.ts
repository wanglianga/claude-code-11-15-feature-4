import type pg from 'pg';
import { pool } from '../db';
import { ConflictError, NotFoundError } from './suggestionService';
import {
  computeTrialEstimate,
  evaluateGraduation,
  periodsFor,
  soldOutHours,
  STANDARD_PERIODS,
  type EstimateResult,
  type ObservationStatus,
} from '../lib/trialMath';

const PERIOD_KEYS = new Set(STANDARD_PERIODS.map((p) => p.key));
const OBS_STATUSES: ObservationStatus[] = ['operating', 'sold_out', 'no_stock', 'closed', 'missing'];

export interface TrialPlanRow {
  id: number;
  store_id: number;
  sku_id: number;
  arrival_date: string;
  status: 'selling' | 'stopped' | 'graduated';
  periods: string[];
  store_type: string;
  district: string;
  spec: string;
  stopped_at: string | null;
  stop_reason: string | null;
  stopped_estimate_id: number | null;
  graduated_at: string | null;
  graduated_snapshot: unknown;
  created_by: string;
  created_at: string;
}

function bad(msg: string): never {
  throw new ConflictError('BAD_REQUEST', msg);
}

function normalizePeriods(raw: unknown): string[] {
  if (raw === undefined || raw === null) return STANDARD_PERIODS.map((p) => p.key);
  if (!Array.isArray(raw) || raw.length === 0) bad('periods 必须是非空数组');
  const keys = [...new Set(raw.map((k) => String(k)))];
  for (const k of keys) if (!PERIOD_KEYS.has(k)) bad(`未知营业时段 ${k}`);
  return keys.sort((a, b) => STANDARD_PERIODS.findIndex((p) => p.key === a) - STANDARD_PERIODS.findIndex((p) => p.key === b));
}

/** 依据门店+品类取标定的 Cu/Co（同品类不同门店允许覆盖） */
async function getCost(db: pg.Pool | pg.PoolClient, storeId: number, categoryId: number) {
  const over = await db.query('SELECT cu, co FROM cost_params WHERE store_id=$1 AND category_id=$2', [storeId, categoryId]);
  if (over.rows[0]) {
    return { cu: Number(over.rows[0].cu), co: Number(over.rows[0].co), source: 'store_override' as const };
  }
  const def = await db.query('SELECT default_cu AS cu, default_co AS co FROM categories WHERE id=$1', [categoryId]);
  return { cu: Number(def.rows[0].cu), co: Number(def.rows[0].co), source: 'category_default' as const };
}

async function getPlan(db: pg.Pool | pg.PoolClient, planId: number): Promise<TrialPlanRow> {
  const r = await db.query('SELECT * FROM trial_plans WHERE id=$1', [planId]);
  if (!r.rows[0]) throw new NotFoundError('试销计划不存在');
  return r.rows[0];
}

/** 当前有效参照集：最新修订且未被判失效 */
async function currentReferenceSet(db: pg.Pool | pg.PoolClient, planId: number) {
  const s = await db.query(
    'SELECT * FROM trial_reference_sets WHERE plan_id=$1 ORDER BY revision_no DESC LIMIT 1',
    [planId],
  );
  const set = s.rows[0] ?? null;
  if (!set) return { set: null, lines: [] as {
    period: string; ref_sku_id: number; ref_sales_qty: string; ref_in_stock_hours: string;
  }[] };
  if (set.invalidated) return { set, lines: [] };
  const l = await db.query('SELECT * FROM trial_reference_lines WHERE set_id=$1 ORDER BY period', [set.id]);
  return { set, lines: l.rows };
}

/**
 * 计算计划当前估计所需输入，并调用纯函数库得到权威结果。
 * basisSnapshot 冻结"当时的参照集版本/观测修订/成本标定"，供确认与转正留存。
 */
async function buildEstimate(db: pg.Pool | pg.PoolClient, plan: TrialPlanRow) {
  const sku = (await db.query('SELECT * FROM skus WHERE id=$1', [plan.sku_id])).rows[0];
  const cost = await getCost(db, plan.store_id, sku.category_id);
  const { set, lines } = await currentReferenceSet(db, plan.id);
  const obs = await db.query(
    'SELECT * FROM trial_observations WHERE plan_id=$1 AND is_current ORDER BY business_date, period',
    [plan.id],
  );
  const periods = periodsFor(plan.periods);

  const estimate = computeTrialEstimate({
    periods,
    referenceLines: lines.map((l) => ({
      period: l.period,
      salesQty: Number(l.ref_sales_qty),
      inStockHours: Number(l.ref_in_stock_hours),
    })),
    observations: obs.rows
      .filter((o: { status: string }) => o.status !== 'no_stock')
      .map((o: {
        business_date: string; period: string; status: ObservationStatus;
        actual_sales: string; in_stock_hours: string;
      }) => ({
        businessDate: o.business_date,
        period: o.period,
        status: o.status,
        actualSales: Number(o.actual_sales),
        inStockHours: Number(o.in_stock_hours),
      })),
    cu: cost.cu,
    co: cost.co,
    minOrderUnit: Number(sku.min_order_unit),
  });

  const wasteQty = Number(
    (
      await db.query(
        'SELECT COALESCE(SUM(waste_qty),0) AS q FROM trial_observations WHERE plan_id=$1 AND is_current',
        [plan.id],
      )
    ).rows[0].q,
  );
  const coverage = evaluateGraduation({
    periods,
    observations: obs.rows
      .filter((o: { status: string }) => o.status !== 'no_stock')
      .map((o: {
        business_date: string; period: string; status: ObservationStatus;
        actual_sales: string; in_stock_hours: string;
      }) => ({
        businessDate: o.business_date,
        period: o.period,
        status: o.status,
        actualSales: Number(o.actual_sales),
        inStockHours: Number(o.in_stock_hours),
      })),
    hourlyRate: estimate.withRef.hourlyRate,
    wasteQty,
  });

  const basisSnapshot = {
    referenceSetId: set?.id ?? null,
    referenceRevision: set?.revision_no ?? null,
    referenceInvalidated: !!set?.invalidated,
    referenceLines: lines.map((l) => ({
      period: l.period, refSkuId: l.ref_sku_id,
      refSalesQty: Number(l.ref_sales_qty), refInStockHours: Number(l.ref_in_stock_hours),
    })),
    observationRows: obs.rows.length,
    observationRevisions: obs.rows.map((o: { business_date: string; period: string; revision_no: number }) =>
      `${o.business_date}/${o.period}@r${o.revision_no}`),
    cost: { cu: cost.cu, co: cost.co, source: cost.source },
  };

  return { estimate, coverage, basisSnapshot };
}

type EstimateRow = {
  id: number; plan_id: number; revision_no: number; trigger: string;
  computed: EstimateResult; basis_snapshot: unknown; frozen: boolean;
  frozen_by_confirmation_id: number | null; created_by: string; created_at: string;
};

async function insertEstimate(
  client: pg.PoolClient,
  plan: TrialPlanRow,
  trigger: string,
  built: { estimate: EstimateResult; basisSnapshot: unknown },
  createdBy: string,
): Promise<EstimateRow> {
  const prev = await client.query(
    'SELECT revision_no FROM trial_estimates WHERE plan_id=$1 ORDER BY revision_no DESC LIMIT 1',
    [plan.id],
  );
  const revisionNo = prev.rows[0] ? prev.rows[0].revision_no + 1 : 1;
  const r = await client.query(
    `INSERT INTO trial_estimates (plan_id, revision_no, trigger, computed, basis_snapshot, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [plan.id, revisionNo, trigger, JSON.stringify(built.estimate), JSON.stringify(built.basisSnapshot), createdBy],
  );
  return r.rows[0];
}

async function nextRevision(client: pg.PoolClient, planId: number): Promise<number> {
  const r = await client.query(
    'SELECT COALESCE(MAX(revision_no),0)::int AS n FROM trial_estimates WHERE plan_id=$1',
    [planId],
  );
  return r.rows[0].n + 1;
}

async function recomputeAndStore(
  client: pg.PoolClient,
  plan: TrialPlanRow,
  trigger: string,
  createdBy: string,
): Promise<EstimateRow> {
  const built = await buildEstimate(client, plan);
  return insertEstimate(client, plan, trigger, { estimate: built.estimate, basisSnapshot: built.basisSnapshot }, createdBy);
}

/* ------------------------------------------------------------------ */
/* 参照目录：按 店型/商圈/规格 可选的参照商品及其各时段等价有货小时       */
/* ------------------------------------------------------------------ */

export async function referenceCatalog(storeId: number, spec?: string | null) {
  const store = (await pool().query('SELECT * FROM stores WHERE id=$1', [storeId])).rows[0];
  if (!store) throw new NotFoundError('门店不存在');
  const stats = await pool().query(
    `SELECT trs.*, s.name AS sku_name, s.code AS sku_code, s.category_id, c.name AS category_name
       FROM trial_reference_stats trs
       JOIN skus s ON s.id = trs.ref_sku_id
       JOIN categories c ON c.id = s.category_id
      WHERE trs.store_type=$1 AND trs.district=$2 AND ($3::text IS NULL OR trs.spec=$3)
      ORDER BY trs.spec, trs.ref_sku_id, trs.period`,
    [store.store_type, store.district, spec ?? null],
  );
  return {
    storeType: store.store_type,
    district: store.district,
    specs: [...new Set(stats.rows.map((r: { spec: string }) => r.spec))],
    periods: STANDARD_PERIODS,
    stats: stats.rows,
  };
}

/* ------------------------------------------------------------------ */
/* 计划                                                               */
/* ------------------------------------------------------------------ */

export async function createPlan(params: {
  storeId: number;
  skuId: number;
  arrivalDate: string;
  periods?: unknown;
  references?: { period: string; refSkuId: number; hours?: number }[];
  createdBy: string;
}): Promise<{ planId: number; idempotent: boolean; estimate: EstimateRow | null }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const store = (await client.query('SELECT * FROM stores WHERE id=$1', [params.storeId])).rows[0];
    if (!store) throw new NotFoundError('门店不存在');
    const sku = (await client.query('SELECT * FROM skus WHERE id=$1', [params.skuId])).rows[0];
    if (!sku) throw new NotFoundError('SKU 不存在');
    const periods = normalizePeriods(params.periods);

    const existing = await client.query(
      'SELECT * FROM trial_plans WHERE store_id=$1 AND sku_id=$2 AND arrival_date=$3',
      [params.storeId, params.skuId, params.arrivalDate],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { planId: existing.rows[0].id, idempotent: true, estimate: null };
    }

    const ins = await client.query(
      `INSERT INTO trial_plans
         (store_id, sku_id, arrival_date, periods, store_type, district, spec, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [params.storeId, params.skuId, params.arrivalDate, periods, store.store_type, store.district, sku.spec, params.createdBy],
    );
    const plan = ins.rows[0] as TrialPlanRow;

    if (params.references && params.references.length > 0) {
      await saveReferencesTx(client, plan, {
        lines: params.references.map((r) => ({ period: r.period, refSkuId: r.refSkuId, hours: r.hours })),
        createdBy: params.createdBy,
        idempotencyKey: `plan-${plan.id}-ref-0`,
        trigger: 'initial',
      });
    }

    const estimate = await recomputeAndStore(client, plan, 'initial', params.createdBy);
    await client.query('COMMIT');
    return { planId: plan.id, idempotent: false, estimate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 参照设定：按修订版本保存；失效只重估未确认计划                        */
/* ------------------------------------------------------------------ */

async function saveReferencesTx(
  client: pg.PoolClient,
  plan: TrialPlanRow,
  params: {
    lines: { period: string; refSkuId: number; hours?: number }[];
    createdBy: string;
    idempotencyKey: string;
    trigger: string;
  },
): Promise<{ setId: number; revisionNo: number; idempotent: boolean; estimate: EstimateRow | null }> {
  const dup = await client.query(
    'SELECT * FROM trial_reference_sets WHERE idempotency_key=$1',
    [params.idempotencyKey],
  );
  if (dup.rows[0]) {
    if (dup.rows[0].plan_id !== plan.id) bad('幂等键已被其他计划使用');
    return { setId: dup.rows[0].id, revisionNo: dup.rows[0].revision_no, idempotent: true, estimate: null };
  }
  if (!Array.isArray(params.lines) || params.lines.length === 0) bad('参照明细不能为空');
  const periodKeys = periodsFor(plan.periods).map((p) => p.key);

  const prev = await client.query(
    'SELECT COALESCE(MAX(revision_no),0)::int AS n FROM trial_reference_sets WHERE plan_id=$1',
    [plan.id],
  );
  const revisionNo = prev.rows[0].n + 1;

  const setRes = await client.query(
    `INSERT INTO trial_reference_sets (plan_id, revision_no, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [plan.id, revisionNo, params.idempotencyKey, params.createdBy],
  );
  const setId: number = setRes.rows[0].id;

  for (const line of params.lines) {
    if (!periodKeys.includes(line.period)) bad(`时段 ${line.period} 不在本计划营业时段内`);
    // 先按新品自身规格找参照；找不到时允许跨规格引用（等价小时由页面确认后传入）
    const stats = await client.query(
      `SELECT * FROM trial_reference_stats
        WHERE store_type=$1 AND district=$2 AND ref_sku_id=$3 AND period=$4
        ORDER BY (spec=$5) DESC, id
        LIMIT 1`,
      [plan.store_type, plan.district, line.refSkuId, line.period, plan.spec],
    );
    const stat = stats.rows[0];
    if (!stat) {
      throw new ConflictError('REFERENCE_MISMATCH', `参照商品不匹配本店 店型/商圈/规格/时段（${line.period}）`);
    }
    const hours =
      line.hours === undefined || line.hours === null ? Number(stat.ref_in_stock_hours) : Number(line.hours);
    if (!(hours > 0)) bad('参照等价有货小时必须大于 0');
    await client.query(
      `INSERT INTO trial_reference_lines (set_id, period, ref_sku_id, ref_sales_qty, ref_in_stock_hours)
       VALUES ($1,$2,$3,$4,$5)`,
      [setId, line.period, line.refSkuId, stat.ref_sales_qty, hours],
    );
  }

  if (params.trigger !== 'initial') {
    return { setId, revisionNo, idempotent: false, estimate: null };
  }
  return { setId, revisionNo, idempotent: false, estimate: null };
}

export async function saveReferences(params: {
  planId: number;
  lines: { period: string; refSkuId: number; hours?: number }[];
  idempotencyKey: string;
  createdBy: string;
}): Promise<{ setId: number; revisionNo: number; idempotent: boolean; estimate: EstimateRow | null }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    const result = await saveReferencesTx(client, plan, {
      lines: params.lines,
      createdBy: params.createdBy,
      idempotencyKey: params.idempotencyKey,
      trigger: 'references',
    });
    if (result.idempotent) {
      await client.query('COMMIT');
      return result;
    }
    const estimate = await recomputeAndStore(client, plan, 'references', params.createdBy);
    await client.query('COMMIT');
    return { ...result, estimate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 参照失效：标记当前参照集失效。
 * 只重估未确认计划——已有店长确认记录的计划不再生成新估计，确认快照原样保留。
 */
export async function invalidateReferences(params: {
  planId: number;
  reason: string;
  createdBy: string;
}): Promise<{ estimate: EstimateRow | null; recomputed: boolean; retainedConfirmations: number }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    const { set } = await currentReferenceSet(client, plan.id);
    if (!set) throw new ConflictError('NO_REFERENCE', '当前没有可失效的参照设定');
    if (set.invalidated) throw new ConflictError('ALREADY_INVALIDATED', '当前参照设定已失效');
    await client.query(
      'UPDATE trial_reference_sets SET invalidated=TRUE, invalidated_reason=$2 WHERE id=$1',
      [set.id, params.reason],
    );

    const confs = await client.query('SELECT COUNT(*)::int AS n FROM trial_confirmations WHERE plan_id=$1', [plan.id]);
    const retained = confs.rows[0].n as number;

    let estimate: EstimateRow | null = null;
    let recomputed = false;
    if (retained === 0) {
      estimate = await recomputeAndStore(client, plan, 'reference_invalidated', params.createdBy);
      recomputed = true;
    }
    await client.query('COMMIT');
    return { estimate, recomputed, retainedConfirmations: retained };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 每日观测：修订号管理                                                */
/* ------------------------------------------------------------------ */

export async function upsertObservation(params: {
  planId: number;
  businessDate: string;
  period: string;
  status: string;
  actualSales: number;
  inStockHours?: number | null;
  selloutTime?: string | null;
  wasteQty?: number;
  importKey?: string | null;
  revisionReason?: string | null;
  createdBy: string;
  selloutHours?: number | null;
}): Promise<{
  observationId: number;
  revisionNo: number;
  idempotent: boolean;
  superseded: boolean;
  supersededObservationId: number | null;
  estimate: EstimateRow | null;
}> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    if (plan.status !== 'selling') {
      throw new ConflictError('PLAN_NOT_ACTIVE', '计划已停止或已转正，不再接收每日观测');
    }
    if (!PERIOD_KEYS.has(params.period)) bad(`未知营业时段 ${params.period}`);
    if (!periodsFor(plan.periods).some((p) => p.key === params.period)) {
      bad(`时段 ${params.period} 不在本计划营业时段内`);
    }
    const status = params.status as ObservationStatus;
    if (!OBS_STATUSES.includes(status)) bad(`未知观测状态 ${params.status}`);
    if (!(params.actualSales >= 0)) bad('实销必须为非负数');
    const wasteQty = params.wasteQty ?? 0;
    if (!(wasteQty >= 0)) bad('报损必须为非负数');

    const periodDef = periodsFor(plan.periods).find((p) => p.key === params.period)!;
    let inStockHours: number;
    if (status === 'sold_out') {
      // 售罄时段：按"时段起点→售罄时点"折算有效有货时长，缺失售罄时点直接拒绝
      const so = params.selloutHours ?? (params.selloutTime ? soldOutHours(periodDef, params.selloutTime) : null);
      if (so === null) bad('售罄时段必须补录售罄时点，用于计算有效有货时长');
      inStockHours = so;
    } else if (params.inStockHours !== undefined && params.inStockHours !== null) {
      inStockHours = Number(params.inStockHours);
      if (!(inStockHours >= 0)) bad('有货时长必须为非负数');
      inStockHours = Math.min(inStockHours, periodDef.hours);
    } else if (status === 'operating') {
      inStockHours = periodDef.hours;
    } else {
      inStockHours = 0;
    }

    // 幂等：同一 import_key 且仍是当前观测 → 不重复累加
    if (params.importKey) {
      const dupCur = await client.query(
        'SELECT * FROM trial_observations WHERE plan_id=$1 AND import_key=$2 AND is_current',
        [plan.id, params.importKey],
      );
      if (dupCur.rows[0]) {
        await client.query('COMMIT');
        return {
          observationId: dupCur.rows[0].id, revisionNo: dupCur.rows[0].revision_no,
          idempotent: true, superseded: false, supersededObservationId: null, estimate: null,
        };
      }
      const dupAny = await client.query(
        'SELECT * FROM trial_observations WHERE plan_id=$1 AND import_key=$2',
        [plan.id, params.importKey],
      );
      if (dupAny.rows[0] && !dupAny.rows[0].is_current) {
        throw new ConflictError(
          'STALE_OBSERVATION',
          '该导入键对应的是已被修订取代的旧观测，拒绝重复导入旧数据',
          { observationId: dupAny.rows[0].id, revisionNo: dupAny.rows[0].revision_no },
        );
      }
    }

    const cur = await client.query(
      'SELECT * FROM trial_observations WHERE plan_id=$1 AND business_date=$2 AND period=$3 AND is_current',
      [plan.id, params.businessDate, params.period],
    );
    const current = cur.rows[0] ?? null;

    // 完全相同 → 视为重复导入，不新增修订
    if (
      current &&
      current.status === status &&
      Number(current.actual_sales) === params.actualSales &&
      Number(current.in_stock_hours) === inStockHours &&
      Number(current.waste_qty) === wasteQty
    ) {
      await client.query('COMMIT');
      return {
        observationId: current.id, revisionNo: current.revision_no,
        idempotent: true, superseded: false, supersededObservationId: null, estimate: null,
      };
    }

    const prevRev = await client.query(
      'SELECT COALESCE(MAX(revision_no),0)::int AS n FROM trial_observations WHERE plan_id=$1 AND business_date=$2 AND period=$3',
      [plan.id, params.businessDate, params.period],
    );
    const revisionNo = prevRev.rows[0].n + 1;

    const ins = await client.query(
      `INSERT INTO trial_observations
         (plan_id, business_date, period, revision_no, is_current, status, actual_sales, in_stock_hours,
          waste_qty, import_key, revision_reason, created_by)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        plan.id, params.businessDate, params.period, revisionNo, status,
        params.actualSales, inStockHours, wasteQty, params.importKey ?? null,
        params.revisionReason ?? (current ? '后补修订：撤掉旧观测贡献，按新值计入' : null),
        params.createdBy,
      ],
    );
    const observationId: number = ins.rows[0].id;
    let supersededObservationId: number | null = null;
    if (current) {
      // 旧修订撤掉贡献（is_current=false），估计只累计当前修订
      await client.query(
        'UPDATE trial_observations SET is_current=FALSE, superseded_by=$2 WHERE id=$1',
        [current.id, observationId],
      );
      supersededObservationId = current.id;
    }

    const estimate = await recomputeAndStore(client, plan, 'observations', params.createdBy);
    await client.query('COMMIT');
    return {
      observationId, revisionNo, idempotent: false, superseded: !!current,
      supersededObservationId, estimate,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 观测删除（录入错误）：撤掉贡献并重估，保留删除审计行 */
export async function deleteObservation(params: {
  planId: number;
  observationId: number;
  createdBy: string;
}): Promise<{ estimate: EstimateRow | null }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    const obs = await client.query(
      'SELECT * FROM trial_observations WHERE id=$1 AND plan_id=$2 AND is_current',
      [params.observationId, plan.id],
    );
    if (!obs.rows[0]) throw new NotFoundError('当前观测不存在');
    await client.query(
      "UPDATE trial_observations SET is_current=FALSE, revision_reason=COALESCE(revision_reason,'') || '（删除）' WHERE id=$1",
      [params.observationId],
    );
    const estimate = await recomputeAndStore(client, plan, 'observations', params.createdBy);
    await client.query('COMMIT');
    return { estimate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 决策与确认                                                          */
/* ------------------------------------------------------------------ */

export async function createDecision(params: {
  planId: number;
  action: 'add' | 'observe' | 'stop';
  batchQty?: number;
  note?: string | null;
  idempotencyKey: string;
  createdBy: string;
  estimateId?: number | null;
}): Promise<{ decisionId: number; idempotent: boolean; status: string; estimate: EstimateRow | null }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    if (plan.status === 'graduated') throw new ConflictError('PLAN_GRADUATED', '计划已转正，不能继续试销决策');
    if (plan.status === 'stopped' && params.action !== 'stop') {
      throw new ConflictError('PLAN_STOPPED', '计划已停止试销，不能追加决策', { planStatus: 'stopped' });
    }
    const dup = await client.query('SELECT * FROM trial_decisions WHERE idempotency_key=$1', [params.idempotencyKey]);
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return { decisionId: dup.rows[0].id, idempotent: true, status: dup.rows[0].status, estimate: null };
    }
    if (!['add', 'observe', 'stop'].includes(params.action)) bad('未知决策动作');

    const cur = await client.query(
      'SELECT * FROM trial_estimates WHERE plan_id=$1 ORDER BY revision_no DESC LIMIT 1',
      [plan.id],
    );
    const latest = cur.rows[0] ?? null;
    let basis = latest;
    if (params.estimateId) {
      const b = await client.query('SELECT * FROM trial_estimates WHERE id=$1 AND plan_id=$2', [params.estimateId, plan.id]);
      if (!b.rows[0]) throw new NotFoundError('决策依据的估计版本不存在');
      basis = b.rows[0];
    }
    const basisEstimateId: number | null = basis?.id ?? null;
    const suggested = basis
      ? Number(((basis.computed as EstimateResult | undefined)?.withRef?.suggestedQty) ?? 0)
      : 0;
    let status = 'observed';
    let batchQty = 0;
    if (params.action === 'add') {
      batchQty = params.batchQty ?? 0;
      if (!(batchQty > 0)) bad('加订数量必须大于 0');
      status = 'pending_confirm';
    } else if (params.action === 'stop') {
      status = 'stopped';
    }

    const ins = await client.query(
      `INSERT INTO trial_decisions
         (plan_id, action, status, suggested_qty, batch_qty, basis_estimate_id, note, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [plan.id, params.action, status, suggested, batchQty, basisEstimateId, params.note ?? null, params.idempotencyKey, params.createdBy],
    );
    const decisionId: number = ins.rows[0].id;

    let estimate: EstimateRow | null = null;
    if (params.action === 'stop') {
      // 停止试销与追加确认冲突：拒绝旧计划（未确认的加订决策作废、已确认数量转入待处理）
      await client.query(
        `UPDATE trial_decisions SET status='rejected_stale' WHERE plan_id=$1 AND status='pending_confirm' AND id<>$2`,
        [plan.id, decisionId],
      );
      await client.query(
        `UPDATE trial_confirmations SET status='stopped_pending' WHERE plan_id=$1 AND status='pending'`,
        [plan.id],
      );
      const snap = await buildEstimate(client, plan);
      const nextNo = await nextRevision(client, plan.id);
      // 保留"当时的参照、观测、决定"：停止快照不只放估计数字
      const refsAtStop = await client.query(
        'SELECT * FROM trial_reference_sets WHERE plan_id=$1 ORDER BY revision_no',
        [plan.id],
      );
      const refLinesAtStop = [];
      for (const s of refsAtStop.rows) {
        const lines = await client.query(
          `SELECT l.*, s.name AS sku_name FROM trial_reference_lines l JOIN skus s ON s.id=l.ref_sku_id
            WHERE l.set_id=$1 ORDER BY l.period`,
          [s.id],
        );
        refLinesAtStop.push({ ...s, lines: lines.rows });
      }
      const obsAtStop = await client.query(
        'SELECT * FROM trial_observations WHERE plan_id=$1 ORDER BY business_date, period, revision_no',
        [plan.id],
      );
      const decsAtStop = await client.query(
        'SELECT * FROM trial_decisions WHERE plan_id=$1 ORDER BY created_at, id',
        [plan.id],
      );
      const frozenSnapshot = {
        stoppedAt: new Date().toISOString(),
        reason: params.note ?? null,
        estimate: snap.estimate,
        basis: snap.basisSnapshot,
        coverage: snap.coverage,
        references: refLinesAtStop,
        observations: obsAtStop.rows,
        decisions: decsAtStop.rows,
      };
      const frozen = await client.query(
        `INSERT INTO trial_estimates
           (plan_id, revision_no, trigger, computed, basis_snapshot, frozen, created_by)
         VALUES ($1,$2,'decision',$3,$4,TRUE,$5) RETURNING *`,
        [plan.id, nextNo, JSON.stringify(snap.estimate), JSON.stringify(snap.basisSnapshot), params.createdBy],
      );
      await client.query(
        `UPDATE trial_plans
            SET status='stopped', stopped_at=now(), stop_reason=$2, stopped_estimate_id=$3, graduated_snapshot=$4
          WHERE id=$1`,
        [plan.id, params.note ?? null, frozen.rows[0].id, JSON.stringify(frozenSnapshot)],
      );
      // 决策依据指向冻结版本，页面可回溯"当时参照/观测/估计"
      await client.query('UPDATE trial_decisions SET basis_estimate_id=$2 WHERE id=$1', [decisionId, frozen.rows[0].id]);
      estimate = frozen.rows[0];
    } else {
      estimate = await recomputeAndStore(client, plan, 'decision', params.createdBy);
    }
    await client.query('COMMIT');
    return { decisionId, idempotent: false, status, estimate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 店长确认订货记录（首批 / 追加）：
 * - 只接受最新估计未冻结的情况；确认后冻结该估计版本，快照永久保留；
 * - 计划已停止试销且该加订决策已被拒绝 → 409，并在 details 中列出单列待处理的已确认数量。
 */
export async function confirmTrialOrder(params: {
  planId: number;
  decisionId?: number | null;
  qty: number;
  kind: 'initial' | 'add';
  idempotencyKey: string;
  confirmedBy: string;
}): Promise<{
  confirmationId: number;
  idempotent: boolean;
  qty: number;
  estimateId: number | null;
  pendingConfirmations: { id: number; qty: number; kind: string; status: string }[];
}> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    const dup = await client.query('SELECT * FROM trial_confirmations WHERE idempotency_key=$1', [params.idempotencyKey]);
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return {
        confirmationId: dup.rows[0].id, idempotent: true, qty: Number(dup.rows[0].qty),
        estimateId: null, pendingConfirmations: [],
      };
    }
    if (!(params.qty >= 0)) bad('确认数量必须为非负数');
    if (params.kind === 'add' && !params.decisionId) bad('追加确认必须指定决策');

    const pending = await client.query(
      `SELECT id, qty, kind, status FROM trial_confirmations
        WHERE plan_id=$1 AND status IN ('pending','stopped_pending') ORDER BY confirmed_at`,
      [plan.id],
    );

    // 停止后对旧加订决策确认 → 拒绝旧计划
    if (plan.status !== 'selling') {
      throw new ConflictError(
        plan.status === 'stopped' ? 'PLAN_STOPPED' : 'PLAN_GRADUATED',
        plan.status === 'stopped'
          ? '计划已停止试销，旧加订决策不再接受确认；已确认数量已单列待处理'
          : '计划已转正，结转正式预测，不再接受试销确认',
        { planStatus: plan.status, pendingConfirmations: pending.rows },
      );
    }

    if (params.decisionId) {
      const dec = await client.query('SELECT * FROM trial_decisions WHERE id=$1 AND plan_id=$2', [params.decisionId, plan.id]);
      if (!dec.rows[0]) throw new NotFoundError('决策不存在');
      if (dec.rows[0].action !== 'add') bad('只有加订决策可以追加确认');
      if (dec.rows[0].status !== 'pending_confirm') {
        throw new ConflictError(
          'DECISION_STALE',
          '该加订决策已被停止/作废，不再接受确认',
          { decisionStatus: dec.rows[0].status, pendingConfirmations: pending.rows },
        );
      }
    }

    let estimate: EstimateRow | null = null;
    if (params.decisionId) {
      const dec = await client.query(
        'SELECT basis_estimate_id FROM trial_decisions WHERE id=$1 AND plan_id=$2',
        [params.decisionId, plan.id],
      );
      if (dec.rows[0]?.basis_estimate_id) {
        const b = await client.query('SELECT * FROM trial_estimates WHERE id=$1', [dec.rows[0].basis_estimate_id]);
        estimate = b.rows[0] ?? null;
      }
    }
    if (!estimate) {
      const est = await client.query(
        'SELECT * FROM trial_estimates WHERE plan_id=$1 ORDER BY revision_no DESC LIMIT 1',
        [plan.id],
      );
      estimate = est.rows[0] ?? null;
    }
    const snapshot = {
      planId: plan.id,
      storeId: plan.store_id,
      skuId: plan.sku_id,
      arrivalDate: plan.arrival_date,
      kind: params.kind,
      qty: params.qty,
      estimateRevision: estimate?.revision_no ?? null,
      estimate: estimate?.computed ?? null,
      basis: estimate?.basis_snapshot ?? null,
      coverage: (await buildEstimate(client, plan)).coverage,
      confirmedAt: new Date().toISOString(),
    };

    const ins = await client.query(
      `INSERT INTO trial_confirmations
         (plan_id, decision_id, kind, qty, status, estimate_snapshot, idempotency_key, confirmed_by)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING id`,
      [plan.id, params.decisionId ?? null, params.kind, params.qty, JSON.stringify(snapshot), params.idempotencyKey, params.confirmedBy],
    );
    const confirmationId: number = ins.rows[0].id;

    if (params.decisionId) {
      await client.query("UPDATE trial_decisions SET status='confirmed', confirmed_at=now() WHERE id=$1", [params.decisionId]);
    }
    if (estimate) {
      await client.query(
        'UPDATE trial_estimates SET frozen=TRUE, frozen_by_confirmation_id=$2 WHERE id=$1',
        [estimate.id, confirmationId],
      );
    }
    await client.query('COMMIT');
    return {
      confirmationId, idempotent: false, qty: params.qty, estimateId: estimate?.id ?? null,
      pendingConfirmations: [],
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 已确认数量单列「待处理」：停止后的确认记录 */
export async function pendingHandling(planId: number) {
  const r = await pool().query(
    `SELECT * FROM trial_confirmations WHERE plan_id=$1 AND status='stopped_pending' ORDER BY confirmed_at`,
    [planId],
  );
  return r.rows;
}

/* ------------------------------------------------------------------ */
/* 转正：连续有效营业日覆盖 + 实际损耗检查，冻结当时参照/观测/决定          */
/* ------------------------------------------------------------------ */

export async function checkGraduation(planId: number) {
  const plan = await getPlan(pool(), planId);
  const built = await buildEstimate(pool(), plan);
  return { passed: built.coverage.passed, coverage: built.coverage, estimate: built.estimate };
}

export async function graduatePlan(params: {
  planId: number;
  createdBy: string;
}): Promise<{ graduated: boolean; coverage: ReturnType<typeof evaluateGraduation>; reasons: string[] }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const plan = await getPlan(client, params.planId);
    if (plan.status !== 'selling') throw new ConflictError('PLAN_NOT_ACTIVE', '只有试销中的计划可以转正');
    const built = await buildEstimate(client, plan);
    if (!built.coverage.passed) {
      await client.query('COMMIT');
      return { graduated: false, coverage: built.coverage, reasons: built.coverage.reasons };
    }

    const refs = await client.query(
      'SELECT * FROM trial_reference_sets WHERE plan_id=$1 ORDER BY revision_no',
      [plan.id],
    );
    const refLines = await client.query(
      'SELECT l.*, s.name AS sku_name FROM trial_reference_lines l JOIN skus s ON s.id=l.ref_sku_id WHERE l.set_id=$1 ORDER BY l.period',
      [refs.rows[0]?.id ?? 0],
    );
    const obs = await client.query(
      'SELECT * FROM trial_observations WHERE plan_id=$1 ORDER BY business_date, period, revision_no',
      [plan.id],
    );
    const decs = await client.query('SELECT * FROM trial_decisions WHERE plan_id=$1 ORDER BY created_at', [plan.id]);
    const confs = await client.query('SELECT * FROM trial_confirmations WHERE plan_id=$1 ORDER BY confirmed_at', [plan.id]);

    const snapshot = {
      graduatedAt: new Date().toISOString(),
      coverage: built.coverage,
      estimate: built.estimate,
      basis: built.basisSnapshot,
      references: refs.rows.map((s: { id: number; revision_no: number; invalidated: boolean }) => ({
        ...s,
        lines: s.id === (refs.rows[0]?.id ?? 0) ? refLines.rows : [],
      })),
      observations: obs.rows,
      decisions: decs.rows,
      confirmations: confs.rows,
    };

    await client.query(
      `UPDATE trial_plans SET status='graduated', graduated_at=now(), graduated_snapshot=$2 WHERE id=$1`,
      [plan.id, JSON.stringify(snapshot)],
    );
    await client.query('COMMIT');
    return { graduated: true, coverage: built.coverage, reasons: [] };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 查询                                                               */
/* ------------------------------------------------------------------ */

export async function listPlans(storeId: number) {
  const plans = await pool().query(
    `SELECT tp.*, s.name AS sku_name, s.code AS sku_code, s.unit, s.min_order_unit, s.spec AS sku_spec,
            st.name AS store_name
       FROM trial_plans tp
       JOIN skus s ON s.id = tp.sku_id
       JOIN stores st ON st.id = tp.store_id
      WHERE tp.store_id=$1
      ORDER BY tp.status='selling' DESC, tp.arrival_date DESC, tp.id`,
    [storeId],
  );
  const out = [];
  for (const p of plans.rows) {
    const est = await pool().query(
      'SELECT * FROM trial_estimates WHERE plan_id=$1 ORDER BY revision_no DESC LIMIT 1',
      [p.id],
    );
    const conf = await pool().query(
      `SELECT COALESCE(SUM(qty),0) AS total, COUNT(*)::int AS n FROM trial_confirmations
        WHERE plan_id=$1 AND status='pending'`,
      [p.id],
    );
    const pend = await pool().query(
      "SELECT COUNT(*)::int AS n FROM trial_decisions WHERE plan_id=$1 AND status='pending_confirm'",
      [p.id],
    );
    const pendingHandlingQty = await pool().query(
      "SELECT COALESCE(SUM(qty),0) AS total, COUNT(*)::int AS n FROM trial_confirmations WHERE plan_id=$1 AND status='stopped_pending'",
      [p.id],
    );
    out.push({
      ...p,
      latestEstimate: est.rows[0] ?? null,
      pendingConfirmQty: Number(conf.rows[0].total),
      pendingConfirmCount: conf.rows[0].n,
      pendingAddDecisions: pend.rows[0].n,
      stoppedPendingQty: Number(pendingHandlingQty.rows[0].total),
      stoppedPendingCount: pendingHandlingQty.rows[0].n,
    });
  }
  return out;
}

export async function getPlanDetail(planId: number) {
  const plan = await getPlan(pool(), planId);
  const built = await buildEstimate(pool(), plan);
  const sku = (await pool().query(
    `SELECT s.*, c.name AS category_name, c.code AS category_code FROM skus s JOIN categories c ON c.id=s.category_id WHERE s.id=$1`,
    [plan.sku_id],
  )).rows[0];
  const store = (await pool().query('SELECT * FROM stores WHERE id=$1', [plan.store_id])).rows[0];

  const refSets = await pool().query(
    `SELECT * FROM trial_reference_sets WHERE plan_id=$1 ORDER BY revision_no DESC`,
    [plan.id],
  );
  const refs = [];
  for (const set of refSets.rows) {
    const lines = await pool().query(
      `SELECT l.*, s.name AS sku_name, s.code AS sku_code, s.spec
         FROM trial_reference_lines l JOIN skus s ON s.id=l.ref_sku_id
        WHERE l.set_id=$1 ORDER BY l.period`,
      [set.id],
    );
    refs.push({ ...set, lines: lines.rows });
  }

  const obs = await pool().query(
    'SELECT * FROM trial_observations WHERE plan_id=$1 ORDER BY business_date DESC, period, revision_no DESC',
    [plan.id],
  );
  const estimates = await pool().query(
    'SELECT * FROM trial_estimates WHERE plan_id=$1 ORDER BY revision_no DESC',
    [plan.id],
  );
  const decisions = await pool().query(
    'SELECT * FROM trial_decisions WHERE plan_id=$1 ORDER BY created_at DESC, id DESC',
    [plan.id],
  );
  const confirmations = await pool().query(
    'SELECT * FROM trial_confirmations WHERE plan_id=$1 ORDER BY confirmed_at DESC, id DESC',
    [plan.id],
  );

  return {
    plan: { ...plan, sku_name: sku.name, sku_code: sku.code, unit: sku.unit, min_order_unit: sku.min_order_unit, category_name: sku.category_name, store_name: store.name },
    periods: periodsFor(plan.periods),
    referenceSets: refs,
    // 当前参照集 = 最新修订（即便已失效也返回，页面据此展示"参照已失效"）
    currentReferenceSet: refs[0] ?? null,
    observations: obs.rows,
    estimates: estimates.rows,
    currentEstimate: estimates.rows[0] ?? null,
    decisions: decisions.rows,
    confirmations: confirmations.rows,
    coverage: built.coverage,
    createdAt: plan.created_at,
  };
}

export { soldOutHours };
