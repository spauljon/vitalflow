import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";

import {stateGraph as vitalflow} from "./graph.mjs";

export const server = new McpServer({name: "vitalflow", version: "0.1.0"});

const RunInput = {
  threadId: z.string().default("vf-thread-1"),
  input: z.object({
    query: z.string().default(""),
    params: z.record(z.any()).default({}) // patientId, codes, since, etc.
  })
};

server.registerTool(
  "vitalflow-run",
  {
    title: "Patient Health Vitals and Trends",
    description: `
Query, analyze, and visualize patient health metrics (e.g., blood pressure, heart rate, SpO₂) 
from FHIR data. Supports multiple modes:

- **fetch**: Retrieve observations by patient and LOINC code.
- **metrics**: Show raw observations in a Markdown table.
- **summarize**: Provide narrative summaries of recent readings.
- **visualize**: Render graphs (e.g., grouped bars for systolic/diastolic blood pressure).
- **alert**: Flag threshold crossings or abnormal values.

Use this tool whenever a user asks for vitals, health metrics, trends, summaries, tables, or 
graphs for a specific patient. 

Input: natural language query only, no params.
Output: Markdown (tables or charts) and JSON summary.
    `.trim(),
    inputSchema: RunInput
  },
  async ({threadId, input}) => {
    try {
      const out = await vitalflow.invoke(input, { configurable: { thread_id: threadId } });
      if (out.chart) {
        if (out.chart.kind === "png") {
          const b64 = Buffer.from(out.chart.bytes).toString("base64");
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
            ],
          };
        }
      }

      return {
        content: [{ type: "text", text: out.summary ?? "No output" }],
      };
    } catch (err: any) {
      console.error("[vitalflow-run] tool error:", err?.stack ?? err);
      return {
        isError: true,
        content: [{ type: "text", text: `VitalFlow error: ${err?.message ?? "Unknown error"}` }],
      };
    }
  }
);

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
