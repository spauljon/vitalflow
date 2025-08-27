import {SummarizerState} from "./summarizer.mjs";

type RawRow = {
  codeKey: string;           // system|code
  display?: string;
  value?: number | string | null;
  unit?: string | null;
  when?: string | null;      // ISO
  status?: string;
};

function normalizeRaw(obs: any): RawRow | null {
  // value
  let value: number | string | null = obs?.value;

  // code/system/display
  const c: {system: string, code: string, display: string} = obs?.code;
  const system: string | undefined = c?.system;
  const code: string | undefined = c?.code;
  const display: string | undefined = c?.display;

  const unit: string | undefined = obs?.unit;

  const rhs = code ? `http://loinc.org|${code}` : "unknown";
  const codeKey =
    system && code ? `${system}|${code}` : rhs;

  // when
  const when: string = obs?.when;

  return { codeKey, display, value, unit, when, status: obs?.status };
}

function formatMarkdownTable(rows: RawRow[], headers: string[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep  = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(r => {
    const vals = [
      r.codeKey.replace(/\|/g, "\\|"),
      r.display ?? "",
      r.value ?? "",
      r.unit ?? "",
      r.when ?? "",
      r.status ?? ""
    ].map(v => String(v));
    return `| ${vals.join(" | ")} |`;
  });
  return [head, sep, ...body].join("\n");
}

function pickRecentPerCode(rows: RawRow[], limitPerCode = 5): RawRow[] {
  const by = new Map<string, RawRow[]>();
  for (const r of rows) {
    if (!by.has(r.codeKey)) by.set(r.codeKey, []);
    by.get(r.codeKey)!.push(r);
  }
  const out: RawRow[] = [];
  for (const [, arr] of by) {
    arr.sort((a, b) => (new Date(b.when ?? 0).getTime() - new Date(a.when ?? 0).getTime()));
    out.push(...arr.slice(0, limitPerCode));
  }
  // sort stable: time desc, then
  out.sort((a, b) => a.when === b.when
    ?  a.codeKey.localeCompare(b.codeKey)
    : (new Date(b.when ?? 0).getTime() - new Date(a.when ?? 0).getTime()));

  return out;
}

export function metricDetails(s: SummarizerState) {
  const headers = ["Code", "Display", "Value", "Unit", "When (ISO)", "Status"];
  const items = Array.isArray(s.bundle?.entry) ? s.bundle.entry : [];
  if (!items.length) {
    return { ...s, summary: "No raw observations available." };
  }

  const allRows = items.map(normalizeRaw).filter((r): r is RawRow => !!r && !!r.when);
  const rows = pickRecentPerCode(allRows, 25);

  const table = formatMarkdownTable(rows, headers);

  return { ...s, summary: table };
}

