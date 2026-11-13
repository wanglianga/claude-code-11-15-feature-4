import { pool } from './db';
import { hashPassword } from './auth';
import { restoreDemand } from './lib/restore';
import { addDays, todayStr } from './lib/dates';
import { generateSuggestion, confirmOrder } from './services/suggestionService';
import { addStocktake, addWasteRecord, createReview, submitReviewEntry } from './services/reviewService';
import {
  confirmTrialOrder,
  createDecision,
  createPlan,
  graduatePlan,
  invalidateReferences,
  saveReferences,
  upsertObservation,
} from './services/trialService';

const OPEN_HOURS = 13;

/** 确定性伪随机（种子固定，演示数据可复现） */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtSellout(inStockHours: number): string {
  const totalMin = 8 * 60 + Math.round(inStockHours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function seedIfEmpty(): Promise<void> {
  const r = await pool().query('SELECT COUNT(*)::int AS n FROM users');
  if (r.rows[0].n > 0) return;
  console.log('[seed] 空库，写入演示数据…');
  const rand = mulberry32(20261113);
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    const stores = await client.query(
      `INSERT INTO stores (code, name, store_type, district) VALUES
         ('BJ01','朝阳门店','社区店','住宅区'),
         ('BJ02','海淀店','商务区','写字楼'),
         ('BJ03','通州店','社区店','高校区')
       RETURNING id, code`,
    );
    const storeId = (code: string) => stores.rows.find((s) => s.code === code)!.id as number;

    const cats = await client.query(
      `INSERT INTO categories (code, name, default_cu, default_co) VALUES
         ('LEAFY','叶菜', 8, 2),   -- 缺货损失含客流损失 → 临界分位 0.8（高分位）
         ('ROOT','根茎', 2, 2)     -- 临界分位 0.5（中位）
       RETURNING id, code`,
    );
    const catId = (code: string) => cats.rows.find((c) => c.code === code)!.id as number;

    // 同品类不同门店允许不同：通州店叶菜 τ=0.75，海淀店根茎 τ=0.6
    await client.query(
      `INSERT INTO cost_params (store_id, category_id, cu, co) VALUES
         ($1,$2,6,2), ($3,$4,3,2)`,
      [storeId('BJ03'), catId('LEAFY'), storeId('BJ02'), catId('ROOT')],
    );

    const skuRows = await client.query(
      `INSERT INTO skus (category_id, code, name, unit, min_order_unit, price, cost, spec, is_new) VALUES
         ($1,'BOC01','菠菜','份',1, 6.5, 2.5, '500g装', FALSE),
         ($1,'SHC02','生菜','份',1, 5.5, 2.0, '500g装', FALSE),
         ($1,'YMC03','油麦菜','份',1, 4.5, 1.8, '500g装', FALSE),
         ($1,'XBC04','小白菜','份',1, 5.0, 2.0, '500g装', TRUE),
         ($2,'TD05','土豆','袋',5, 3.5, 2.0, '1kg袋', FALSE),
         ($2,'HL06','胡萝卜','袋',5, 4.0, 2.2, '1kg袋', FALSE),
         ($2,'BL07','白萝卜','袋',5, 3.0, 1.6, '1kg袋', FALSE),
         ($2,'YC08','洋葱','袋',5, 4.5, 2.5, '1kg袋', FALSE)
       RETURNING id, code, category_id`,
    [catId('LEAFY'), catId('ROOT')]);
    const skuId = (code: string) => skuRows.rows.find((s) => s.code === code)!.id as number;
    const LEAFY = catId('LEAFY');

    // 基础需求（朝阳门店为基准）与门店客流系数
    const baseDemand: Record<string, number> = {
      BOC01: 38, SHC02: 32, YMC03: 28, TD05: 60, HL06: 45, BL07: 40, YC08: 35,
    };
    const traffic: Record<number, number> = { [storeId('BJ01')]: 1.0, [storeId('BJ02')]: 0.85, [storeId('BJ03')]: 0.7 };

    // 历史截断观测样本：近 60 天（朝阳门店留到第三天前，前天样本由复盘回流产生，演示闭环）
    const today = todayStr();
    const yesterday = addDays(today, -1);
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        if (sku.code === 'XBC04') continue; // 新品无历史
        const isLeafy = sku.category_id === LEAFY;
        const lastDay = s.id === storeId('BJ01') ? -3 : -1;
        for (let d = -60; d <= lastDay; d++) {
          const date = addDays(today, d);
          const dow = new Date(`${date}T00:00:00`).getDay();
          const weekly = dow === 0 || dow === 6 ? 1.25 : dow === 1 ? 0.9 : 1.0;
          const noise = 0.85 + rand() * 0.3;
          const trueDemand = baseDemand[sku.code] * traffic[s.id] * weekly * noise;

          const pStockout = isLeafy ? 0.18 : 0.08;
          const roll = rand();
          let salesQty: number, flag: boolean | null, sellout: string | null;
          if (roll < pStockout) {
            // 缺货日：实销被货架截断，有售罄时点
            const supplyRatio = 0.55 + rand() * 0.25;
            salesQty = Math.max(1, Math.round(trueDemand * supplyRatio));
            flag = true;
            sellout = fmtSellout(supplyRatio * OPEN_HOURS);
          } else if (roll < pStockout + 0.06) {
            // 断货标记缺失 → 降级保守估计
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = null;
            sellout = null;
          } else {
            salesQty = Math.max(1, Math.round(trueDemand));
            flag = false;
            sellout = null;
          }

          const restored = restoreDemand({
            salesQty, openHours: OPEN_HOURS, stockoutFlag: flag, selloutTime: sellout,
          });

          // 盘点差异批次（菠菜@朝阳，3 天）：剔除出训练样本
          const isDiffBatch =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && (d === -10 || d === -20 || d === -30);

          await client.query(
            `INSERT INTO demand_samples
               (store_id, sku_id, business_date, open_hours, sales_qty, stockout_flag, sellout_time,
                in_stock_hours, in_stock_rate, restored_demand, is_censored, degraded,
                excluded_from_training, exclude_reason, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'seed')
             ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [
              s.id, sku.id, date, OPEN_HOURS, salesQty, flag, sellout,
              restored.inStockHours, restored.inStockRate, restored.restoredDemand,
              restored.isCensored, restored.degraded,
              isDiffBatch, isDiffBatch ? '盘点差异批次剔除' : null,
            ],
          );
        }
      }
    }

    // 系统库存快照（复盘日/昨天/今天），供盘点对照
    for (const s of stores.rows) {
      for (const sku of skuRows.rows) {
        for (const d of [-3, -2, -1, 0]) {
          const date = addDays(today, d);
          const sysQty =
            s.id === storeId('BJ01') && sku.code === 'BOC01' && d === -2
              ? 12 // 演示：系统 12，盘点 7 → 差异 -5
              : Math.round(rand() * 15);
          await client.query(
            `INSERT INTO inventory_snapshots (store_id, sku_id, business_date, system_qty)
             VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, sku_id, business_date) DO NOTHING`,
            [s.id, sku.id, date, sysQty],
          );
        }
      }
    }

    // 参照商品历史统计：按 店型/商圈/规格/营业时段 的等价有货小时（试销参照目录）
    const refStats: [string, string, string, string, string, number, number][] = [
      // [店型, 商圈, 规格, 参照SKU, 时段, 该时段销量, 等价有货小时]
      ['社区店', '住宅区', '500g装', 'BOC01', 'morning', 13, 4],
      ['社区店', '住宅区', '500g装', 'BOC01', 'midday', 17, 5],
      ['社区店', '住宅区', '500g装', 'BOC01', 'evening', 9, 4],
      ['社区店', '住宅区', '500g装', 'SHC02', 'morning', 11, 4],
      ['社区店', '住宅区', '500g装', 'SHC02', 'midday', 14, 5],
      ['社区店', '住宅区', '500g装', 'SHC02', 'evening', 8, 4],
      ['社区店', '住宅区', '500g装', 'YMC03', 'morning', 9, 4],
      ['社区店', '住宅区', '500g装', 'YMC03', 'midday', 12, 5],
      ['社区店', '住宅区', '500g装', 'YMC03', 'evening', 7, 4],
      ['社区店', '住宅区', '1kg袋', 'TD05', 'morning', 18, 4],
      ['社区店', '住宅区', '1kg袋', 'TD05', 'midday', 24, 5],
      ['社区店', '住宅区', '1kg袋', 'TD05', 'evening', 13, 4],
      ['商务区', '写字楼', '500g装', 'BOC01', 'morning', 9, 4],
      ['商务区', '写字楼', '500g装', 'BOC01', 'midday', 16, 5],
      ['商务区', '写字楼', '500g装', 'BOC01', 'evening', 6, 4],
      ['商务区', '写字楼', '1kg袋', 'TD05', 'morning', 12, 4],
      ['商务区', '写字楼', '1kg袋', 'TD05', 'midday', 21, 5],
      ['商务区', '写字楼', '1kg袋', 'TD05', 'evening', 8, 4],
      ['社区店', '高校区', '500g装', 'YMC03', 'morning', 8, 4],
      ['社区店', '高校区', '500g装', 'YMC03', 'midday', 11, 5],
      ['社区店', '高校区', '500g装', 'YMC03', 'evening', 12, 4],
      ['社区店', '高校区', '1kg袋', 'HL06', 'morning', 9, 4],
      ['社区店', '高校区', '1kg袋', 'HL06', 'midday', 14, 5],
      ['社区店', '高校区', '1kg袋', 'HL06', 'evening', 10, 4],
    ];
    for (const [stype, district, spec, code, period, qty, hours] of refStats) {
      await client.query(
        `INSERT INTO trial_reference_stats
           (store_type, district, spec, ref_sku_id, period, ref_sales_qty, ref_in_stock_hours, sample_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,14)
         ON CONFLICT (store_type, district, spec, ref_sku_id, period) DO NOTHING`,
        [stype, district, spec, skuId(code), period, qty, hours],
      );
    }
    // 用户：总部 + 三门店店长
    const users: [string, string, string, number | null][] = [
      ['hq', 'hq123456', 'hq', null],
      ['store1', 'store123456', 'manager', storeId('BJ01')],
      ['store2', 'store123456', 'manager', storeId('BJ02')],
      ['store3', 'store123456', 'manager', storeId('BJ03')],
    ];
    for (const [username, pw, role, sid] of users) {
      await client.query(
        'INSERT INTO users (username, password_hash, role, store_id) VALUES ($1,$2,$3,$4)',
        [username, hashPassword(pw), role, sid],
      );
    }
    await client.query('COMMIT');
    console.log('[seed] 基础数据完成');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // ===== 演示业务流（走服务层，保证口径一致）=====
  const storeRows = (await pool().query('SELECT id, code FROM stores ORDER BY id')).rows;
  const skuRowsAll = (await pool().query('SELECT id, code FROM skus ORDER BY id')).rows;
  const sidOf = (code: string) => storeRows.find((s) => s.code === code)!.id as number;
  const skuIdOf = (code: string) => skuRowsAll.find((s) => s.code === code)!.id as number;
  const s1 = sidOf('BJ01');
  const today = todayStr();
  const yesterday = addDays(today, -2); // 演示复盘落在前天，避开试销观测占用的昨天
  const tomorrow = addDays(today, 1);

  // 1) 昨天的建议 → 门店确认 → 复盘（朝阳门店，演示完整闭环）
  const gen = await generateSuggestion({
    storeId: s1, arrivalDate: yesterday, idempotencyKey: 'seed-gen-yesterday-s1',
    triggerEvent: 'manual', features: {}, createdBy: 'seed',
  });
  const sugItems = await pool().query(
    'SELECT sku_id, suggested_qty FROM suggestion_items WHERE version_id=$1 ORDER BY sku_id',
    [gen.versionId],
  );
  const confirmItems = sugItems.rows.map((r: { sku_id: number; suggested_qty: string }, i: number) => ({
    skuId: r.sku_id,
    qty: i === 0 ? Number(r.suggested_qty) + 6 : Number(r.suggested_qty), // 菠菜经验加量
    reasonCode: i === 0 ? '经验加量' : undefined,
  }));
  const ord = await confirmOrder({
    versionId: gen.versionId, idempotencyKey: 'seed-order-yesterday-s1',
    confirmedBy: 'store1', items: confirmItems,
  });
  const rev = await createReview(ord.orderId);

  // 2) 复盘录入：覆盖截断/降级/正常三种样本形态
  const qtyOf = (code: string) =>
    Number(sugItems.rows.find((r: { sku_id: number }) => r.sku_id === skuIdOf(code))!.suggested_qty);
  const entries: [string, boolean | null, string | null, number, number][] = [
    // [sku, 断货标记, 售罄时点, 实销, 报损]
    ['BOC01', true, '15:30', qtyOf('BOC01'), 0],           // 售罄 → 截断观测
    ['SHC02', false, null, qtyOf('SHC02') - 4, 2],
    ['YMC03', false, null, qtyOf('YMC03') - 1, 1],
    ['XBC04', null, null, Math.max(0, qtyOf('XBC04') - 2), 2], // 断货标记缺失 → 降级
    ['TD05', false, null, qtyOf('TD05') - 5, 5],
    ['HL06', false, null, qtyOf('HL06'), 0],
    ['BL07', true, '18:00', qtyOf('BL07'), 0],
    ['YC08', false, null, qtyOf('YC08') - 3, 3],
  ];
  for (const [code, flag, sellout, sales, waste] of entries) {
    await submitReviewEntry({
      reviewId: rev.reviewId, skuId: skuIdOf(code), actualSales: sales,
      stockoutFlag: flag, selloutTime: sellout, wasteQty: waste,
    });
  }

  // 3) 报损单：一张窗口内（结转重算），一张过窗（单独存档）
  //    窗口内那张用"营业日当天 + 当天 22:10"的录入时刻，保证落在次日 12:00 窗口内
  const reviewDay = yesterday;
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('SHC02'), businessDate: reviewDay, qty: 3,
    recordedAt: new Date(),
  });
  await addWasteRecord({
    storeId: s1, skuId: skuIdOf('BOC01'), businessDate: addDays(today, -2), qty: 5,
    recordedAt: new Date(`${yesterday}T13:00:00`),
  });

  // 4) 盘点差异：菠菜复盘日系统 12 实盘 7 → 以盘点为准，差异批次样本剔除
  await addStocktake({ storeId: s1, skuId: skuIdOf('BOC01'), businessDate: yesterday, actualQty: 7 });

  // 5) 三家门店明天的建议表（首版）
  for (const s of storeRows) {
    await generateSuggestion({
      storeId: s.id, arrivalDate: tomorrow, idempotencyKey: `seed-gen-tomorrow-s${s.id}`,
      triggerEvent: 'manual', features: {}, createdBy: 'seed',
    });
  }
  // 6) 新店新品试销：朝阳门店小白菜（新品，无历史）
  //    - 首个计划：参照 BOC01 各时段等价有货小时 → 3 天观测 → 加订确认 → 参照失效 → 停止试销
  //      （已确认的订货记录保留，停止后单列待处理）
  //    - 第二个计划：新到货日，仅 2 天观测 + 1 天漏报 → 转正检查不通过（继续观察）
  const xbc = skuIdOf('XBC04');
  const trial1 = await createPlan({
    storeId: s1, skuId: xbc, arrivalDate: addDays(today, -3), createdBy: 'seed',
    references: [
      { period: 'morning', refSkuId: skuIdOf('BOC01') },
      { period: 'midday', refSkuId: skuIdOf('BOC01') },
      { period: 'evening', refSkuId: skuIdOf('BOC01') },
    ],
  });
  const plan1 = trial1.planId;
  await confirmTrialOrder({
    planId: plan1, qty: 40, kind: 'initial', idempotencyKey: 'seed-trial-initial-1', confirmedBy: 'store1',
  });
  const obs1: [number, string, string, number, number][] = [
    // [营业日偏移, 时段, 状态, 实销, 有货时长]
    [-3, 'morning', 'operating', 11, 4],
    [-3, 'midday', 'operating', 12, 5],
    [-3, 'evening', 'operating', 8, 4],
    [-2, 'morning', 'sold_out', 9, 2.5],   // 售罄后时段不按 0 销量
    [-2, 'midday', 'no_stock', 0, 0],
    [-2, 'evening', 'no_stock', 0, 0],
    [-1, 'morning', 'operating', 10, 4],
    [-1, 'midday', 'operating', 13, 5],
    [-1, 'evening', 'closed', 0, 0],       // 停业不计观察时长
  ];
  for (const [d, period, status, sales, hours] of obs1) {
    await upsertObservation({
      planId: plan1, businessDate: addDays(today, d), period, status,
      actualSales: sales, inStockHours: status === 'sold_out' ? hours : undefined,
      selloutHours: status === 'sold_out' ? hours : undefined,
      wasteQty: status === 'operating' ? 1 : 0,
      createdBy: 'store1',
    });
  }
  await createDecision({
    planId: plan1, action: 'observe', note: '先看满一周再判断',
    idempotencyKey: 'seed-trial-observe-1', createdBy: 'hq',
  });
  await createDecision({
    planId: plan1, action: 'add', batchQty: 30, note: '首日团购拉高，观察后仍追加一批',
    idempotencyKey: 'seed-trial-add-1', createdBy: 'hq',
  });
  await confirmTrialOrder({
    planId: plan1, qty: 30, kind: 'add', idempotencyKey: 'seed-trial-add-confirm-1', confirmedBy: 'store1',
    decisionId: (await pool().query("SELECT id FROM trial_decisions WHERE idempotency_key='seed-trial-add-1'")).rows[0].id,
  });
  await invalidateReferences({ planId: plan1, reason: '参照商品改版下架', createdBy: 'hq' });
  await createDecision({
    planId: plan1, action: 'stop', note: '参照失效且缺货占比高，停止试销',
    idempotencyKey: 'seed-trial-stop-1', createdBy: 'hq',
  });

  // 第二个计划：参照 SHC02，2 天有效观测 + 1 天漏报 → 转正检查不通过
  const trial2 = await createPlan({
    storeId: s1, skuId: xbc, arrivalDate: addDays(today, -1), createdBy: 'seed',
    references: [
      { period: 'morning', refSkuId: skuIdOf('SHC02') },
      { period: 'midday', refSkuId: skuIdOf('SHC02') },
      { period: 'evening', refSkuId: skuIdOf('SHC02') },
    ],
  });
  const plan2 = trial2.planId;
  await confirmTrialOrder({
    planId: plan2, qty: 34, kind: 'initial', idempotencyKey: 'seed-trial-initial-2', confirmedBy: 'store1',
  });
  const obs2: [number, string, string, number, number][] = [
    [-1, 'morning', 'operating', 9, 4],
    [-1, 'midday', 'operating', 11, 5],
    [-1, 'evening', 'operating', 8, 4],
    [0, 'morning', 'operating', 10, 4],
    [0, 'midday', 'operating', 12, 5],
    [0, 'evening', 'missing', 0, 0],       // 漏报：当日不完整，不计入连续有效营业日
  ];
  for (const [d, period, status, sales, hours] of obs2) {
    await upsertObservation({
      planId: plan2, businessDate: addDays(today, d), period, status,
      actualSales: sales, inStockHours: status === 'operating' ? hours : undefined,
      createdBy: 'store1',
    });
  }
  // 演示：参照修订（本计划尚未确认加订 → 按新修订重估）
  await saveReferences({
    planId: plan2,
    lines: [
      { period: 'morning', refSkuId: skuIdOf('SHC02'), hours: 3.5 },
      { period: 'midday', refSkuId: skuIdOf('SHC02'), hours: 4.5 },
      { period: 'evening', refSkuId: skuIdOf('SHC02'), hours: 3.5 },
    ],
    idempotencyKey: 'seed-trial-ref-2', createdBy: 'hq',
  });

  // 第三个计划：单品替换款，演示转正通过（5 天有效观测、覆盖率高、损耗低）
  const trial3 = await createPlan({
    storeId: sidOf('BJ03'), skuId: skuIdOf('BOC01'), arrivalDate: addDays(today, -5), createdBy: 'seed',
    references: [
      { period: 'morning', refSkuId: skuIdOf('YMC03') },
      { period: 'midday', refSkuId: skuIdOf('YMC03') },
      { period: 'evening', refSkuId: skuIdOf('YMC03') },
    ],
  });
  const morningVals = [7, 8, 9, 8, 7];
  let dayIdx = 0;
  for (let d = -5; d <= -1; d++, dayIdx++) {
    await upsertObservation({
      planId: trial3.planId, businessDate: addDays(today, d), period: 'morning',
      status: 'operating', actualSales: morningVals[dayIdx], inStockHours: 4, createdBy: 'store3',
    });
    await upsertObservation({
      planId: trial3.planId, businessDate: addDays(today, d), period: 'midday',
      status: 'operating', actualSales: 9, inStockHours: 5, createdBy: 'store3',
    });
    await upsertObservation({
      planId: trial3.planId, businessDate: addDays(today, d), period: 'evening',
      status: 'operating', actualSales: 8, inStockHours: 4, createdBy: 'store3',
    });
  }
  await graduatePlan({ planId: trial3.planId, createdBy: 'seed' });
  console.log('[seed] 演示业务流完成');
}
