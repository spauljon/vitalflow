import { ChatOpenAI } from "@langchain/openai";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { z } from "zod";

/** The LLM returns a safe, structured decision */
const PlannerSchema = z.object({
  route: z.enum(["fetch", "summarize", "alert", "unknown"]),
  rationale: z.string(),
  /** Only set fields you are certain about. Never invent PHI. */
  params_patch: z
    .object({
      patientId: z.string().optional(),
      codes: z.array(z.string()).optional(), // LOINC tokens (e.g., "http://loinc.org|8480-6")
      since: z.string().optional(),          // ISO 8601 if you’re certain; else omit
      until: z.string().optional(),
      count: z.number().int().optional(),
      maxItems: z.number().int().optional()
    })
    .default({}),
  /** Which fields are still needed before "fetch" can run */
  missing: z.array(z.enum(["patientId", "codes", "since", "until"])).default([])
});

const parser = new StructuredOutputParser(PlannerSchema);

const SYSTEM = `
You are a routing planner in a clinical data workflow. 
Decide the next step and optionally add safe parameter patches.
Rules:
- NEVER invent patient identifiers or dates.
- Only set params you are certain about from the user's query/context.
- Prefer "fetch" when patientId + codes are present or can be inferred with high confidence.
- Use "summarize" when there's no need to fetch (e.g., summarizing existing bundle).
- Use "alert" if the request clearly asks to check threshold flags.
- If unsure, set route="unknown" and list needed fields in "missing".
Return ONLY the JSON specified by the schema.
`;

function userPrompt(query: string, params: any) {
  return `
USER_QUERY:
${query}

CURRENT_PARAMS (may be partial):
${JSON.stringify(params ?? {}, null, 2)}

Decide route and suggest minimal, safe "params_patch".
Return JSON only with keys: route, rationale, params_patch, missing.
${parser.getFormatInstructions()}
`;
}

export function makePlannerNode<StateType extends {
  query: string;
  params?: any;
  route?: string;
}>(opts?: { model?: string; temperature?: number }) {
  const llm = new ChatOpenAI({
    model: opts?.model ?? "gpt-4o-mini",
    temperature: opts?.temperature ?? 0
  });

  /** LLM-driven planner node */
  return async function planner(
    s: StateType
  ): Promise<StateType> {
    try {
      const res = await llm.invoke([
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt(s.query, s.params) }
      ]);

      const out = await parser.parse(String(res.content ?? ""));
      // Merge params conservatively: patches win only where specified
      const merged = { ...(s.params ?? {}), ...(out.params_patch ?? {}) };

      // If LLM chose "fetch" but required fields are missing, downgrade to "unknown"
      const finalRoute =
        out.route === "fetch" && out.missing?.length
          ? "unknown"
          : out.route;

      return {
        ...s,
        params: merged,
        // keep your enum set; planner may output "alert" too
        route: (finalRoute as StateType["route"]) ?? s.route
      };
    } catch (err) {
      console.error(`Error parsing route: ${err}`);

      // 🔒 Safe fallback: deterministic rule-of-thumb
      const hasPid = Boolean(s.params?.patientId);
      const hasCodes = Array.isArray(s.params?.codes) && s.params.codes.length > 0;
      const fallbackRoute = hasPid && hasCodes ? "fetch" : "summarize";
      return { ...s, route: (fallbackRoute as StateType["route"]) };
    }
  };
}
