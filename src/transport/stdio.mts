import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";

export async function startStdio(server: McpServer) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
