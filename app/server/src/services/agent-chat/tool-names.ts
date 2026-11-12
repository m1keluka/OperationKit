// Tool names an agent file may list under `tools:` (obj 719987). Shared with
// the agent-templates card: knowledge + board names match the MCP connector's
// tool names; `email` and `calendar` are connectors that only ever draft.
export const KNOWLEDGE_TOOLS = ['search', 'list_folders', 'read_file', 'write_doc', 'file_answer'] as const
export const BOARD_TOOLS = ['create_objective', 'get_objective', 'list_objectives', 'board_briefing'] as const
export const CONNECTOR_TOOLS = ['email', 'calendar'] as const
// obj 900620: `mcp` = the remote MCP servers connected for the chat's
// workspace in Settings → Integrations. Opt-in per agent file, so no existing
// agent gains a tool it did not list.
export const MCP_TOOLS = ['mcp'] as const
// obj 900671: the public web. `web_search` asks a search backend configured on
// the install; `web_fetch` reads one public page through the SSRF-guarded
// fetch. Opt-in like every other tool (or via "all tools").
export const WEB_TOOLS = ['web_search', 'web_fetch'] as const

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...KNOWLEDGE_TOOLS,
  ...BOARD_TOOLS,
  ...CONNECTOR_TOOLS,
  ...MCP_TOOLS,
  ...WEB_TOOLS,
])

/**
 * "All tools" (obj 900671). An agent file may say `tools: [all]` (or `*`), and
 * the bot page has an "All tools" switch. Either way the bot gets every tool in
 * KNOWN_TOOL_NAMES — including tools added in later releases — without its
 * file being edited again. Email and calendar stay draft-only and board reads
 * stay limited to what the chatting person can see: "all" widens WHICH tools a
 * bot has, never what a tool may do.
 */
export const ALL_TOOLS_TOKENS: ReadonlySet<string> = new Set(['all', '*'])

export function listsAllTools(tools: readonly string[]): boolean {
  return tools.some(t => ALL_TOOLS_TOKENS.has(t.trim().toLowerCase()))
}

export type ToolGroup = 'web' | 'knowledge' | 'board' | 'connectors' | 'integrations'

export interface ToolCatalogEntry {
  name: string
  label: string
  description: string
  group: ToolGroup
}

/** What the bot page shows for each tool, in display order. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: 'web_search', label: 'Web search', description: 'Search the public web for current information.', group: 'web' },
  { name: 'web_fetch', label: 'Read web pages', description: 'Open one public web page and read its text.', group: 'web' },
  { name: 'search', label: 'Search knowledge', description: 'Search the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'list_folders', label: 'Browse knowledge', description: 'List files in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'read_file', label: 'Read notes', description: 'Read a text file in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'write_doc', label: 'Write notes', description: 'Create or replace a note in the bot’s knowledge folders.', group: 'knowledge' },
  { name: 'file_answer', label: 'Save answers to the wiki', description: 'Save a useful answer as a wiki page.', group: 'knowledge' },
  { name: 'create_objective', label: 'File board cards', description: 'Hand a bigger job to the board as a card.', group: 'board' },
  { name: 'get_objective', label: 'Read a card', description: 'Read one board card the person can see.', group: 'board' },
  { name: 'list_objectives', label: 'List cards', description: 'List board cards the person can see.', group: 'board' },
  { name: 'board_briefing', label: 'Board briefing', description: 'What is waiting on the person across their boards.', group: 'board' },
  { name: 'email', label: 'Email (drafts only)', description: 'Read the inbox and draft replies. Nothing is sent without a click.', group: 'connectors' },
  { name: 'calendar', label: 'Calendar (drafts only)', description: 'Read the calendar and draft events. Nothing is added without a click.', group: 'connectors' },
  { name: 'mcp', label: 'Workspace integrations (MCP)', description: 'Tools from the MCP servers connected to the workspace.', group: 'integrations' },
]
