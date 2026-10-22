/** The guide anchors of the pages that connect things to the instance: Setup (`/setup`) and the MCP server (`/mcp`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const SETUP_ANCHORS = [
  {
    id: 'setup-ladder',
    pages: ['/setup'],
    describes:
      'The heading of What’s switched on: every optional capability, whether this instance uses it, and what each of the others needs.',
    requires: { permission: 'settings:manage' },
    doc: 'operate/capabilities',
    sample: { route: '/setup' },
  },
  {
    id: 'mcp-setup',
    pages: ['/mcp'],
    describes:
      'The Client setup card: the configuration that connects Claude Code, Cursor, VS Code or another MCP client to this instance.',
    requires: { capability: 'mcp' },
    doc: 'features/mcp',
    sample: { route: '/mcp' },
  },
];
