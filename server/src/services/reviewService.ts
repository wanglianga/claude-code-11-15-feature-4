import { pool } from '../db';
import { restoreDemand } from '../lib/restore';
import { wasteWindowDeadline } from '../lib/dates';
import { ConflictError, NotFoundError } from './suggestionService';

const OPEN_HOURS = 13;
const WASTE_WINDOW_HOUR = 12; // 报损补录窗口：营业日次日 12:00 前

/**
 * 收市复盘：按订单版本归因实销、报损、缺货损失。
 * 归因基准写死为"观测需求"（restored_demand）——需求还原选定截断观测口径后中途不能换。
 * 金额用下单版本 cost_snapshot 里标定的 Cu/Co：单价比标定错会让历史订单损耗归因整体偏移，
 * 所以快照随版本固化，复盘不取当前参数。
 */
export async function createReview(orderId: number): Promise<{ reviewId: number; idempotent: boolean }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM reviews WHERE order_id=$1', [orderId]);
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { reviewId: existing.rows[0].id, idempotent: true };
    }
    const ores = await client.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = ores.rows[0];
    if (!order) throw new NotFoundError('订单不存在');

    const rres = await client.query(
      `INSERT INTO reviews (order_id, version_id, store_id, arrival_date, baseline)
       VALUES ($1,$2,$3,$4,'restored_demand') RETURNING id`,
      [orderId, order.version_id, order.store_id, order.arrival_date],
    );
    const reviewId: number = rres.rows[0].id;

    const items = await client.query('SELECT * FROM order_items WHERE order_id=$1', [orderId]);
    for (const it of items.rows) {
      await client.query(
        'INSERT INTO review_items (review_id, sku_id, order_qty) VALUES ($1,$2,$3)',
        [reviewId, it.sku_id, it.qty],
      );
    }
    await client.query('COMMIT');
    return { reviewId, idempotent: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 录入某个 SKU 的当日实绩（实销/断货标记/售罄时点/报损）：
 * 1. 用与训练同口径的还原逻辑算出当日观测需求；
 * 2. 归因：缺货损失量 = max(0, 观测需求 - 实销)，报损金额 = 报损量 × Co；
 * 3. 当日样本回流需求还原（source=review_reflow）；若当日盘点有差异 → 剔除出训练样本。
 */
export async function submitReviewEntry(params: {
  reviewId: number;
  skuId: number;
  actualSales: number;
  stockoutFlag: boolean | null;
  selloutTime?: string | null;
  wasteQty?: number;
}): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const rres = await client.query('SELECT * FROM reviews WHERE id=$1', [params.reviewId]);
    const review = rres.rows[0];
    if (!review) throw new NotFoundError('复盘不存在');

    const restored = restoreDemand({
      salesQty: params.actualSales,
      openHours: OPEN_HOURS,
      stockoutFlag: params.stockoutFlag,
      selloutTime: params.selloutTime ?? null,
    });

    // 用下单版本快照的 Cu/Co 归因（口径与标定随版本固化）
    const vres = await client.query('SELECT cost_snapshot FROM suggestion_versions WHERE id=$1', [review.version_id]);
    const skuRes = await client.query(
      'SELECT s.id, s.category_id, c.code AS category_code FROM skus s JOIN categories c ON c.id=s.category_id WHERE s.id=$1',
      [params.skuId],
    );
    const sku = skuRes.rows[0];
    if (!sku) throw new NotFoundError('SKU 不存在');
    const costSnap = vres.rows[0]?.cost_snapshot?.categories?.[sku.category_code];
    const cu = Number(costSnap?.cu ?? 0);
    const co = Number(costSnap?.co ?? 0);

    const wasteQty = params.wasteQty ?? 0;
    const stockoutLossQty = Math.max(0, restored.restoredDemand - params.actualSales);
    const wasteCost = wasteQty * co;
    const stockoutLossAmount = stockoutLossQty * cu;

    // 盘点差异批次：当日该 SKU 有盘点差异 → 样本剔除，避免污染需求还原
    const st = await client.query(
      'SELECT difference FROM stocktakes WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [review.store_id, params.skuId, review.arrival_date],
    );
    const hasDiff = !!(st.rows[0] && Number(st.rows[0].difference) !== 0);

    // 样本回流需求还原（幂等：同一营业日唯一）
    const sres = await client.query(
      `INSERT INTO demand_samples
         (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag, sellout_time,
          in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded,
          excluded_from_training, exclude_reason, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'review_reflow')
       ON CONFLICT (store_id, sku_id, business_date) DO UPDATE SET
         sales_qty=EXCLUDED.sales_qty, stockout_flag=EXCLUDED.stockout_flag, sellout_time=EXCLUDED.sellout_time,
         in_stock_hours=EXCLUDED.in_stock_hours, in_stock_rate=EXCLUDED.in_stock_rate,
         restored_demand=EXCLUDED.restored_demand, is_censored=EXCLUDED.is_censored,
         degraded=EXCLUDED.degraded, excluded_from_training=EXCLUDED.excluded_from_training,
         exclude_reason=EXCLUDED.exclude_reason, source=EXCLUDED.source
       RETURNING id`,
      [
        review.store_id, params.skuId, review.arrival_date, OPEN_HOURS, params.actualSales,
        params.stockoutFlag, params.selloutTime ?? null,
        restored.inStockHours, restored.inStockRate, restored.restoredDemand,
        restored.isCensored, restored.degraded,
        hasDiff, hasDiff ? '盘点差异批次剔除' : null,
      ],
    );
    const sampleId: number = sres.rows[0].id;

    await client.query(
      `UPDATE review_items SET
         actual_sales=$3, waste_qty=$4, restored_demand=$5, stockout_loss_qty=$6,
         waste_cost=$7, stockout_loss_amount=$8, sample_id=$9, sample_excluded=$10
       WHERE review_id=$1 AND sku_id=$2`,
      [
        params.reviewId, params.skuId, params.actualSales, wasteQty,
        restored.restoredDemand, stockoutLossQty, wasteCost, stockoutLossAmount,
        sampleId, hasDiff,
      ],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 报损单（可次日补录）：
 * - 窗口内（营业日次日 12:00 前）→ 触发结转重算：累加复盘报损量并重算报损金额；
 * - 过窗 → 单独存档并说明出处，当日已锁定的建议量与复盘归因保持原样。
 */
export async function addWasteRecord(params: {
  storeId: number;
  skuId: number;
  businessDate: string;
  qty: number;
  recordedAt?: Date;
}): Promise<{ id: number; withinWindow: boolean; disposition: string }> {
  const recordedAt = params.recordedAt ?? new Date();
  const deadline = wasteWindowDeadline(params.businessDate, WASTE_WINDOW_HOUR);
  const withinWindow = recordedAt < deadline;
  const disposition = withinWindow ? 'recalc' : 'archived';
  const note = withinWindow
    ? '窗口内补录，已触发结转重算'
    : `过窗补录（窗口截止 ${params.businessDate} 次日 ${WASTE_WINDOW_HOUR}:00），单独存档；当日已锁定建议量与复盘归因保持原样`;

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO waste_records (store_id, sku_id, business_date, qty, recorded_at, within_window, disposition, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [params.storeId, params.skuId, params.businessDate, params.qty, recordedAt, withinWindow, disposition, note],
    );

    if (withinWindow) {
      // 结转重算：找到该门店该营业日的复盘，累加报损并按版本快照 Co 重算金额
      const rres = await client.query(
        'SELECT * FROM reviews WHERE store_id=$1 AND arrival_date=$2',
        [params.storeId, params.businessDate],
      );
      const review = rres.rows[0];
      if (review) {
        const vres = await client.query('SELECT cost_snapshot FROM suggestion_versions WHERE id=$1', [review.version_id]);
        const skuRes = await client.query(
          'SELECT c.code AS category_code FROM skus s JOIN categories c ON c.id=s.category_id WHERE s.id=$1',
          [params.skuId],
        );
        const co = Number(vres.rows[0]?.cost_snapshot?.categories?.[skuRes.rows[0]?.category_code]?.co ?? 0);
        await client.query(
          `UPDATE review_items
             SET waste_qty = COALESCE(waste_qty, 0) + $3,
                 waste_cost = (COALESCE(waste_qty, 0) + $3) * $4
           WHERE review_id=$1 AND sku_id=$2`,
          [review.id, params.skuId, params.qty, co],
        );
      }
    }
    await client.query('COMMIT');
    return { id: ins.rows[0].id, withinWindow, disposition };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 盘点：库存与盘点对不上以盘点为准（修正系统库存），留差异记录；
 * 差异批次的当日样本从训练样本剔除，否则系统库存会把需求还原污染掉。
 */
export async function addStocktake(params: {
  storeId: number;
  skuId: number;
  businessDate: string;
  actualQty: number;
}): Promise<{ id: number; systemQty: number; difference: number; excluded: boolean }> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const sys = await client.query(
      'SELECT system_qty FROM inventory_snapshots WHERE store_id=$1 AND sku_id=$2 AND business_date=$3',
      [params.storeId, params.skuId, params.businessDate],
    );
    const systemQty = Number(sys.rows[0]?.system_qty ?? 0);
    const difference = params.actualQty - systemQty;

    const ins = await client.query(
      `INSERT INTO stocktakes (store_id, sku_id, business_date, system_qty, actual_qty, difference)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (store_id, sku_id, business_date) DO UPDATE SET
         system_qty=EXCLUDED.system_qty, actual_qty=EXCLUDED.actual_qty, difference=EXCLUDED.difference
       RETURNING id`,
      [params.storeId, params.skuId, params.businessDate, systemQty, params.actualQty, difference],
    );

    // 以盘点为准：修正系统库存快照
    await client.query(
      `INSERT INTO inventory_snapshots (store_id, sku_id, business_date, system_qty)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (store_id, sku_id, business_date) DO UPDATE SET system_qty=EXCLUDED.system_qty`,
      [params.storeId, params.skuId, params.businessDate, params.actualQty],
    );

    // 差异批次从训练样本剔除
    let excluded = false;
    if (difference !== 0) {
      const upd = await client.query(
        `UPDATE demand_samples SET excluded_from_training=TRUE, exclude_reason='盘点差异批次剔除'
         WHERE store_id=$1 AND sku_id=$2 AND business_date=$3`,
        [params.storeId, params.skuId, params.businessDate],
      );
      excluded = (upd.rowCount ?? 0) > 0;
      await client.query(
        `UPDATE review_items ri SET sample_excluded=TRUE
           FROM reviews r
          WHERE ri.review_id=r.id AND r.store_id=$1 AND r.arrival_date=$2 AND ri.sku_id=$3`,
        [params.storeId, params.businessDate, params.skuId],
      );
    }
    await client.query('COMMIT');
    return { id: ins.rows[0].id, systemQty, difference, excluded };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export { ConflictError, NotFoundError };
