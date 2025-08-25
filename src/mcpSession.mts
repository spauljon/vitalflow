// mcp-session-store.ts
import { McpHttpClient } from "./mcpClient.mjs";

const clientsByThread = new Map<string, McpHttpClient>();

export function getMcpClient(threadId: string, baseUrl: string, apiKey?: string) {
  let c = clientsByThread.get(threadId);
  if (!c) {
    c = new McpHttpClient(baseUrl, apiKey);
    clientsByThread.set(threadId, c);
  }
  return c;
}