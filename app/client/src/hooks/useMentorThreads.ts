import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MentorThread,
  MentorThreadOutput,
  CreateMentorThreadRequest,
  UpdateMentorThreadRequest,
  PostMentorMessageResponse,
  SessionMessage,
  MentorSessionState,
} from '@operationkit/shared'
import { api } from '../lib/api'

export function useMentorThreads() {
  const [threads, setThreads] = useState<MentorThread[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await api.get<MentorThread[]>('/mentor/threads')
      setThreads(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load threads')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createThread = useCallback(async (data: CreateMentorThreadRequest = {}) => {
    const created = await api.post<MentorThread>('/mentor/threads', data)
    setThreads(prev => [created, ...prev.filter(t => t.id !== created.id)])
    return created
  }, [])

  const updateThread = useCallback(async (id: number, data: UpdateMentorThreadRequest) => {
    const updated = await api.patch<MentorThread>(`/mentor/threads/${id}`, data)
    setThreads(prev => prev.map(t => (t.id === id ? updated : t)))
    return updated
  }, [])

  const archiveThread = useCallback(async (id: number) => {
    await updateThread(id, { archived: true })
    setThreads(prev => prev.filter(t => t.id !== id))
  }, [updateThread])

  const deleteThread = useCallback(async (id: number) => {
    await api.del<void>(`/mentor/threads/${id}`)
    setThreads(prev => prev.filter(t => t.id !== id))
  }, [])

  return {
    threads,
    loading,
    error,
    refresh,
    createThread,
    updateThread,
    archiveThread,
    deleteThread,
    setThreads,
  }
}

interface UseMentorOutputResult {
  messages: SessionMessage[]
  state: MentorSessionState
  loading: boolean
  error: string | null
  sendMessage: (content: string, filePaths?: string[]) => Promise<PostMentorMessageResponse>
  stopSession: () => Promise<void>
}

const POLL_INTERVAL_MS = 2000
// The api client resolves everything under this prefix; EventSource needs the
// same-origin URL (the httpOnly JWT cookie rides along automatically on GET).
const API_BASE = '/api'

/**
 * Live transcript + state for one thread. Prefers a near-instant SSE stream
 * (`GET /mentor/threads/:id/stream`, `snapshot` + `update` events) and falls
 * back to the legacy 2s `/output` poll if EventSource is unavailable or errors.
 * Pauses entirely when threadId is null. The send call returns the updated
 * thread row but does NOT optimistically push into messages — the stream (or a
 * poll) picks up both the user follow-up and the assistant reply from the log.
 */
export function useMentorOutput(threadId: number | null): UseMentorOutputResult {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [state, setState] = useState<MentorSessionState>('idle')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef(false)

  const fetchOutput = useCallback(async (id: number) => {
    try {
      const data = await api.get<MentorThreadOutput>(`/mentor/threads/${id}/output`)
      if (cancelRef.current) return
      setMessages(data.messages || [])
      setState(data.state || 'idle')
      setError(null)
    } catch (err) {
      if (cancelRef.current) return
      setError(err instanceof Error ? err.message : 'failed to load transcript')
    }
  }, [])

  useEffect(() => {
    cancelRef.current = false
    if (threadId === null) {
      setMessages([])
      setState('idle')
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setMessages([])

    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let closed = false

    const clearedLoading = () => {
      if (!cancelRef.current) setLoading(false)
    }

    // Fallback: the exact legacy 2s poll. Used when SSE is unavailable/errors.
    const startPolling = () => {
      if (closed || pollTimer) return
      fetchOutput(threadId).finally(clearedLoading)
      pollTimer = setInterval(() => fetchOutput(threadId), POLL_INTERVAL_MS)
    }

    const applyPayload = (raw: string) => {
      if (cancelRef.current) return
      try {
        const data = JSON.parse(raw) as { state?: MentorSessionState; messages?: SessionMessage[] }
        if (Array.isArray(data.messages)) setMessages(data.messages)
        if (data.state) setState(data.state)
        setError(null)
      } catch {
        /* ignore malformed frame; the next one replaces it wholesale */
      }
    }

    if (typeof EventSource !== 'undefined') {
      try {
        es = new EventSource(`${API_BASE}/mentor/threads/${threadId}/stream`, { withCredentials: true })
        // `snapshot` carries { thread, state, messages }; `update` carries { state, messages }.
        es.addEventListener('snapshot', (e) => { applyPayload((e as MessageEvent).data); clearedLoading() })
        es.addEventListener('update', (e) => applyPayload((e as MessageEvent).data))
        es.onerror = () => {
          // EventSource auto-reconnects on transient errors; only fall back once
          // the browser has given up (readyState CLOSED). Don't spam reconnects.
          if (es && es.readyState === EventSource.CLOSED) {
            es.close()
            es = null
            startPolling()
          }
        }
      } catch {
        es = null
        startPolling()
      }
    } else {
      startPolling()
    }

    return () => {
      cancelRef.current = true
      closed = true
      if (es) es.close()
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [threadId, fetchOutput])

  const sendMessage = useCallback(async (content: string, filePaths?: string[]): Promise<PostMentorMessageResponse> => {
    if (threadId === null) throw new Error('no thread selected')
    const body: { content: string; filePaths?: string[] } = { content }
    if (filePaths && filePaths.length > 0) body.filePaths = filePaths
    const res = await api.post<PostMentorMessageResponse>(`/mentor/threads/${threadId}/messages`, body)
    // Nudge an immediate refresh so the follow-up appears fast even if the SSE
    // frame is momentarily delayed; the stream still replaces messages wholesale.
    void fetchOutput(threadId)
    return res
  }, [threadId, fetchOutput])

  const stopSession = useCallback(async (): Promise<void> => {
    if (threadId === null) return
    await api.post<MentorThread>(`/mentor/threads/${threadId}/stop`)
    void fetchOutput(threadId)
  }, [threadId, fetchOutput])

  return { messages, state, loading, error, sendMessage, stopSession }
}
