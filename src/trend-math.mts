
// A simple series type (each code has time–value points)
export type Point = { t: string; v: number };
export type Series = {
  code: string;
  display?: string;
  unit?: string | null;
  points: Point[];
};

export type Trends = {
  series: Series[];
  stats: ReturnType<typeof computeStats>[];
  flags: ReturnType<typeof flagsFromStats>;
  raw: { fetchedCount: number };
}


// Frequency control for bucketing
export type Frequency = "auto" | "daily" | "weekly" | "monthly";

/**
 * Down-sample or bucket a series into the desired frequency.
 * For now: “auto” = daily.
 */
export function bucketSeries(series: Series, freq: Frequency): Series {
  if (series.points.length === 0) return series;
  if (freq === "auto" || freq === "daily") {
    return {
      ...series,
      points: latestPerDay(series.points),
    };
  }
  // You could add weekly/monthly buckets later
  return series;
}

/** keep only the latest reading per day */
function latestPerDay(points: Point[]): Point[] {
  const byDay = new Map<string, Point>();
  for (const p of points) {
    const d = new Date(p.t);
    if (isNaN(+d)) continue;
    const dayIso = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    ).toISOString();
    const prev = byDay.get(dayIso);
    if (!prev || +new Date(p.t) > +new Date(prev.t)) {
      byDay.set(dayIso, p);
    }
  }
  return [...byDay.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * Compute simple stats for a series
 */
export function computeStats(series: Series) {
  const vals = series.points.map((p) => p.v);
  const n = vals.length;
  if (n === 0) {
    return { code: series.code, count: 0 };
  }
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...vals);
  const max = Math.max(...vals);

  // slope per day (simple linear regression)
  let slope = 0;
  if (n >= 2) {
    const xs = series.points.map((p) => +new Date(p.t) / 86400000); // days since epoch
    const ys = vals;
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = mean;
    let num = 0,
      den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    slope = den !== 0 ? num / den : 0;
  }

  return {
    code: series.code,
    count: n,
    mean,
    min,
    max,
    slopePerDay: slope,
  };
}

export function flagsFromStats(stats: ReturnType<typeof computeStats>[]) {
  const flags: { code: string; flag: string; value: number }[] = [];
  for (const s of stats) {
    if (!s.count) continue;
    const max = s?.max ?? 0;
    if (s.code.includes("8480-6") && max > 140) {
      flags.push({ code: s.code, flag: "high systolic", value: max });
    }
    if (s.code.includes("8462-4") && max > 90) {
      flags.push({ code: s.code, flag: "high diastolic", value: max });
    }
  }
  return flags;
}
