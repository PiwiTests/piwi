/**
 * Statistics for comparing two sets of timings: medians, spread, and the
 * Mann–Whitney U test (two-sided, normal approximation with tie correction),
 * which asks whether one set tends to be larger than the other without
 * assuming either is normally distributed — timings rarely are.
 */

export function median(values) {
  return quantile(values, 0.5);
}

export function quantile(values, q) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The most frequent value: the count of a deterministic metric, past an occasional background statement. */
export function mode(values) {
  const counts = new Map();
  for (const v of values) if (Number.isFinite(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  for (const [v, n] of counts)
    if (best === null || n > counts.get(best) || (n === counts.get(best) && v < best)) best = v;
  return best;
}

/**
 * The rounds `[from, to)` of `total` that session `session` (0-based) of `sessions` measures: a contiguous share,
 * the sizes differing by one at most. The suite measures by it and the comparison splits the samples by it.
 */
export function sessionRange(total, session, sessions) {
  return [Math.round((session * total) / sessions), Math.round(((session + 1) * total) / sessions)];
}

/** `values` split into the samples of each session, one round per sample. */
export function bySession(values, sessions) {
  return Array.from({ length: sessions }, (_, s) => values.slice(...sessionRange(values.length, s, sessions)));
}

/** The standard normal cumulative distribution (Abramowitz–Stegun 7.1.26). */
function normalCdf(z) {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-sided p-value of the Mann–Whitney U test between `a` and `b`; 1 when either set is too small. */
export function mannWhitneyP(a, b) {
  const x = a.filter(Number.isFinite);
  const y = b.filter(Number.isFinite);
  const n1 = x.length;
  const n2 = y.length;
  if (n1 < 3 || n2 < 3) return 1;
  const all = [...x.map((v) => ({ v, g: 0 })), ...y.map((v) => ({ v, g: 1 }))].sort((p, q) => p.v - q.v);
  const ranks = new Array(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((item, i) => {
    if (item.g === 0) r1 += ranks[i];
  });
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}
