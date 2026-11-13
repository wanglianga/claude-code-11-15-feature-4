export interface User {
  id: number;
  username: string;
  role: 'hq' | 'manager';
  storeId: number | null;
}

export interface Store { id: number; code: string; name: string; store_type?: string; district?: string }
export interface Category { id: number; code: string; name: string; default_cu: string; default_co: string }
export interface Sku {
  id: number; category_id: number; code: string; name: string; unit: string;
  min_order_unit: string; price: string; cost: string; spec?: string; is_new: boolean;
}
export interface Meta {
  stores: Store[];
  categories: Category[];
  skus: Sku[];
  costParams: { store_id: number; category_id: number; cu: string; co: string }[];
  params: Record<string, string>;
}

export interface DemandSample {
  id: number; store_id: number; sku_id: number; business_date: string;
  open_hours: string; sales_qty: string; stockout_flag: boolean | null; sellout_time: string | null;
  in_stock_hours: string; in_stock_rate: string; restored_demand: string;
  is_censored: boolean; degraded: boolean; excluded_from_training: boolean;
  exclude_reason: string | null; source: string;
  sku_code: string; sku_name: string; category_id: number; category_code: string; category_name: string;
}

export interface SuggestionVersion {
  id: number; table_id: number; version_no: number; revision_of: number | null;
  trigger_event: string; status: string; created_by: string; created_at: string;
  feature_snapshot: FeatureSnapshot; cost_snapshot: CostSnapshot;
}
export interface FeatureSnapshot {
  arrivalDate: string; weekday: string; baseline: string;
  features: Record<string, unknown>; sampleWindowDays: number; minSamples: number;
}
export interface CostSnapshot {
  categories: Record<string, { cu: number; co: number; tau: number; source: string }>;
  rounding: string;
}
export interface SuggestionItem {
  id: number; version_id: number; sku_id: number; quantile: string;
  suggested_qty: string; raw_qty: string; model_note: string | null;
  feature_snapshot: Record<string, unknown>;
  sku_code: string; sku_name: string; unit: string; min_order_unit: string; is_new: boolean;
  category_id: number; category_code: string; category_name: string;
}
export interface OrderInfo {
  id: number; table_id: number; version_id: number; store_id: number; arrival_date: string;
  status: string; confirmed_by: string; confirmed_at: string;
}
export interface OrderItem {
  id: number; order_id: number; sku_id: number; qty: string; reason_code: string | null;
  suggested_qty: string; sku_name: string; sku_code: string;
}
export interface SuggestionResponse {
  table: { id: number; store_id: number; arrival_date: string; status: string } | null;
  versions: SuggestionVersion[];
  currentVersion: SuggestionVersion | null;
  items: SuggestionItem[];
  order: OrderInfo | null;
  orderItems: OrderItem[];
}

export interface ReviewItem {
  id: number; review_id: number; sku_id: number; order_qty: string;
  actual_sales: string | null; waste_qty: string | null; restored_demand: string | null;
  stockout_loss_qty: string | null; waste_cost: string | null; stockout_loss_amount: string | null;
  sample_id: number | null; sample_excluded: boolean;
  sku_code: string; sku_name: string; unit: string; category_name: string; category_code: string;
}
export interface Review {
  id: number; order_id: number; version_id: number; store_id: number; arrival_date: string;
  baseline: string; status: string; version_no: number; items: ReviewItem[];
}

export interface WasteRecord {
  id: number; store_id: number; sku_id: number; business_date: string; qty: string;
  recorded_at: string; within_window: boolean; disposition: 'recalc' | 'archived'; note: string;
  sku_name: string; sku_code: string;
}
export interface Stocktake {
  id: number; store_id: number; sku_id: number; business_date: string;
  system_qty: string; actual_qty: string; difference: string; created_at: string;
  sku_name: string; sku_code: string;
}

export const TRIGGER_EVENTS: Record<string, string> = {
  manual: '手动生成',
  promo_cancelled: '促销临时取消',
  temp_drop: '降温超出预报',
  delivery_delay: '配送车延误',
  waste_carryover: '报损结转重算',
};

export const REASON_CODES = ['天气原因', '促销调整', '竞品影响', '库存压力', '经验加量', '经验减量', '其他'];

/* ---------------- 新店新品试销 ---------------- */

export interface TrialPeriod { key: string; label: string; start: string; end: string; hours: number }

export interface TrialReferenceStat {
  id: number; store_type: string; district: string; spec: string;
  ref_sku_id: number; period: string; ref_sales_qty: string; ref_in_stock_hours: string;
  sample_days: number; sku_name: string; sku_code: string; category_id: number; category_name: string;
}

export interface TrialCatalog {
  storeType: string; district: string; specs: string[];
  periods: TrialPeriod[]; stats: TrialReferenceStat[];
}

export interface TrialReferenceLine {
  id: number; set_id: number; period: string; ref_sku_id: number;
  ref_sales_qty: string; ref_in_stock_hours: string;
  sku_name?: string; sku_code?: string; spec?: string;
}

export interface TrialReferenceSet {
  id: number; plan_id: number; revision_no: number; invalidated: boolean;
  invalidated_reason: string | null; created_by: string; created_at: string;
  lines: TrialReferenceLine[];
}

export interface TrialObservation {
  id: number; plan_id: number; business_date: string; period: string;
  revision_no: number; is_current: boolean; superseded_by: number | null;
  status: 'operating' | 'sold_out' | 'no_stock' | 'closed' | 'missing';
  actual_sales: string; in_stock_hours: string; waste_qty: string;
  import_key: string | null; revision_reason: string | null;
  created_by: string; created_at: string;
}

export interface TrialDemandBlock {
  salesQty: number; inStockHours: number; hourlyRate: number; lambda: number;
  quantile?: number; demandQuantile: number; suggestedQty: number; rawQty?: number;
  intervalLow: number; intervalHigh: number;
  expectedShortageUnits: number; expectedWasteUnits: number;
  shortageCost: number; wasteCost: number; expectedTotalCost: number;
}

export interface TrialEstimateComputed {
  openHoursPerDay: number; tau: number; cu: number; co: number; minOrderUnit: number;
  actual: { salesQty: number; inStockHours: number; hourlyRate: number; observedDays: number };
  reference: { salesQty: number; inStockHours: number; hourlyRate: number; lineCount: number };
  withRef: TrialDemandBlock; withoutRef: TrialDemandBlock;
  deltaQty: number; explanation: string;
}

export interface TrialCoverageDay {
  date: string; actualSales: number; observedHours: number; lambdaDay: number;
  intervalLow: number; intervalHigh: number; covered: boolean; deviation: number;
  complete: boolean; missingPeriods: string[]; closedPeriods: string[];
}

export interface TrialCoverage {
  days: TrialCoverageDay[];
  validDays: number; consecutiveValidDays: number;
  consecutiveFrom: string | null; consecutiveTo: string | null;
  coverage: number; meanDeviation: number; missingDays: string[];
  totalActualSales: number; wasteQty: number; wasteRate: number;
  rule: { minValidDays: number; minCoverage: number; maxWasteRate: number; maxMeanDeviation: number };
  passed: boolean; reasons: string[];
}

export interface TrialEstimateRow {
  id: number; plan_id: number; revision_no: number; trigger: string;
  computed: TrialEstimateComputed; basis_snapshot: {
    referenceSetId: number | null; referenceRevision: number | null; referenceInvalidated: boolean;
    referenceLines: { period: string; refSkuId: number; refSalesQty: number; refInStockHours: number }[];
    observationRows: number; observationRevisions: string[];
    cost: { cu: number; co: number; source: string };
  };
  frozen: boolean; frozen_by_confirmation_id: number | null;
  created_by: string; created_at: string;
}

export interface TrialDecision {
  id: number; plan_id: number; action: 'add' | 'observe' | 'stop';
  status: 'pending_confirm' | 'confirmed' | 'observed' | 'stopped' | 'rejected_stale';
  suggested_qty: string; batch_qty: string; basis_estimate_id: number | null;
  note: string | null; created_by: string; created_at: string; confirmed_at: string | null;
}

export interface TrialConfirmation {
  id: number; plan_id: number; decision_id: number | null;
  kind: 'initial' | 'add'; qty: string;
  status: 'pending' | 'stopped_pending';
  estimate_snapshot: {
    estimateRevision: number | null;
    estimate: TrialEstimateComputed | null;
    basis: TrialEstimateRow['basis_snapshot'] | null;
    coverage: TrialCoverage;
    confirmedAt: string;
  };
  confirmed_by: string; confirmed_at: string;
}

export interface TrialPlan {
  id: number; store_id: number; sku_id: number; arrival_date: string;
  status: 'selling' | 'stopped' | 'graduated';
  periods: string[]; store_type: string; district: string; spec: string;
  stopped_at: string | null; stop_reason: string | null; stopped_estimate_id: number | null;
  graduated_at: string | null; graduated_snapshot: Record<string, unknown> | null;
  created_by: string; created_at: string;
  sku_name: string; sku_code: string; unit: string; min_order_unit: string;
  sku_spec?: string; store_name: string; category_name?: string;
}

export interface TrialPlanListItem extends TrialPlan {
  latestEstimate: TrialEstimateRow | null;
  pendingConfirmQty: number; pendingConfirmCount: number;
  pendingAddDecisions: number; stoppedPendingQty: number; stoppedPendingCount: number;
}

export interface TrialDetail {
  plan: TrialPlan;
  periods: TrialPeriod[];
  referenceSets: TrialReferenceSet[];
  currentReferenceSet: TrialReferenceSet | null;
  observations: TrialObservation[];
  estimates: TrialEstimateRow[];
  currentEstimate: TrialEstimateRow | null;
  decisions: TrialDecision[];
  confirmations: TrialConfirmation[];
  coverage: TrialCoverage;
}

export const TRIAL_STATUS: Record<string, string> = {
  selling: '试销中',
  stopped: '已停止',
  graduated: '已转正',
};

export const TRIAL_ACTION: Record<string, string> = {
  add: '加订',
  observe: '继续观察',
  stop: '停止试销',
};

export const TRIAL_DECISION_STATUS: Record<string, string> = {
  pending_confirm: '待确认',
  confirmed: '已确认',
  observed: '继续观察',
  stopped: '已停止',
  rejected_stale: '已作废（旧计划）',
};

export const TRIAL_ESTIMATE_TRIGGER: Record<string, string> = {
  initial: '创建计划',
  references: '参照变更',
  observations: '观测更新',
  reference_invalidated: '参照失效',
  decision: '决策冻结',
};
