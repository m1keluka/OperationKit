import { useEffect, useRef, useCallback, useState } from 'react'
import type { ServerMessage, ClientMessage } from '@command-center/shared'

type MessageHandler = (msg: ServerMessage) => void
export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected'

export function useWebSocket(onMessage: MessageHandler, scope?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<ConnectionState>('reconnecting')
  const handlersRef = useRef<MessageHandler>(onMessage)
  handlersRef.current = onMessage
  // Latest view-scope, read at (re)connect time so the socket is scoped from the
  // very first byte (view-leak fix, obj 700082). A ref — not an effect dep —
  // because the socket persists across workspace switches (set_view_scope handles
  // those); only fresh connects/reconnects need to pick up the current scope.
  const scopeRef = useRef<string | undefined>(scope)
  scopeRef.current = scope
  const retryRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    function connect() {
      if (!mountedRef.current) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const s = scopeRef.current
      const query = s && s !== 'all' ? `?workspace=${encodeURIComponent(s)}` : ''
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws${query}`)
      wsRef.current = ws

      ws.onopen = () => {
        retryRef.current = 0
        setState('connected')
      }
      ws.onclose = () => {
        if (!mountedRef.current) return
        retryRef.current += 1
        if (retryRef.current >= 5) {
          setState('disconnected')
        } else {
          setState('reconnecting')
        }
        // Exponential backoff capped at 30s
        const delay = Math.min(2000 * 2 ** Math.max(0, retryRef.current - 1), 30000)
        retryTimerRef.current = setTimeout(connect, delay)
      }
      ws.onerror = () => {
        // onclose will fire after this; nothing to do here.
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage
          handlersRef.current(msg)
        } catch {
          // Ignore malformed messages
        }
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  // Backward-compatible boolean for callers that just want truthy/falsy.
  const connected = state === 'connected'

  return { send, connected, state, ws: wsRef }
}
