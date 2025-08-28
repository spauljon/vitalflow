import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";

import {stateGraph as vitalflow} from "./graph.mjs";

export const server = new McpServer({ name: "vitalflow", version: "0.1.0" });

const RunInput = {
  threadId: z.string().default("vf-thread-1"),
  input: z.object({
    query: z.string().default(""),
    params: z.record(z.any()).default({}) // patientId, codes, since, etc.
  })
};

server.registerTool(
  "vitalflow.run",
  {
    title: "Run VitalFlow",
    description: "Execute the intake → planner → data_agent → trend (chart) flow and return the" +
      " Markdown/graph or summarized output.",
    inputSchema: RunInput
  },
  async ({ threadId, input }) => {
    const out = await vitalflow.invoke(input, {
      configurable: { thread_id: threadId }
    });
    const payload = {
      summary: out.summary ?? "",
      params: input.params ?? {},
      // include a little structured data if you want:
      trends: out.trends ? { statsCount: out.trends.stats?.length ?? 0, seriesCount: out.trends.series?.length ?? 0 } : undefined
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);
