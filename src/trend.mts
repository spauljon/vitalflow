import {z} from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {McpHttpClient} from "./mcpClient.mjs";

export type Point = { t: string; v: number };
export type Series = { code: string; display?: string; unit?: string | null; points: Point[] };
export type Stats = {
  code: string;
  display?: string;
  unit?: string | null;
  latest?: number;
  latestAt?: string;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
  slope?: number;
  zscore_latest?: number;
};
export type Flag = {
  code: string;
  severity: "info" | "warn" | "crit";
  rule: string;
  evidence: string
};

export type Frequency = "auto" | "hourly" | "daily" | "weekly";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[], m = mean(xs)) => xs.length > 1 ? xs.reduce(
  (a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) : 0;
const std = (xs: number[], m = mean(xs)) => Math.sqrt(variance(xs, m));
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length, m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function slopePerDay(pts: Point[]) {
  if (pts.length < 2) {
    return 0;
  }
  const t0 = +new Date(pts[0].t);
  const xs = pts.map(p => (+new Date(p.t) - t0) / 86400000); // days
  const ys = pts.map(p => p.v);
  const xbar = mean(xs), ybar = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xbar) * (ys[i] - ybar);
    den += (xs[i] - xbar) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function computeStats(s: Series): Stats {
  const vals = s.points.map(p => p.v);
  if (!vals.length) {
    return {code: s.code, display: s.display, unit: s.unit};
  }
  const latest = s.points[s.points.length - 1];
  const m = mean(vals);
  const sd = std(vals, m);
  const med = median(vals);
  const sl = slopePerDay(s.points);
  const z = sd > 0 ? (latest.v - m) / sd : 0;
  return {
    code: s.code, display: s.display, unit: s.unit,
    latest: latest.v, latestAt: latest.t,
    min: Math.min(...vals), max: Math.max(...vals),
    mean: m, median: med, std: sd, slope: sl, zscore_latest: z
  };
}

export function floorBucket(ts: Date, f: Exclude<Frequency, "auto">): number {
  const d = new Date(ts);
  if (f === "hourly") {
    d.setMinutes(0, 0, 0);
  }
  if (f === "daily") {
    d.setUTCHours(0, 0, 0, 0);
  }
  if (f === "weekly") {
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - day);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d.getTime();
}

export function bucketSeries(s: Series, freq: Frequency): Series {
  if (freq === "auto") {
    if (s.points.length <= 200) {
      return s;
    }
    freq = "daily";
  }
  const buckets = new Map<number, number[]>();
  for (const p of s.points) {
    const k = floorBucket(new Date(p.t), freq);
    if (!buckets.has(k)) {
      buckets.set(k, []);
    }
    buckets.get(k)!.push(p.v);
  }
  const out: Point[] = [];
  for (const [k, arr] of buckets) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    const v = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2; // median per bucket
    out.push({t: new Date(k).toISOString(), v});
  }
  out.sort((a, b) => a.t.localeCompare(b.t));
  return {...s, points: out};
}

const LOINC_CODES = {
  SYS: "http://loinc.org|8480-6",
  DIA: "http://loinc.org|8462-4",
  HR: "http://loinc.org|8867-4",
  SPO2: "http://loinc.org|59408-5",
};

export function flagsFromStats(all: Stats[]): Flag[] {
  const by = new Map(all.map(s => [s.code, s]));
  const out: Flag[] = [];

  // BP combined
  const sys = by.get(LOINC_CODES.SYS), dia = by.get(LOINC_CODES.DIA);
  if (sys?.latest != null && dia?.latest != null) {
    if (sys.latest >= 180 || dia.latest >= 120) {
      out.push({
        code: "BP",
        severity: "crit",
        rule: "Hypertensive crisis candidate",
        evidence: `SBP ${sys.latest} / DBP ${dia.latest}`
      });
    } else if (sys.latest >= 160 || dia.latest >= 100) {
      out.push({
        code: "BP",
        severity: "warn",
        rule: "Very high blood pressure",
        evidence: `SBP ${sys.latest} / DBP ${dia.latest}`
      });
    }
    if ((sys.slope ?? 0) >= 2) {
      out.push({
        code: LOINC_CODES.SYS,
        severity: "info",
        rule: "Systolic rising fast (≥ +2 mmHg/day)",
        evidence: `slope ${sys.slope?.toFixed(2)}`
      });
    }
  }

  // HR
  const hr = by.get(LOINC_CODES.HR);
  if (hr?.latest != null) {
    if (hr.latest > 130 || hr.latest < 40) {
      out.push({
        code: LOINC_CODES.HR,
        severity: "warn",
        rule: "HR out of nominal range",
        evidence: `HR ${hr.latest}`
      });
    }
  }

  // SpO2
  const sp = by.get(LOINC_CODES.SPO2);
  if (sp?.latest != null) {
    if (sp.latest < 90) {
      out.push(
        {code: LOINC_CODES.SPO2, severity: "crit", rule: "Low SpO₂", evidence: `${sp.latest}%`});
    } else if (sp.latest < 93) {
      out.push({
        code: LOINC_CODES.SPO2,
        severity: "warn",
        rule: "Borderline SpO₂",
        evidence: `${sp.latest}%`
      });
    }
  }

  return out;
}
export const trendInputArgs = {
  patientId: z.string(),
  codes: z.array(z.string()).min(1), // normalized "system|code" preferred
  window: z.object({
    kind: z.enum(["rolling", "since"]).default("rolling"),
    days: z.number().int().positive().optional(),     // used when kind=rolling
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
  }).default({kind: "rolling", days: 30}),
  frequency: z.enum(["auto", "hourly", "daily", "weekly"]).default("auto"),
  maxItems: z.number().int().min(1).max(5000).default(200),

  /** Optional: if your LangGraph already fetched observations and passes them in */
  items: z.array(z.any()).optional()
} as const;

const trendInputSchema = z.object(trendInputArgs);
export type TrendInput = z.infer<typeof trendInputSchema>;

/** Normalize simplified observations (from your FHIR tool) → Series[] */
// Minimal shape we expect from your simplified FHIR tool
type SimpleObs = {
  value?: unknown;
  valueQuantity?: { value?: unknown; unit?: string | null };
  code?: { system?: string; code?: string; display?: string };
  loinc?: string;
  unit?: string | null;
  when?: string;
  effectiveDateTime?: string;
  issued?: string;
};

const LOINC = "http://loinc.org";

function joinSystemCode(system: string, code: string): string {
  return `${system}|${code}`;
}

function stripSystem(code: string): string {
  const idx = code.indexOf("|");
  return idx === -1 ? code : code.slice(idx + 1);
}

function canonicalCode(it: SimpleObs): string {
  if (it?.code?.system && it?.code?.code) {
    return joinSystemCode(it.code.system, it.code.code);
  }
  if (it?.loinc) {
    return joinSystemCode(LOINC, it.loinc);
  }
  if (it?.code?.code) {
    return it.code.code;
  }
  return "unknown";
}

function numericValue(it: SimpleObs): number | null {
  const v = (it?.value as number) ?? (it?.valueQuantity?.value as number);
  return Number.isFinite(v) ? v : null;
}

function isoWhen(it: SimpleObs): string | null {
  const raw = it?.when ?? it?.effectiveDateTime ?? it?.issued;
  if (!raw) {
    return null;
  }
  const d = new Date(raw);

  return isNaN(+d) ? null : d.toISOString();
}

function pickUnit(it: SimpleObs): string | null {
  return it?.unit ?? it?.valueQuantity?.unit ?? null;
}

function buildRequestedSet(requestedCodes: string[]): Set<string> {
  if (!requestedCodes.length) {
    return new Set();
  }

  const set = new Set<string>();
  for (const rc of requestedCodes) {
    set.add(rc);                              // as provided
    set.add(stripSystem(rc));                 // bare form
    // ensure LOINC variant exists for bare requests
    const hasSystem = rc.includes("|");
    if (!hasSystem) {
      set.add(joinSystemCode(LOINC, rc));
    }
  }
  return set;
}

export function normalizeToSeries(items: SimpleObs[], requestedCodes: string[]): Series[] {
  const by = new Map<string, { display?: string; unit?: string | null; points: Point[] }>();
  const requested = buildRequestedSet(requestedCodes);

  for (const it of items) {
    const v = numericValue(it);
    if (v === null) {
      continue;
    }

    const t = isoWhen(it);
    if (!t) {
      continue;
    }

    const code = canonicalCode(it);

    const bucket = by.get(code) ?? {display: it?.code?.display, unit: pickUnit(it), points: []};
    bucket.points.push({t, v});
    by.set(code, bucket);
  }

  // Materialize, filter (if requested), and sort
  const out: Series[] = [];
  for (const [code, {display, unit, points}] of by) {
    if (requested.size) {
      const bare = stripSystem(code);
      if (!requested.has(code) && !requested.has(bare)) {
        continue;
      }
    }
    points.sort((a, b) => a.t.localeCompare(b.t));
    out.push({code, display, unit, points});
  }

  out.sort((a, b) => a.code.localeCompare(b.code));

  return out;
}

export type TrendState = {
  params?: {
    patientId?: string;
    codes?: string[];
    since?: string;
    until?: string;
    count?: number;
    maxItems?: number;
  };
  bundle?: { entry?: any[] };  // if previous node already fetched observations
  trends?: {
    series: Series[];
    stats: ReturnType<typeof computeStats>[];
    flags: ReturnType<typeof flagsFromStats>;
    raw: { fetchedCount: number };
    query: any;
  };
};

export type TrendNodeOptions = {
  fhirClient?: McpHttpClient;             // optional: pass to allow on-demand fetch
  preferExistingItems?: boolean;          // reuse state.bundle.entry if present
  defaultWindowDays?: number;             // for rolling mode
  frequency?: Frequency;                  // bucketing
  maxItems?: number;                      // hard cap
};

export function makeTrendNode(opts: TrendNodeOptions = {}) {
  const {
    fhirClient,
    preferExistingItems = true,
    defaultWindowDays = 30,
    frequency = "auto",
    maxItems = 500
  } = opts;

  return async function trendNode(
    s: TrendState,
    cfg?: RunnableConfig
  ): Promise<TrendState> {
    const patientId = s.params?.patientId;
    const codes = s.params?.codes ?? [];
    if (!patientId || codes.length === 0) {
      return { ...s, trends: undefined }; // planner should ensure these
    }

    let items: any[] = [];
    if (preferExistingItems && Array.isArray(s.bundle?.entry) && s.bundle.entry.length > 0) {
      items = s.bundle.entry;
    } else if (fhirClient) {
      await fhirClient.ensureSession();
      const since = s.params?.since ?? new Date(Date.now() - defaultWindowDays*86400000).toISOString();
      const until = s.params?.until;
      const resp = await fhirClient.callTool("fhir.search_observations", {
        patientId,
        code: codes.join(","),           // MCP FHIR supports comma-separated codes
        since,
        until,
        count: Math.min(200, s.params?.count ?? 100),
        maxItems: Math.min(maxItems, s.params?.maxItems ?? maxItems)
      });
      items = Array.isArray(resp?.items) ? resp.items : [];
    } else {
      // no data source available
      return { ...s, trends: undefined };
    }

    // 2) normalize → series
    let series = normalizeToSeries(items, codes);

    // 3) bucket
    series = series.map(srs => (srs.points.length ? bucketSeries(srs, frequency) : srs));

    // 4) stats + flags
    const stats = series.map(computeStats);
    const flags = flagsFromStats(stats);

    // 5) stash results
    const trends = {
      query: {
        patientId,
        codes,
        since: s.params?.since,
        until: s.params?.until,
        frequency,
        count: s.params?.count,
        maxItems: s.params?.maxItems
      },
      series,
      stats,
      flags,
      raw: { fetchedCount: items.length }
    };

    return { ...s, trends };
  };
}
