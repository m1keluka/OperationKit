// @vitest-environment jsdom
//
// obj 701701 — proves the in-thread assistant name is dynamic: MessageList
// renders the passed `assistantName` in the empty state and thinking indicator,
// and falls back to 'Jarvis' when the prop is omitted (unset/loading config).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// GroupedMessages is irrelevant to these strings; stub it to keep the test focused.
vi.mock('../SessionMessages', () => ({ GroupedMessages: () => null }))

import { MessageList } from './MessageList'
import type { SessionMessage, MentorSessionState } from '@command-center/shared'

describe('MessageList dynamic assistant name (obj 701701)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('uses the configured name in the empty-state prompt', () => {
    flushSync(() => root.render(
      <MessageList messages={[]} state={'idle' as MentorSessionState} loading={false} assistantName="Ada" />,
    ))
    expect(container.textContent).toContain('Ada reads the vault and pushes back.')
    expect(container.textContent).not.toContain('Jarvis')
  })

  it('uses the configured name in the thinking indicator', () => {
    // Non-empty via pendingUser so the working indicator (not the empty state) renders.
    flushSync(() => root.render(
      <MessageList
        messages={[] as SessionMessage[]}
        state={'working' as MentorSessionState}
        loading={false}
        pendingUser="hello"
        assistantName="Ada"
      />,
    ))
    expect(container.textContent).toContain('Ada is thinking…')
  })

  it("falls back to 'Jarvis' when assistantName is omitted", () => {
    flushSync(() => root.render(
      <MessageList messages={[]} state={'idle' as MentorSessionState} loading={false} />,
    ))
    expect(container.textContent).toContain('Jarvis reads the vault and pushes back.')
  })
})
