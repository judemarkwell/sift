import { useCallback, useEffect, useRef, useState } from 'react'

import { defaultModelId, useAppData } from '@/hooks/useAppData'
import { ApiError, api, streamChat } from '@/lib/api'
import { navigate } from '@/lib/route'
import type { ChatMessage, Trace } from '@/lib/types'

const tempId = () => `tmp_${crypto.randomUUID().slice(0, 8)}`

export interface ChatError {
  message: string
  code?: string
}

/** One conversation: loads it from the server, sends messages, and streams replies. */
export function useChat(conversationId: string | undefined) {
  const { models, refreshConversations, refreshMe } = useAppData()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [modelId, setModelId] = useState('')
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [sendError, setSendError] = useState<ChatError | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The id of the conversation currently in `messages`, so navigating to a
  // conversation we just created mid-stream doesn't reload and wipe it.
  const loadedRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!modelId && models.length) setModelId(defaultModelId(models))
  }, [models, modelId])

  useEffect(() => {
    setSendError(null)
    if (conversationId === loadedRef.current) return
    abortRef.current?.abort()
    setSelectedId(null)
    if (!conversationId) {
      loadedRef.current = undefined
      setMessages([])
      setNotFound(false)
      if (models.length) setModelId(defaultModelId(models))
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .conversation(conversationId)
      .then((conv) => {
        if (cancelled) return
        loadedRef.current = conv.id
        setMessages(conv.messages)
        setModelId(conv.model_id)
        setNotFound(false)
      })
      .catch(() => !cancelled && setNotFound(true))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [conversationId, models])

  const patch = useCallback((id: string, p: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)))
  }, [])

  const isStreaming = messages.some((m) => m.streaming)

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || isStreaming || !modelId) return
    setSendError(null)
    const now = new Date().toISOString()
    const userId = tempId()
    const replyId = tempId()
    const base = { created_at: now, model_id: modelId, status: 'done' as const, error: null, trace_id: null, marks: [] }
    setMessages((ms) => [
      ...ms,
      { ...base, id: userId, role: 'user', content, model_id: null },
      { ...base, id: replyId, role: 'assistant', content: '', streaming: true },
    ])

    const controller = new AbortController()
    abortRef.current = controller
    let convId = loadedRef.current
    let userMsgId = userId
    try {
      await streamChat(
        { conversation_id: loadedRef.current ?? null, model: modelId, message: content },
        (ev) => {
          switch (ev.type) {
            case 'conversation':
              if (!loadedRef.current) {
                convId = ev.conversation_id
                loadedRef.current = ev.conversation_id
                navigate({ page: 'chat', id: ev.conversation_id }, true)
              }
              patch(userId, { id: ev.user_message_id })
              userMsgId = ev.user_message_id
              break
            case 'start':
              patch(replyId, { trace_id: ev.trace_id, context: ev.context, livePipeline: ev.pipeline })
              patch(userMsgId, { marks: ev.prompt_marks })
              void refreshConversations()
              break
            case 'delta':
              patch(replyId, (m) => ({ content: m.content + ev.text }))
              break
            case 'done':
            case 'error':
              setMessages((ms) =>
                ms.map((m) => {
                  if (m.id === replyId) return { ...ev.message, trace: ev.trace }
                  if (m.id === userMsgId) return { ...ev.user_message }
                  return m
                }),
              )
              break
          }
        },
        controller.signal,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patch(replyId, { streaming: false, status: 'error', error: 'Stopped before the reply finished.' })
      } else {
        // Refused before streaming (plan limits, budget): nothing was saved, so undo the optimistic messages.
        setMessages((ms) => ms.filter((m) => m.id !== userMsgId && m.id !== replyId))
        setSendError({ message: (err as Error).message, code: err instanceof ApiError ? err.code : undefined })
        return content
      }
    } finally {
      abortRef.current = null
      if (convId) void refreshConversations()
      void refreshMe()
    }
    return undefined
  }

  const stop = () => abortRef.current?.abort()

  const selected = messages.find((m) => m.id === selectedId && m.role === 'assistant') ?? null

  /** Open a reply's trace, fetching it if this message was loaded from history. */
  const inspect = async (messageId: string | null) => {
    setSelectedId(messageId)
    const m = messages.find((x) => x.id === messageId)
    if (m && !m.trace && m.trace_id && !m.streaming) {
      try {
        const trace: Trace = await api.trace(m.trace_id)
        patch(m.id, { trace })
      } catch {
        /* the panel shows its own empty state */
      }
    }
  }

  return {
    messages,
    modelId,
    setModelId,
    loading,
    notFound,
    isStreaming,
    sendError,
    clearSendError: () => setSendError(null),
    send,
    stop,
    selected,
    inspect,
  }
}
