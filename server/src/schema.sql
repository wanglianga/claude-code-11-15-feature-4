-- 生鲜订货决策系统数据库结构
-- 四个模块（需求还原/分位预测/门店改量/收市复盘）靠不可变版本串联。

CREATE TABLE IF NOT EXISTS stores (
  id   SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  store_type TEXT NOT NULL DEFAULT '社区店',  -- 店型（参照商品匹配维度）
  district   TEXT NOT NULL DEFAULT '住宅区'   -- 商圈（参照商品匹配维度）
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,   -- LEAFY 叶菜 / ROOT 根茎
  name       TEXT NOT NULL,
  default_cu NUMERIC NOT NULL,       -- 缺货单位损失（毛利 + 客流损失）
  default_co NUMERIC NOT NULL        -- 报损单位成本
);

CREATE TABLE IF NOT EXISTS skus (
  id             SERIAL PRIMARY KEY,
  category_id    INT NOT NULL REFERENCES categories(id),
  code           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT '份',
  min_order_unit NUMERIC NOT NULL DEFAULT 1,  -- 最小订货单位，建议量向上取整到它的整数倍
  price          NUMERIC NOT NULL,   -- 售价
  cost           NUMERIC NOT NULL,   -- 成本（报损单位成本基准）
  spec           TEXT NOT NULL DEFAULT '500g装', -- 规格（参照商品匹配维度）
  is_new         BOOLEAN NOT NULL DEFAULT FALSE  -- 新品无历史，走品类先验
);

ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_type TEXT NOT NULL DEFAULT '社区店';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS district TEXT NOT NULL DEFAULT '住宅区';
ALTER TABLE skus ADD COLUMN IF NOT EXISTS spec TEXT NOT NULL DEFAULT '500g装';

-- 门店×品类成本参数覆盖：同品类不同门店允许不同
CREATE TABLE IF NOT EXISTS cost_params (
  id          SERIAL PRIMARY KEY,
  store_id    INT NOT NULL REFERENCES stores(id),
  category_id INT NOT NULL REFERENCES categories(id),
  cu NUMERIC NOT NULL,
  co NUMERIC NOT NULL,
  UNIQUE(store_id, category_id)
);

-- 需求还原产物：截断观测样本（按门店/SKU/营业日）
CREATE TABLE IF NOT EXISTS demand_samples (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  open_hours    NUMERIC NOT NULL,         -- 当日营业时长（小时）
  sales_qty     NUMERIC NOT NULL,         -- 实销
  stockout_flag BOOLEAN,                  -- 断货标记；NULL = 标记缺失 → 只能降级保守估计
  sellout_time  TEXT,                     -- 售罄时点 'HH:MM'；NULL = 未售罄
  in_stock_hours NUMERIC NOT NULL,        -- 有货时段时长
  in_stock_rate NUMERIC NOT NULL,         -- 有货时段销售速率
  restored_demand NUMERIC NOT NULL,       -- 还原后需求（截断观测点估计）
  is_censored   BOOLEAN NOT NULL,         -- 是否截断观测（售罄/断货）
  degraded      BOOLEAN NOT NULL DEFAULT FALSE,  -- 断货标记缺失 → 降级
  excluded_from_training BOOLEAN NOT NULL DEFAULT FALSE,  -- 盘点差异批次等剔除
  exclude_reason TEXT,
  source        TEXT NOT NULL DEFAULT 'seed',     -- seed / review_reflow（复盘回流）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, business_date)
);

-- 建议表：每个（门店, 到货日）只有一张；重复提交按幂等键并表
CREATE TABLE IF NOT EXISTS suggestion_tables (
  id           SERIAL PRIMARY KEY,
  store_id     INT NOT NULL REFERENCES stores(id),
  arrival_date DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',  -- open / confirmed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, arrival_date)
);

-- 建议版本：不可变。重算只产生新修订版本，不改写旧版本与已确认订单
CREATE TABLE IF NOT EXISTS suggestion_versions (
  id               SERIAL PRIMARY KEY,
  table_id         INT NOT NULL REFERENCES suggestion_tables(id),
  version_no       INT NOT NULL,
  revision_of      INT REFERENCES suggestion_versions(id),
  idempotency_key  TEXT UNIQUE NOT NULL,      -- 幂等键：重复提交并成一张表
  trigger_event    TEXT NOT NULL DEFAULT 'manual',  -- manual/promo_cancelled/temp_drop/delivery_delay/waste_carryover
  feature_snapshot JSONB NOT NULL,   -- 特征快照（事件因子、口径、样本窗口）
  cost_snapshot    JSONB NOT NULL,   -- 标定的 Cu/Co/分位快照（标定错会导致归因整体偏移，故随版本固化）
  status           TEXT NOT NULL DEFAULT 'issued',  -- issued / superseded / locked(已确认)
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(table_id, version_no)
);

CREATE TABLE IF NOT EXISTS suggestion_items (
  id               SERIAL PRIMARY KEY,
  version_id       INT NOT NULL REFERENCES suggestion_versions(id),
  sku_id           INT NOT NULL REFERENCES skus(id),
  quantile         NUMERIC NOT NULL,   -- 临界分位 τ = Cu/(Cu+Co)
  suggested_qty    NUMERIC NOT NULL,   -- 系统建议量（已向上取整到最小订货单位）
  raw_qty          NUMERIC NOT NULL,   -- 取整前
  model_note       TEXT,               -- 新品先验 / 断货标记缺失降级保守 等
  feature_snapshot JSONB NOT NULL,     -- 单品特征快照
  UNIQUE(version_id, sku_id)
);

-- 确认订单：锁定当时版本，原样保留供复盘归因
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  table_id        INT NOT NULL REFERENCES suggestion_tables(id),
  version_id      INT NOT NULL REFERENCES suggestion_versions(id),
  store_id        INT NOT NULL REFERENCES stores(id),
  arrival_date    DATE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  confirmed_by    TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  qty           NUMERIC NOT NULL,   -- 门店确认量（改量后）
  reason_code   TEXT,               -- 改量原因码
  suggested_qty NUMERIC NOT NULL,   -- 当时系统建议量（快照）
  UNIQUE(order_id, sku_id)
);

-- 收市复盘：按订单版本归因；baseline 口径固定为观测需求（restored_demand），中途不换
CREATE TABLE IF NOT EXISTS reviews (
  id           SERIAL PRIMARY KEY,
  order_id     INT UNIQUE NOT NULL REFERENCES orders(id),
  version_id   INT NOT NULL REFERENCES suggestion_versions(id),
  store_id     INT NOT NULL REFERENCES stores(id),
  arrival_date DATE NOT NULL,
  baseline     TEXT NOT NULL DEFAULT 'restored_demand',
  status       TEXT NOT NULL DEFAULT 'open',  -- open / closed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_items (
  id                   SERIAL PRIMARY KEY,
  review_id            INT NOT NULL REFERENCES reviews(id),
  sku_id               INT NOT NULL REFERENCES skus(id),
  order_qty            NUMERIC NOT NULL,
  actual_sales         NUMERIC,          -- 实销
  waste_qty            NUMERIC,          -- 报损
  restored_demand      NUMERIC,          -- 当日还原需求（观测需求口径）
  stockout_loss_qty    NUMERIC,          -- 缺货损失量 = max(0, 观测需求 - 实销)
  waste_cost           NUMERIC,          -- 报损金额 = 报损量 × Co
  stockout_loss_amount NUMERIC,          -- 缺货损失金额 = 缺货量 × Cu
  sample_id            INT REFERENCES demand_samples(id),  -- 回流到需求还原的样本
  sample_excluded      BOOLEAN NOT NULL DEFAULT FALSE,     -- 被剔除（盘点差异批次）
  UNIQUE(review_id, sku_id)
);

-- 盘点：库存与盘点对不上以盘点为准，留差异记录，差异批次从训练样本剔除
CREATE TABLE IF NOT EXISTS stocktakes (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  system_qty    NUMERIC NOT NULL,
  actual_qty    NUMERIC NOT NULL,
  difference    NUMERIC NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, business_date)
);

-- 系统库存快照（对照用）
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  system_qty    NUMERIC NOT NULL,
  UNIQUE(store_id, sku_id, business_date)
);

-- 报损单：可次日补录；窗口内触发结转重算，过窗单独存档并说明出处
CREATE TABLE IF NOT EXISTS waste_records (
  id            SERIAL PRIMARY KEY,
  store_id      INT NOT NULL REFERENCES stores(id),
  sku_id        INT NOT NULL REFERENCES skus(id),
  business_date DATE NOT NULL,
  qty           NUMERIC NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  within_window BOOLEAN NOT NULL,
  disposition   TEXT NOT NULL,   -- recalc 结转重算 / archived 过窗存档
  note          TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,   -- hq / manager
  store_id      INT REFERENCES stores(id)
);

-- 写死的取舍：口径与窗口等系统级参数
CREATE TABLE IF NOT EXISTS system_params (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO system_params(key, value) VALUES
  ('demand_baseline', 'restored_demand'),  -- 复盘归因基准：观测需求（还原后），中途不能换
  ('open_hours', '13'),                    -- 营业时长 08:00-21:00
  ('waste_window_hour', '12'),             -- 报损补录窗口：次日 12:00 前
  ('rounding', 'ceil_to_min_order_unit')   -- 建议量向上取整到最小订货单位
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 新店新品试销：参照设定 / 每日观测（修订号）/ 试销决策 / 确认记录 / 估计版本
-- 三类数据分别保存；参照失效只重估未确认计划，已确认订货记录按当时快照冻结。
-- =====================================================================

-- 参照商品按 店型/商圈/规格/营业时段 的等价有货小时统计（历史参照样本）
CREATE TABLE IF NOT EXISTS trial_reference_stats (
  id                SERIAL PRIMARY KEY,
  store_type        TEXT NOT NULL,
  district          TEXT NOT NULL,
  spec              TEXT NOT NULL,
  ref_sku_id        INT NOT NULL REFERENCES skus(id),
  period            TEXT NOT NULL,           -- morning / midday / evening
  ref_sales_qty     NUMERIC NOT NULL,        -- 参照商品该时段销量
  ref_in_stock_hours NUMERIC NOT NULL,       -- 折算的等价有货小时
  sample_days       INT NOT NULL DEFAULT 14,
  UNIQUE(store_type, district, spec, ref_sku_id, period)
);

CREATE TABLE IF NOT EXISTS trial_plans (
  id                SERIAL PRIMARY KEY,
  store_id          INT NOT NULL REFERENCES stores(id),
  sku_id            INT NOT NULL REFERENCES skus(id),
  arrival_date      DATE NOT NULL,           -- 首批到货营业日
  status            TEXT NOT NULL DEFAULT 'selling',  -- selling / stopped / graduated
  periods           TEXT[] NOT NULL,         -- 参与试销的营业时段
  store_type        TEXT NOT NULL,
  district          TEXT NOT NULL,
  spec              TEXT NOT NULL,
  stopped_at        TIMESTAMPTZ,
  stop_reason       TEXT,
  stopped_estimate_id INT,                   -- 停止时的估计版本（保留当时参照/观测/决定）
  graduated_at      TIMESTAMPTZ,
  graduated_snapshot JSONB,                  -- 转正时冻结的参照、观测、决定、覆盖检查
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, sku_id, arrival_date)
);

-- 参照设定：按版本保存；失效只产生新版本，历史版本只读
CREATE TABLE IF NOT EXISTS trial_reference_sets (
  id                SERIAL PRIMARY KEY,
  plan_id           INT NOT NULL REFERENCES trial_plans(id),
  revision_no       INT NOT NULL,
  invalidated       BOOLEAN NOT NULL DEFAULT FALSE,
  invalidated_reason TEXT,
  idempotency_key   TEXT UNIQUE NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, revision_no)
);

CREATE TABLE IF NOT EXISTS trial_reference_lines (
  id                 SERIAL PRIMARY KEY,
  set_id             INT NOT NULL REFERENCES trial_reference_sets(id),
  period             TEXT NOT NULL,
  ref_sku_id         INT NOT NULL REFERENCES skus(id),
  ref_sales_qty      NUMERIC NOT NULL,
  ref_in_stock_hours NUMERIC NOT NULL,
  UNIQUE(set_id, period)
);

-- 每日观测：修订号管理；is_current 只有一行生效，后补时旧修订撤掉贡献
CREATE TABLE IF NOT EXISTS trial_observations (
  id              SERIAL PRIMARY KEY,
  plan_id         INT NOT NULL REFERENCES trial_plans(id),
  business_date   DATE NOT NULL,
  period          TEXT NOT NULL,
  revision_no     INT NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by   INT,
  status          TEXT NOT NULL,   -- operating / sold_out / no_stock / closed / missing
  actual_sales    NUMERIC NOT NULL DEFAULT 0,
  in_stock_hours  NUMERIC NOT NULL DEFAULT 0,
  waste_qty       NUMERIC NOT NULL DEFAULT 0,
  import_key      TEXT,
  revision_reason TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, business_date, period, revision_no)
);

-- 重复导入幂等：同一当前观测上的 import_key 只能有一行
CREATE UNIQUE INDEX IF NOT EXISTS trial_obs_import_current
  ON trial_observations(plan_id, import_key) WHERE is_current AND import_key IS NOT NULL;

-- 试销决策：加订 / 继续观察 / 停止试销，各自保存，带当时估计快照
CREATE TABLE IF NOT EXISTS trial_decisions (
  id                SERIAL PRIMARY KEY,
  plan_id           INT NOT NULL REFERENCES trial_plans(id),
  action            TEXT NOT NULL,             -- add / observe / stop
  status            TEXT NOT NULL,             -- pending_confirm / confirmed / observed / stopped
  suggested_qty     NUMERIC NOT NULL DEFAULT 0,
  batch_qty         NUMERIC NOT NULL DEFAULT 0,
  basis_estimate_id INT,                      -- 决策依据的估计版本（估计版本表后建，故不加外键）
  note              TEXT,
  idempotency_key   TEXT UNIQUE NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ
);

-- 店长确认的订货记录：永久保留；停止试销后不再并入计划，单列「待处理」
CREATE TABLE IF NOT EXISTS trial_confirmations (
  id                SERIAL PRIMARY KEY,
  plan_id           INT NOT NULL REFERENCES trial_plans(id),
  decision_id       INT REFERENCES trial_decisions(id),
  kind              TEXT NOT NULL,             -- initial / add
  qty               NUMERIC NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending / stopped_pending
  estimate_snapshot JSONB NOT NULL,            -- 确认时的估计快照（冻结，不随参照失效重算）
  idempotency_key   TEXT UNIQUE NOT NULL,
  confirmed_by      TEXT NOT NULL,
  confirmed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 估计版本：参照/观测/成本每次变更产生新版本；确认过的版本冻结
CREATE TABLE IF NOT EXISTS trial_estimates (
  id                SERIAL PRIMARY KEY,
  plan_id           INT NOT NULL REFERENCES trial_plans(id),
  revision_no       INT NOT NULL,
  trigger           TEXT NOT NULL,             -- initial / references / observations / reference_invalidated / decision
  computed          JSONB NOT NULL,
  basis_snapshot    JSONB NOT NULL,            -- 参照集版本、观测修订、成本标定快照
  frozen            BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_by_confirmation_id INT,               -- 冻结该版本的确认记录
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, revision_no)
);
