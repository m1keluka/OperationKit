import { useCallback, useEffect, useState } from 'react'
import type { ThreadFolder } from '@operationkit/shared'

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { credentials: 'include', ...init })
  if (!res.ok) {
    let message = `${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {}
    throw new Error(message)
  }
  return (await res.json()) as T
}

export function useMentorFolders() {
  const [folders, setFolders] = useState<ThreadFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await jsonFetch<ThreadFolder[]>('/api/mentor/folders')
      setFolders(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load folders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const createFolder = useCallback(async (title: string): Promise<ThreadFolder> => {
    const folder = await jsonFetch<ThreadFolder>('/api/mentor/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    setFolders(prev => [...prev, folder])
    return folder
  }, [])

  const renameFolder = useCallback(async (id: number, title: string) => {
    await jsonFetch<ThreadFolder>(`/api/mentor/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    setFolders(prev => prev.map(f => f.id === id ? { ...f, title } : f))
  }, [])

  const deleteFolder = useCallback(async (id: number) => {
    await fetch(`/api/mentor/folders/${id}`, { method: 'DELETE', credentials: 'include' })
    setFolders(prev => prev.filter(f => f.id !== id))
  }, [])

  const moveThread = useCallback(async (threadId: number, folderId: number | null) => {
    await jsonFetch<unknown>(`/api/mentor/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId }),
    })
  }, [])

  return { folders, loading, error, refresh, createFolder, renameFolder, deleteFolder, moveThread }
}
