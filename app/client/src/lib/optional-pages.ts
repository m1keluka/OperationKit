/// <reference types="vite/client" />
/**
 * Pages that may or may not be in this build yet (obj 720115).
 *
 * Agent chat ships in its own change. Until that lands, the nav must not link to
 * a page that does not exist. `import.meta.glob` is resolved by Vite at build
 * time: when the file is missing the map is simply empty, so this module never
 * creates or imports the page itself — it only reports whether it is there.
 */
const chatPage = import.meta.glob('../components/agent-chat/AgentChatPage.tsx')

/** True when the agent chat page (served at /chat) is part of this build. */
export const HAS_CHAT_PAGE = Object.keys(chatPage).length > 0
