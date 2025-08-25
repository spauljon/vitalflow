// types.ts (or inline in your graph file)
export type SimplifiedObservation = {
  id?: string;
  loinc?: string;
  code?: { system?: string; code?: string; display?: string };
  value?: number | string | boolean | null;
  unit?: string | null;
  when?: string | null; // ISO
  status?: string;
  category?: string;
};

export function compactObs(items: any[], max = 120): SimplifiedObservation[] {
  const rows: SimplifiedObservation[] = [];
  for (const it of items) {
    // Accept already-simplified obs from your MCP server; if raw, map similarly
    rows.push({
      id: it.id,
      loinc: it.loinc ?? it.code?.code,
      code: it.code,
      value: it.value ?? it.valueQuantity?.value ?? null,
      unit: it.unit ?? it.valueQuantity?.unit ?? null,
      when: it.when ?? it.effectiveDateTime ?? it.issued ?? null,
      status: it.status,
      category: it.category
    });
    if (rows.length >= max) {
      break;
    }
  }
  return rows;
}

export function formatRowsCSV(rows: SimplifiedObservation[]): string {
  const header = "when,loinc,display,value,unit,status,category,id";
  const lines = rows.map(r => {
    const f = (v?: any) => (v == null ? "" : String(v).replaceAll(",", " "));
    return [
      f(r.when),
      f(r.loinc ?? r.code?.code),
      f(r.code?.display),
      f(r.value),
      f(r.unit),
      f(r.status),
      f(r.category),
      f(r.id)
    ].join(",");
  });
  return [header, ...lines].join("\n");
}
