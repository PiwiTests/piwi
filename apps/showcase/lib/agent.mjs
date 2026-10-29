// The coding agent of the coda: a client of the runs' MCP server the editor serves (`piwi.runs`), configured as a
// person configures their agent, from **Piwi: Copy the runs' MCP server configuration for agents**. Its moves are
// written here, not chosen by a model: it plays the tool calls an agent makes to finish a test at its stop.

/** The runs' MCP server's address and token, from the configuration the editor copies (`servers` or `mcpServers`). */
export function runsServer(configuration) {
  const parsed = JSON.parse(configuration);
  const entry = (parsed.servers ?? parsed.mcpServers ?? {})['piwi-runs'];
  const authorization = entry?.headers?.Authorization ?? '';
  if (!entry?.url || !authorization.startsWith('Bearer ')) throw new Error('no runs MCP server in the configuration');
  return { url: entry.url, token: authorization.slice('Bearer '.length) };
}

export class Agent {
  /** `told(call)`, when given, hears each tool call as it starts (`{ name, args }`). */
  constructor({ url, token }, told = null) {
    this.url = url;
    this.token = token;
    this.told = told;
    this.id = 0;
    this.calls = [];
  }

  async post(message) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(message),
    });
    if (!response.ok && response.status !== 202) throw new Error(`the runs' MCP server answered ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async connect() {
    const answer = await this.post({
      jsonrpc: '2.0',
      id: ++this.id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'showcase-agent', version: '1.0.0' },
      },
    });
    if (answer?.error) throw new Error(`initialize: ${answer.error.message}`);
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return answer.result;
  }

  /**
   * Calls a tool; resolves with Piwi's answer (the JSON block) and the page's text (the page-content blocks), as an
   * agent reads them apart.
   */
  async tool(name, args = {}) {
    this.told?.({ name, args });
    const answer = await this.post({
      jsonrpc: '2.0',
      id: ++this.id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (answer?.error) throw new Error(`${name}: ${answer.error.message}`);
    const texts = (answer.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    if (answer.result?.isError) throw new Error(`${name}: ${texts.join(' ')}`);
    let piwi = null;
    const page = [];
    for (const text of texts) {
      if (text.startsWith('<<<page-content')) page.push(text);
      else if (piwi === null) {
        try {
          piwi = JSON.parse(text);
        } catch {
          page.push(text);
        }
      }
    }
    this.calls.push({ name, args, piwi });
    return { piwi, page: page.join('\n') };
  }
}

/** The ref of the element of `role` named `name` in an AI snapshot (`- link "Orders" [ref=e12]`). */
export function refOf(snapshot, role, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot);
  return match?.[1] ?? null;
}
