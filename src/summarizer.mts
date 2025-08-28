import type {RunnableConfig} from "@langchain/core/runnables";
import {ChatOpenAI} from "@langchain/openai";
import {metricDetails} from "./metrics.mjs";
import {contentToString} from "./aiShared.mjs";
import {
  bucketSeries,
  computeStats,
  flagsFromStats,
  Frequency,
  Series,
  Trends
} from "./trend-math.mjs";

export type SummarizerState = {
  params?: { patientId?: string; codes?: string[] };
  trends?: Trends;
  bundle?: { entry?: any[] };
  summary?: string;
  route?: "summarize" | "metrics" | "unknown";

};

function createSeries(by: Map<string, {
  display?: string;
  unit?: string | null;
  points: { t: string; v: number }[]
}>, requestedCodes: string[]) {
  const out: Series[] = [];
  for (const [code, {display, unit, points}] of by) {
    points.sort((a, b) => a.t.localeCompare(b.t));
    const keyNoScheme = code.includes("|") ? code : `http://loinc.org|${code}`;
    if (requestedCodes?.length && !requestedCodes.includes(code) && !requestedCodes.includes(
      keyNoScheme)) {
      continue;
    }
    out.push({code, display, unit, points});
  }

  out.sort((a, b) => a.code.localeCompare(b.code));

  return out;
}

function observationsToSeries(items: any[], requestedCodes: string[]): Series[] {
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

    const rhs = it?.code?.system && it?.code?.code ? `${it.code.system}|${it.code.code}` :
      it?.code?.code ?? "unknown";
    const code = it?.loinc ? `http://loinc.org|${it.loinc}` : rhs;

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
  return createSeries(by, requestedCodes);
}

async function summarizeTrends(llm: ChatOpenAI | undefined,
                               s: SummarizerState,
                               trends: Trends,
                               pid: string | undefined) {
  if (!llm) {
    return {...s, summary: "not available"};
  }
  const prompt = [
    {
      role: "system",
      content: "You are a clinical data summarizer. Be concise, neutral, and non-diagnostic."
    },
    {
      role: "user",
      content:
        `PATIENT: ${pid ?? "unknown"}
SERIES (JSON): ${JSON.stringify(trends.series).slice(0, 120000)}
STATS (JSON): ${JSON.stringify(trends.stats).slice(0, 120000)}
FLAGS (JSON): ${JSON.stringify(trends.flags).slice(0, 120000)}

Write a brief summary:
- One-line headline
- Bullet key findings
- A compact markdown table (code/display, latest, when, mean, slope/day)
- Bullet the flags (if any) with short rationale
- Avoid diagnosis; use "suggest review" language`
    }
  ];

  try {
    const res = await llm.invoke(prompt);
    return {...s, summary: contentToString(res).trim()};
  } catch {
    return {...s, summary: "not available"};
  }
}

async function summarizeObservations(items: any[], s: SummarizerState,
                                     bucketForFallback: Frequency,
                                     llm: ChatOpenAI | undefined,
                                     pid: string | undefined) {
  let series = observationsToSeries(items, s.params?.codes ?? []);
  series = series.map(srs => (srs.points.length ? bucketSeries(srs, bucketForFallback) : srs));
  const stats = series.map(computeStats);
  const flags = flagsFromStats(stats);

  if (!llm) {
    return {...s, summary: "not available"};
  }
  const prompt = [
    {
      role: "system",
      content: "You are a clinical data summarizer. Be concise, neutral, and non-diagnostic."
    },
    {
      role: "user",
      content:
        `PATIENT: ${pid ?? "unknown"}
SERIES (JSON): ${JSON.stringify(series).slice(0, 120000)}
STATS (JSON): ${JSON.stringify(stats).slice(0, 120000)}
FLAGS (JSON): ${JSON.stringify(flags).slice(0, 120000)}

Write a brief summary:
- One-line headline
- Bullet key findings
- A compact markdown table (code/display, latest, when, mean, slope/day)
- Bullet the flags (if any) with short rationale
- Avoid diagnosis; use "suggest review" language`
    }
  ];

  try {
    const res = await llm.invoke(prompt);

    return {...s, summary: contentToString(res).trim() };
  } catch {
    return {...s, summary: "not available"};
  }
}

export function makeSummarizerNode(opts?: {
  useLLM?: boolean;
  model?: string;
  temperature?: number;
  bucketForFallback?: Frequency;   // when summarizing from raw obs, we can bucket first
}) {
  const useLLM = opts?.useLLM ?? true;
  const model = opts?.model ?? process.env.SUMMARIZER_MODEL ?? "gpt-4o-mini";
  const temperature = opts?.temperature ?? 0.2;
  const bucketForFallback: Frequency = opts?.bucketForFallback ?? "auto";

  const llm = useLLM
    ? new ChatOpenAI({model, temperature})
    : undefined;

  return async function summarizer(
    s: SummarizerState,
    _cfg?: RunnableConfig
  ): Promise<SummarizerState> {
    const pid = s.params?.patientId;

    if (s.route === "metrics") {
      return metricDetails(s);
    }

    const items = s.bundle?.entry ?? [];
    if (items.length) {
      return await summarizeObservations(items, s, bucketForFallback, llm, pid);
    }

    return {...s, summary: "No observations or trends to summarize."};
  };
}