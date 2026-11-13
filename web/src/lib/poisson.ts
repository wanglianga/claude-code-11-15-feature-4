/**
 * 泊松计数分布：试销估计用整日需求强度 λ×营业时长 作为均值，
 * 取其分位得到"整日需求分位"，再向上取整到最小订货单位。
 *
 * 不用正态近似（除极大均值兜底）：试销日销量小，正态近似会给负数量且尾部失真；
 * 泊松计数分位天然是整数，符合"整箱/整份"的订货口径。
 */

const MAX_K = 100000;

/** 泊松 PMF（对数域计算，避免大 λ 下 exp(-λ) 下溢） */
export function logPoissonPmf(mu: number, k: number): number {
  if (!(mu > 0) || k < 0) return -Infinity;
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return -mu + k * Math.log(mu) - logFact;
}

export function poissonPmf(mu: number, k: number): number {
  if (mu <= 0) return k === 0 ? 1 : 0;
  return Math.exp(logPoissonPmf(mu, k));
}

/**
 * 泊松 CDF：P(X <= k)。
 * 在 λ 附近取最大项做缩放求和，避免首项下溢导致整体为 0。
 */
export function poissonCdf(mu: number, k: number): number {
  if (mu <= 0) return k >= 0 ? 1 : 0;
  if (k < 0) return 0;
  if (mu > 1e6) {
    // 极大均值：正态近似（连续性修正），仅兜底，正常试销用不到
    const z = (k + 0.5 - mu) / Math.sqrt(mu);
    return normalCdf(z);
  }
  const kmax = Math.min(k, upperRange(mu));
  const logs: number[] = [];
  let logFact = 0;
  let maxLog = -Infinity;
  for (let i = 0; i <= upperRange(mu); i++) {
    if (i >= 2) logFact += Math.log(i);
    const lp = -mu + i * Math.log(mu) - logFact;
    logs.push(lp);
    if (lp > maxLog) maxLog = lp;
  }
  let total = 0;
  for (const lp of logs) total += Math.exp(lp - maxLog);
  let prefix = 0;
  for (let i = 0; i <= kmax; i++) prefix += Math.exp(logs[i] - maxLog);
  return Math.min(1, prefix / total);
}

/**
 * 泊松分位：最小的整数 k 使 P(X <= k) >= tau。
 * 例：λ=26, tau=0.8 → 30（试验参考值）。
 */
export function poissonQuantile(mu: number, tau: number): number {
  if (!(tau > 0 && tau < 1)) throw new Error(`非法分位 tau=${tau}`);
  if (!(mu > 0)) return 0;
  if (mu > 1e6) {
    return Math.max(0, Math.ceil(mu + Math.sqrt(mu) * normalQuantile(tau)));
  }
  const logs: number[] = [];
  let logFact = 0;
  let maxLog = -Infinity;
  for (let i = 0; i <= upperRange(mu); i++) {
    if (i >= 2) logFact += Math.log(i);
    const lp = -mu + i * Math.log(mu) - logFact;
    logs.push(lp);
    if (lp > maxLog) maxLog = lp;
  }
  let total = 0;
  for (const lp of logs) total += Math.exp(lp - maxLog);
  let prefix = 0;
  for (let i = 0; i < logs.length && i <= MAX_K; i++) {
    prefix += Math.exp(logs[i] - maxLog);
    if (prefix / total >= tau - 1e-12) return i;
  }
  return logs.length - 1;
}

/** 覆盖 tau 的上界：均值 + 12σ + 20，保证尾部概率可忽略 */
function upperRange(mu: number): number {
  return Math.min(MAX_K, Math.ceil(mu + 12 * Math.sqrt(mu) + 20));
}

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 误差函数近似） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? p : 1 - p;
}

/** 标准正态分位（Acklam 近似，极大均值兜底用） */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572, 0];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416, 0];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
