import type pg from 'pg';
import { pool } from '../db';
import {
  combinedFactor,
  criticalQuantile,
  empiricalQuantile,
  median,
  roundUpToUnit,
  type FeatureInput,
} from '../lib/forecast';
import { weekdayOf, weekdayLabel } from '../lib/dates';

/** 业务冲突（版本/确认/修订），路由层映射为 409 */
export class ConflictError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  code = 'NOT_FOUND';
}

const SAMPLE_WINDOW_DAYS = 56; // 训练样本窗口：近 8 周
const MIN_SAMPLES = 5;         // 少于该样本量走保守先验
const OPEN_HOURS = 13;

export interface ForecastLine {
  skuId: number;
  quantile: number;
  suggestedQty: number;
  rawQty: number;
  modelNote: string | null;
  featureSnapshot: Record<string, unknown>;
}

type Db = pg.Pool | pg.PoolClient;

async function getCostParams(db: Db, storeId: number, categoryId: number) {
  const over = await db.query(
    'SELECT cu, co FROM cost_params WHERE store_id=$1 AND category_id=$2',
    [storeId, categoryId],
  );
  if (over.rows[0]) {
    return { cu: Number(over.rows[0].cu), co: Number(over.rows[0].co), source: 'store_override' as const };
  }
  const def = await db.query(
    'SELECT default_cu AS cu, default_co AS co FROM categories WHERE id=$1',
    [categoryId],
  );
  return { cu: Number(def.rows[0].cu), co: Number(def.rows[0].co), source: 'category_default' as const };
}

/**
 * 单 SKU 分位预测：
 * 1. 取训练样本：仅"未剔除"的还原需求样本（盘点差异批次已被排除，避免污染）。
 * 2. 优先同星期几子样本；不足则用窗口内全部；再不足（含新品）走品类先验中位（保守）。
 * 3. 断货标记缺失的降级样本只在样本不足时兜底，并标注"降级保守估计"。
 * 4. 建议量 = 经验分位 × 特征因子，向上取整到最小订货单位。
 */
async function forecastSku(
  db: Db,
  storeId: number,
  sku: { id: number; category_id: number; min_order_unit: number; is_new: boolean },
  arrivalDate: string,
  features: FeatureInput,
): Promise<ForecastLine> {
  const cost = await getCostParams(db, storeId, sku.category_id);
  const tau = criticalQuantile(cost.cu, cost.co);

  const res = await db.query(
    `SELECT restored_demand, degraded, EXTRACT(DOW FROM business_date) AS dow
       FROM demand_samples
      WHERE store_id=$1 AND sku_id=$2
        AND business_date < $3::date
        AND business_date >= ($3::date - $4::int)
        AND excluded_from_training = FALSE
      ORDER BY business_date DESC`,
    [storeId, sku.id, arrivalDate, SAMPLE_WINDOW_DAYS],
  );

  const targetDow = weekdayOf(arrivalDate);
  const all = res.rows.map((r) => ({ v: Number(r.restored_demand), degraded: r.degraded as boolean, dow: Number(r.dow) }));
  const sameDow = all.filter((s) => s.dow === targetDow);
  const solid = all.filter((s) => !s.degraded);

  let selected: number[];
  let modelNote: string | null = null;
  let sampleKind: string;

  if (sameDow.filter((s) => !s.degraded).length >= MIN_SAMPLES) {
    selected = sameDow.filter((s) => !s.degraded).map((s) => s.v);
    sampleKind = 'same_weekday';
  } else if (solid.length >= MIN_SAMPLES) {
    selected = solid.map((s) => s.v);
    sampleKind = 'window_all';
  } else if (all.length >= MIN_SAMPLES) {
    // 断货标记缺失的降级样本兜底：页面降级为保守估计
    selected = all.map((s) => s.v);
    sampleKind = 'degraded_fallback';
    modelNote = '断货标记缺失较多，降级为保守估计';
  } else {
    // 新品/历史不足：品类先验中位（保守），不拍脑袋
    const prior = await db.query(
      `SELECT ds.restored_demand
         FROM demand_samples ds JOIN skus s ON s.id = ds.sku_id
        WHERE ds.store_id=$1 AND s.category_id=$2 AND ds.sku_id <> $3
          AND ds.business_date < $4::date
          AND ds.business_date >= ($4::date - $5::int)
          AND ds.excluded_from_training = FALSE AND ds.degraded = FALSE`,
      [storeId, sku.category_id, sku.id, arrivalDate, SAMPLE_WINDOW_DAYS],
    );
    const priorVals = prior.rows.map((r) => Number(r.restored_demand));
    const base = priorVals.length > 0 ? median(priorVals) : 0;
    const { factor, applied } = combinedFactor(features, OPEN_HOURS);
    const raw = base * factor;
    return {
      skuId: sku.id,
      quantile: tau,
      suggestedQty: roundUpToUnit(raw, Number(sku.min_order_unit)),
      rawQty: Number(raw.toFixed(2)),
      modelNote: sku.is_new
        ? '新品无历史，取品类先验中位（保守）'
        : '历史样本不足，取品类先验中位（保守）',
      featureSnapshot: {
        sampleKind: 'category_prior', sampleCount: priorVals.length, base,
        factor, applied, tau, cu: cost.cu, co: cost.co, costSource: cost.source,
        minOrderUnit: Number(sku.min_order_unit),
      },
    };
  }

  const base = empiricalQuantile(selected, tau);
  const { factor, applied } = combinedFactor(features, OPEN_HOURS);
  const raw = base * factor;
  return {
    skuId: sku.id,
    quantile: tau,
    suggestedQty: roundUpToUnit(raw, Number(sku.min_order_unit)),
    rawQty: Number(raw.toFixed(2)),
    modelNote,
    featureSnapshot: {
      sampleKind, sampleCount: selected.length, base: Number(base.toFixed(2)),
      factor, applied, tau, cu: cost.cu, co: cost.co, costSource: cost.source,
      minOrderUnit: Number(sku.min_order_unit),
    },
  };
}

async function costSnapshot(db: Db, storeId: number) {
  const cats = await db.query('SELECT id, code, name FROM categories ORDER BY id');
  const out: Record<string, { cu: number; co: number; tau: number; source: string }> = {};
  for (const c of cats.rows) {
    const cost = await getCostParams(db, storeId, c.id);
    out[c.code] = { cu: cost.cu, co: cost.co, tau: criticalQuantile(cost.cu, cost.co), source: cost.source };
  }
  return out;
}

/**
 * 生成/修订建议表（同一入口）：
 * - 同一（门店, 到货日）只有一张建议表；重复提交按幂等键并表（直接返回已有版本）。
 * - 触发事件（促销取消/降温/配送延误/报损结转）产生新修订版本，旧版本原样保留。
 * - 门店已确认该到货日订单 → 修订落败，409（确认与修订按落库先后裁定）。
 */
export async function generateSuggestion(params: {
  storeId: number;
  arrivalDate: string;
  idempotencyKey: string;
  triggerEvent?: string;
  features?: FeatureInput;
  createdBy: string;
}): Promise<{ versionId: number; versionNo: number; tableId: number; idempotent: boolean }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    // 幂等：同一幂等键重复提交 → 返回已有版本，不重复建版本
    const dup = await client.query(
      'SELECT id, table_id, version_no FROM suggestion_versions WHERE idempotency_key=$1',
      [params.idempotencyKey],
    );
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return { versionId: dup.rows[0].id, versionNo: dup.rows[0].version_no, tableId: dup.rows[0].table_id, idempotent: true };
    }

    await client.query(
      `INSERT INTO suggestion_tables(store_id, arrival_date) VALUES($1, $2)
       ON CONFLICT (store_id, arrival_date) DO NOTHING`,
      [params.storeId, params.arrivalDate],
    );
    const tbl = await client.query(
      'SELECT * FROM suggestion_tables WHERE store_id=$1 AND arrival_date=$2 FOR UPDATE',
      [params.storeId, params.arrivalDate],
    );
    const table = tbl.rows[0];

    // 冲突：门店确认已先落库 → 修订无法生效
    if (table.status === 'confirmed') {
      throw new ConflictError(
        'REVISION_CONFLICT',
        '门店已确认该到货日订单，修订无法生效（确认与修订按落库先后裁定）',
        { tableId: table.id },
      );
    }

    const prev = await client.query(
      'SELECT * FROM suggestion_versions WHERE table_id=$1 ORDER BY version_no DESC LIMIT 1',
      [table.id],
    );
    const prevVersion = prev.rows[0] ?? null;
    const versionNo = prevVersion ? prevVersion.version_no + 1 : 1;

    const skus = await client.query('SELECT * FROM skus ORDER BY id');
    const lines: ForecastLine[] = [];
    for (const sku of skus.rows) {
      lines.push(await forecastSku(client, params.storeId, sku, params.arrivalDate, params.features ?? {}));
    }

    const featureSnapshot = {
      arrivalDate: params.arrivalDate,
      weekday: weekdayLabel(params.arrivalDate),
      features: params.features ?? {},
      baseline: 'restored_demand', // 口径：观测需求（还原后），中途不能换
      sampleWindowDays: SAMPLE_WINDOW_DAYS,
      minSamples: MIN_SAMPLES,
    };
    const costSnap = await costSnapshot(client, params.storeId);

    const ver = await client.query(
      `INSERT INTO suggestion_versions
         (table_id, version_no, revision_of, idempotency_key, trigger_event, feature_snapshot, cost_snapshot, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        table.id, versionNo, prevVersion?.id ?? null, params.idempotencyKey,
        params.triggerEvent ?? 'manual',
        JSON.stringify(featureSnapshot), JSON.stringify({ categories: costSnap, rounding: 'ceil_to_min_order_unit' }),
        params.createdBy,
      ],
    );
    const versionId: number = ver.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO suggestion_items (version_id, sku_id, quantile, suggested_qty, raw_qty, model_note, feature_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [versionId, line.skuId, line.quantile, line.suggestedQty, line.rawQty, line.modelNote, JSON.stringify(line.featureSnapshot)],
      );
    }
    if (prevVersion) {
      await client.query("UPDATE suggestion_versions SET status='superseded' WHERE id=$1", [prevVersion.id]);
    }

    await client.query('COMMIT');
    return { versionId, versionNo, tableId: table.id, idempotent: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 门店确认订单（只改量、记原因码，在指定版本上确认）：
 * - 幂等：同一幂等键重复提交 → 返回已有订单。
 * - 该到货日已确认 → 409（按落库先后，确认已落败/已胜）。
 * - 总部修订已先落库（存在更新版本）→ 409，需基于最新版本重新确认。
 * - 确认后版本锁定，订单版本原样保留，复盘按当时版本归因。
 */
export async function confirmOrder(params: {
  versionId: number;
  idempotencyKey: string;
  confirmedBy: string;
  items: { skuId: number; qty: number; reasonCode?: string }[];
}): Promise<{ orderId: number; idempotent: boolean }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const vres = await client.query('SELECT * FROM suggestion_versions WHERE id=$1', [params.versionId]);
    const version = vres.rows[0];
    if (!version) throw new NotFoundError('建议版本不存在');

    const dup = await client.query('SELECT id FROM orders WHERE idempotency_key=$1', [params.idempotencyKey]);
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return { orderId: dup.rows[0].id, idempotent: true };
    }

    const tbl = await client.query('SELECT * FROM suggestion_tables WHERE id=$1 FOR UPDATE', [version.table_id]);
    const table = tbl.rows[0];

    const existing = await client.query('SELECT id FROM orders WHERE table_id=$1', [table.id]);
    if (existing.rows[0]) {
      throw new ConflictError('ALREADY_CONFIRMED', '该到货日订单已确认（按落库先后裁定）', { orderId: existing.rows[0].id });
    }

    const latest = await client.query(
      'SELECT id, version_no FROM suggestion_versions WHERE table_id=$1 ORDER BY version_no DESC LIMIT 1',
      [table.id],
    );
    if (latest.rows[0].id !== version.id) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        `建议已修订至 v${latest.rows[0].version_no}，请基于最新版本重新确认`,
        { currentVersionId: latest.rows[0].id, currentVersionNo: latest.rows[0].version_no },
      );
    }

    const ores = await client.query(
      `INSERT INTO orders (table_id, version_id, store_id, arrival_date, idempotency_key, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [table.id, version.id, table.store_id, table.arrival_date, params.idempotencyKey, params.confirmedBy],
    );
    const orderId: number = ores.rows[0].id;

    for (const it of params.items) {
      const sug = await client.query(
        'SELECT suggested_qty FROM suggestion_items WHERE version_id=$1 AND sku_id=$2',
        [version.id, it.skuId],
      );
      await client.query(
        'INSERT INTO order_items (order_id, sku_id, qty, reason_code, suggested_qty) VALUES ($1,$2,$3,$4,$5)',
        [orderId, it.skuId, it.qty, it.reasonCode ?? null, sug.rows[0]?.suggested_qty ?? 0],
      );
    }
    await client.query("UPDATE suggestion_versions SET status='locked' WHERE id=$1", [version.id]);
    await client.query("UPDATE suggestion_tables SET status='confirmed' WHERE id=$1", [table.id]);

    await client.query('COMMIT');
    return { orderId, idempotent: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
