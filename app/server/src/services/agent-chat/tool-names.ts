// Tool names an agent file may list under `tools:` (obj 719987). Shared with
// the agent-templates card: knowledge + board names match the MCP connector's
// tool names; `email` and `calendar` are connectors that only ever draft.
export const KNOWLEDGE_TOOLS = ['search', 'list_folders', 'read_file', 'write_doc', 'file_answer'] as const
export const BOARD_TOOLS = ['create_objective', 'get_objective', 'list_objectives'] as const
export const CONNECTOR_TOOLS = ['email', 'calendar'] as const

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([...KNOWLEDGE_TOOLS, ...BOARD_TOOLS, ...CONNECTOR_TOOLS])
