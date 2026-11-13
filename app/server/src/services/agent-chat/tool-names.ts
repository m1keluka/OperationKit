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
// obj 900749: use a named secret through the broker (secrets_list, secret_http).
// The bot names a secret; the server injects the value into the outbound HTTPS
// request and redacts the reply. The value never reaches the model, the chat
// history or a log.
export const SECRET_TOOLS = ['secrets'] as const

/**
 * Tools "All tools" does NOT grant (obj 900749). A bot gets one only when it is
 * named — in the agent file (`tools: [all, secrets]` works) or ticked on the bot
 * page — so switching on "All tools" never also hands a bot your credentials.
 */
export const EXPLICIT_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([...SECRET_TOOLS])

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...KNOWLEDGE_TOOLS,
  ...BOARD_TOOLS,
  ...CONNECTOR_TOOLS,
  ...MCP_TOOLS,
  ...WEB_TOOLS,
  ...SECRET_TOOLS,
])

/** What "All tools" grants: every known tool except the explicit-only ones. */
export const ALL_TOOLS_GRANT: ReadonlySet<string> = new Set<string>([...KNOWN_TOOL_NAMES].filter(t => !EXPLICIT_ONLY_TOOLS.has(t)))

/**
 * "All tools" (obj 900671). An agent file may say `tools: [all]` (or `*`), and
 * the bot page has an "All tools" switch. Either way the bot gets every tool in
 * ALL_TOOLS_GRANT — including tools added in later releases — without its
 * file being edited again. Explicit-only tools (secret use) are the exception. Email and calendar stay draft-only and board reads
 * stay limited to what the chatting person can see: "all" widens WHICH tools a
 * bot has, never what a tool may do.
 */
export const ALL_TOOLS_TOKENS: ReadonlySet<string> = new Set(['all', '*'])

export function listsAllTools(tools: readonly string[]): boolean {
  return tools.some(t => ALL_TOOLS_TOKENS.has(t.trim().toLowerCase()))
}

export type ToolGroup = 'web' | 'knowledge' | 'board' | 'connectors' | 'integrations' | 'secrets'

export interface ToolCatalogEntry {
  name: string
  label: string
  description: string
  group: ToolGroup
  /** Not included by "All tools"; must be ticked on its own (obj 900749). */
  explicit_only?: boolean
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
  { name: 'secrets', label: 'Use secrets by name', description: 'Call an API with a named secret. The server adds the key; the bot never sees it. Only hosts allowed in Settings → Secrets.', group: 'secrets', explicit_only: true },
]
