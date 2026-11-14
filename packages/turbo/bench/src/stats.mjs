// Small, dependency-free statistics for comparing runs.

export function median(values) {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Median absolute deviation, relative to the median: the run-to-run noise of one configuration. */
export function relativeSpread(values) {
  const center = median(values);
  if (!center) return NaN;
  return median(values.map((value) => Math.abs(value - center))) / center;
}

export function quantile(sortedValues, q) {
  if (!sortedValues.length) return NaN;
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

/** A seeded generator, so a report computed twice from the same samples says the same thing. */
export function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compares a candidate with a baseline measured in the same rounds. Each round gives one ratio
 * (candidate / baseline), which cancels drift the machine goes through between rounds.
 *
 * @param {Array<[number, number]>} pairs [baseline, candidate] per round
 * @returns {{ ratio: number, low: number, high: number, better: number, rounds: number }}
 *   the median ratio, its 95% bootstrap interval, and how many rounds the candidate came out lower
 */
export function compareRounds(pairs, { iterations = 4000, seed = 7 } = {}) {
  const ratios = pairs.filter(([base, candidate]) => base > 0 && Number.isFinite(candidate)).map(([base, candidate]) => candidate / base);
  if (!ratios.length) return { ratio: NaN, low: NaN, high: NaN, better: 0, rounds: 0 };
  const random = seededRandom(seed);
  const medians = [];
  for (let i = 0; i < iterations; i++) {
    const resample = ratios.map(() => ratios[Math.floor(random() * ratios.length)]);
    medians.push(median(resample));
  }
  medians.sort((a, b) => a - b);
  return {
    ratio: median(ratios),
    low: quantile(medians, 0.025),
    high: quantile(medians, 0.975),
    better: ratios.filter((ratio) => ratio < 1).length,
    rounds: ratios.length,
  };
}

/**
 * How a comparison reads. A change counts only when the interval excludes "no change" and at least
 * `minimumEffect` separates the median from it.
 */
export function verdict(comparison, minimumEffect = 0.02) {
  if (!comparison.rounds || comparison.rounds < 3) return 'too few rounds';
  if (comparison.high < 1 && 1 - comparison.ratio >= minimumEffect) return 'lower';
  if (comparison.low > 1 && comparison.ratio - 1 >= minimumEffect) return 'higher';
  return 'no clear difference';
}
