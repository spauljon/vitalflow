import {LangGraphRunnableConfig} from "@langchain/langgraph";
import {getMcpClient} from "./mcpSession.mjs";
import {McpHttpClient} from "./mcpClient.mjs";
import {State} from "./state.mjs";
import {FhirBundle} from "./fhirBundle.mjs";

export const FHIR_MCP_URL = process.env.MCP_URL ?? "http://mcp-fhir:8080/mcp";

export const dataAgent = async (
  s: typeof State.State,
  cfg?: LangGraphRunnableConfig
): Promise<typeof State.State> => {
  const threadId = cfg?.configurable?.thread_id ?? "default-thread";
  const client = getMcpClient(threadId, FHIR_MCP_URL);

  await client.ensureSession();

  const codes = s.params?.codes?.length ? s.params.codes.join(",") : undefined;
  if (!s.params?.patientId || !codes) {
    // If planner/intake didn’t fill enough info, short-circuit
    return {...s, bundle: {resourceType: "Bundle", total: 0, entry: []}};
  }

  const args = {
    patientId: s.params.patientId,
    code: codes,
    since: s.params.since,
    until: s.params.until,
    count: s.params.count ?? 100,
    maxItems: s.params.maxItems ?? 200
  };

  const raw = await client.callTool("fhir.search_observations", args);
  const payload = McpHttpClient.extractPayload(raw);

  const total = typeof payload?.totalReturned === "number" ? payload.totalReturned : 0;
  const bundle: FhirBundle = {
    resourceType: "Bundle",
    total,
    entry: payload?.items ?? []
  };

  return {...s, bundle};
};

