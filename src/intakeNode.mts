// Minimal, dependency-free intake agent.
// Goal: turn free text into a normalized query for the planner/data agent.

export type Intent = "fetch" | "summarize" | "unknown";

export interface QueryParams {
  patientId?: string;
  codes?: string[];      // LOINC tokens, optionally "http://loinc.org|8480-6"
  since?: string;        // ISO 8601
  until?: string;        // ISO 8601
  count?: number;
  maxItems?: number;
}

export interface IntakeState {
  query: string;         // raw user text
  params: QueryParams;   // parsed params for downstream nodes
  route?: Intent;        // (optional) early routing hint for the planner
}

/** --- tiny helpers ------------------------------------------------------- **/

// naive date parser: supports YYYY-MM-DD, YYYY/MM/DD, or month names like "since July 2024".
const toIsoDate = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(+d) ? undefined : d.toISOString();
};

// extract first thing that looks like a Patient id (e.g., "patient 123", "patientId: 123-xyz")
function parsePatientId(text: string): string | undefined {
  const m =
    /\bpatient(?:Id)?[:\s-]*([a-z0-9\-._]+)/i.exec(text) ||
    /\bpid[:\s-]*([a-z0-9\-._]+)/i.exec(text);
  return m?.[1];
}

// find explicit LOINC codes, optionally with system prefix
function parseLoincCodes(text: string): string[] {
  const codes = new Set<string>();
  // Match "http(s)://loinc.org|8480-6" OR bare "8480-6"
  // Key trick: (?!-\d) prevents matching the first part of a date like 2024-07-01
  const re = /(?:https?:\/\/loinc\.org\|)?(\d{1,6}-\d)(?!-\d)\b/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code = m[1];
    codes.add(`http://loinc.org|${code}`); // normalize to system|code
  }
  return [...codes];
}

// very small synonym map for common vitals → LOINC codes (expand as you go)
const SYNONYM_CODES: Record<string, string[]> = {
  "blood pressure": ["http://loinc.org|8480-6", "http://loinc.org|8462-4"], // systolic, diastolic
  "bp": ["http://loinc.org|8480-6", "http://loinc.org|8462-4"],
  "systolic": ["http://loinc.org|8480-6"],
  "diastolic": ["http://loinc.org|8462-4"],
  "heart rate": ["http://loinc.org|8867-4"],
  "pulse": ["http://loinc.org|8867-4"],
  "spo2": ["http://loinc.org|59408-5"],
  "oxygen saturation": ["http://loinc.org|59408-5"],
  "weight": ["http://loinc.org|29463-7"],
  "height": ["http://loinc.org|8302-2"],
};

SYNONYM_CODES["blood pressure"] = SYNONYM_CODES["bp"];

function expandSynonyms(text: string, existing: string[]): string[] {
  const normalized = text.toLowerCase();
  const out = new Set(existing);
  for (const [k, vals] of Object.entries(SYNONYM_CODES)) {
    if (normalized.includes(k)) {
      vals.forEach(v => out.add(v));
    }
  }
  return [...out];
}

function parseSince(text: string): string | undefined {
  // patterns like "since 2023-01-01", "after July 1 2024"
  const m =
    /\b(since|after)\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}[-/]\d{1,2})/i.exec(
      text
    );
  return toIsoDate(m?.[2]);
}

function parseUntil(text: string): string | undefined {
  // patterns like "until 2024-12-31", "through Aug 2025", "before 2025/01/01"
  const m =
    /\b(until|through|before)\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}[-/]\d{1,2})/i.exec(
      text
    );
  return toIsoDate(m?.[2]);
}

function parseNumber(text: string, keys: string[], def?: number): number | undefined {
  const re = new RegExp(`\\b(?:${keys.join("|")})\\s*[:=]?\\s*(\\d{1,4})\\b`, "i");
  const m = re.exec(text);
  if (!m) return def;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : def;
}

/** --- the intake agent --------------------------------------------------- **/

// You can use this as a LangGraph node (async function) or call it directly before planner.
export async function intakeNode(input: { query: string }): Promise<IntakeState> {
  const q = input.query.trim();

  const patientId = parsePatientId(q);
  let codes = parseLoincCodes(q);
  codes = expandSynonyms(q, codes);

  const since = parseSince(q);
  const until = parseUntil(q);
  const count = parseNumber(q, ["count", "_count"], 100);
  const maxItems = parseNumber(q, ["max", "maxItems"], 200);

  // simple routing hint (planner can override)
  const action = codes.length === 0 && (since || until) ? "summarize" : "unknown";
  const route: Intent = patientId && codes.length > 0 ? "fetch" : action;

  const params: QueryParams = {
    patientId,
    codes: codes.length ? codes : undefined,
    since,
    until,
    count,
    maxItems,
  };

  return { query: q, params, route };
}
