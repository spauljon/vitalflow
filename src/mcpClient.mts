type Json = Record<string, any>;

export class McpHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private sessionId?: string
  ) {}

  getSessionId() { return this.sessionId; }

  private headers(extra?: Record<string, string>) {
    return {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...extra
    };
  }

  /** Initialize a new MCP session if we don't have one yet */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "langgraph-client", version: "0.1.0" },
        capabilities: {}
      }
    };

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`MCP initialize failed: ${res.status} ${res.statusText} ${txt}`);
    }

    // Transport returns session id in header
    const sid = res.headers.get("Mcp-Session-Id") || undefined;
    if (!sid) throw new Error("No Mcp-Session-Id returned by server.");
    this.sessionId = sid;

    // Drain/ignore body (we don't need the payload for init)
    await res.json().catch(() => undefined);

    return sid;
  }

  async listTools(): Promise<Json> {
    await this.ensureSession();
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    });
    return await res.json();
  }

  async callTool(name: string, args: Json): Promise<Json> {
    await this.ensureSession();
    const body = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args }
    };
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`tools/call failed: ${res.status} ${res.statusText} ${txt}`);
    }
    return await res.json();
  }

  static extractPayload(result: Json): any {
    const content = result?.result?.content;
    if (Array.isArray(content) && content[0]?.type === "text") {
      const t = content[0].text;
      try { return JSON.parse(t); } catch { return t; }
    }
    return result;
  }
}
