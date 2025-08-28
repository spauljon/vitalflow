import type {RunnableConfig} from "@langchain/core/runnables";
import * as vega from "vega";
import * as vl from "vega-lite";
import {
  bucketSeries,
  computeStats,
  flagsFromStats,
  type Series,
  type Frequency
} from "./trend-math.mjs";
import {McpHttpClient} from "./mcpClient.mjs";
import {writeFileSync} from "node:fs";
import {Canvas} from "canvas";

export type TrendState = {
  params?: {
    patientId?: string;
    codes?: string[];
    since?: string;
    until?: string;
    count?: number;
    maxItems?: number;
  };
  bundle?: { entry?: any[] };     // raw observations (optional)
  trends?: {
    series: Series[];
    stats: ReturnType<typeof computeStats>[];
    flags: ReturnType<typeof flagsFromStats>;
    raw: { fetchedCount: number };
    query: any;
  };
  summary?: string;
  chart?: any;
};

const LOINC_SYS = "http://loinc.org|8480-6";
const LOINC_DIA = "http://loinc.org|8462-4";

/** Reduce to the last reading per day for cleaner bars */
function latestPerDay(points: { t: string; v: number }[]) {
  const map = new Map<string, { t: string; v: number }>();
  for (const p of points) {
    const d = new Date(p.t);
    if (isNaN(+d)) {
      continue;
    }
    const dayIso = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    const prev = map.get(dayIso);
    if (!prev || +new Date(p.t) > +new Date(prev.t)) {
      map.set(dayIso, p);
    }
  }
  return [...map.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/** Build stacked-bar rows for SYS + DIA */
function buildBpRows(series: Series[]) {
  const sys = series.find(s => s.code === LOINC_SYS);
  const dia = series.find(s => s.code === LOINC_DIA);
  if (!sys?.points?.length && !dia?.points?.length) {
    return [];
  }

  const sysDaily = sys?.points?.length ? latestPerDay(sys.points) : [];
  const diaDaily = dia?.points?.length ? latestPerDay(dia.points) : [];

  const byDate = new Map<string, { SYS?: number; DIA?: number }>();
  for (const p of sysDaily) {
    const k = p.t.slice(0, 10);
    (byDate.get(k) ?? byDate.set(k, {}).get(k)!)!.SYS = p.v;
  }
  for (const p of diaDaily) {
    const k = p.t.slice(0, 10);
    (byDate.get(k) ?? byDate.set(k, {}).get(k)!)!.DIA = p.v;
  }

  const rows: { date: string; component: "Systolic" | "Diastolic"; value: number }[] = [];
  for (const [date, v] of byDate) {
    if (v.SYS != null) {
      rows.push({date, component: "Systolic", value: v.SYS});
    }
    if (v.DIA != null) {
      rows.push({date, component: "Diastolic", value: v.DIA});
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** Simple obs → series normalizer (matches your earlier shape) */
function normalizeToSeries(items: any[], requestedCodes: string[]): Series[] {
  const by = new Map<string, {
    display?: string;
    unit?: string | null;
    points: { t: string; v: number }[]
  }>();
  for (const it of items) {
    const v = it?.value ?? it?.valueQuantity?.value;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      continue;
    }

    const code =
      it?.loinc ? `http://loinc.org|${it.loinc}` :
        it?.code?.system && it?.code?.code ? `${it.code.system}|${it.code.code}` :
          it?.code?.code ?? "unknown";

    const when = it?.when ?? it?.effectiveDateTime ?? it?.issued;
    const iso = when ? new Date(when).toISOString() : undefined;
    if (!iso || isNaN(+new Date(iso))) {
      continue;
    }

    if (!by.has(code)) {
      by.set(code,
        {
          display: it?.code?.display,
          unit: it?.unit ?? it?.valueQuantity?.unit ?? null,
          points: []
        });
    }
    by.get(code)!.points.push({t: iso, v});
  }

  const out: Series[] = [];
  for (const [code, {display, unit, points}] of by) {
    points.sort((a, b) => a.t.localeCompare(b.t));
    const keyNoScheme = code.includes("|") ? code : `http://loinc.org|${code}`;
    if (requestedCodes.length && !requestedCodes.includes(code) && !requestedCodes.includes(
      keyNoScheme)) {
      continue;
    }
    out.push({code, display, unit, points});
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

export function makeTrendNode(opts?: {
  fhirClient?: McpHttpClient;        // optional: fetch if bundle is empty
  preferExistingItems?: boolean;     // reuse bundle.entry if present
  defaultWindowDays?: number;
  frequency?: Frequency;             // we can still bucket if needed
  maxItems?: number;
}) {
  const {
    fhirClient,
    preferExistingItems = true,
    defaultWindowDays = 30,
    frequency = "auto",
    maxItems = 500
  } = opts ?? {};

  return async function trend(
    s: TrendState,
    _cfg?: RunnableConfig
  ): Promise<TrendState> {
    const patientId = s.params?.patientId;
    const codes = s.params?.codes ?? [];
    if (!patientId || codes.length === 0) {
      return {...s, summary: "Missing patientId or codes for trend visualization."};
    }

    let items: any[] = [];
    if (fhirClient) {
      await fhirClient.ensureSession();
      const since = s.params?.since ?? new Date(
        Date.now() - defaultWindowDays * 86400000).toISOString();
      const until = s.params?.until;
      const resp = await fhirClient.callTool("fhir.search_observations", {
        patientId,
        code: codes.join(","),
        since,
        until,
        count: Math.min(200, s.params?.count ?? 100),
        maxItems: Math.min(maxItems, s.params?.maxItems ?? maxItems)
      });
      const payload = McpHttpClient.extractPayload(resp);

      items = Array.isArray(payload?.items) ? payload?.items : [];
    }

    if (!items.length) {
      return {...s, summary: "No observations available for trend visualization."};
    }

    let series = normalizeToSeries(items, codes);
    series = series.map(srs => (srs.points.length ? bucketSeries(srs, frequency) : srs));

    // 3) (Optional) compute stats/flags for future use
    const stats = series.map(computeStats);
    const flags = flagsFromStats(stats);

    // 4) Build BP stacked-bar rows
    const rows = buildBpRows(series);
    if (!rows.length) {
      return {
        ...s,
        trends: {
          series,
          stats,
          flags,
          raw: {fetchedCount: items.length},
          query: {patientId, codes}
        },
        summary: "No blood pressure series found (need LOINC 8480-6 and 8462-4)."
      };
    }

    // 5) Vega-Lite spec → inline SVG
    const spec: vl.TopLevelSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      description: "Blood Pressure — Systolic/Diastolic (stacked, daily latest)",
      width: 720,
      height: 360,
      data: {values: rows},
      mark: {type: "bar"},
      encoding: {
        x: {field: "date", type: "ordinal", title: "Date"},
        xOffset: {field: "component"},  // side-by-side bars
        y: {field: "value", type: "quantitative", title: "mmHg"},
        color: {field: "component", type: "nominal", title: "Component"},
        tooltip: [
          {field: "date", title: "Date"},
          {field: "component", title: "Component"},
          {field: "value", title: "mmHg"}
        ]
      }
    };

    const compiled = vl.compile(spec).spec;
    const view = new vega.View(vega.parse(compiled), {
      renderer: "none",
      loader: vega.loader(),
      logLevel: vega.Warn,
    });
    const canvas: Canvas = await view.toCanvas() as unknown as Canvas;
    const png = canvas.toBuffer("image/png");
    const chart = { kind: "png", bytes: new Uint8Array(png), caption: "Blood Pressure — grouped" +
        " bars (daily latest)" };


    writeFileSync("last-chart.png", png);

    return {
      ...s,
      trends: { series, stats, flags, raw: { fetchedCount: items.length }, query: { patientId, codes } },
      // keep summary text if you want a caption in your state
      summary: "Blood Pressure (Daily Latest) — grouped bars",
      chart
    };

    // const svg = await view.toSVG();
    // const svgUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    // const md = `### Blood Pressure (Daily Latest)\n\n![BP Chart](${svgUri})`;
    //
    // // 6) Return: stash trends for later; put SVG markdown in summary
    // return {
    //   ...s,
    //   trends: { series, stats, flags, raw: { fetchedCount: items.length }, query: { patientId, codes } },
    //   summary: md
    // };
  };
}
