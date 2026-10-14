import { useCallback, useEffect, useRef, useState } from 'react'

import { defaultModelId, useAppData } from '@/hooks/useAppData'
import { ApiError, api, streamChat, type StreamEvent } from '@/lib/api'
import { navigate } from '@/lib/route'
import type { ChatMessage, ImageRef, StoredMessage, Trace } from '@/lib/types'

const tempId = () => `tmp_${crypto.randomUUID().slice(0, 8)}`

export interface ChatError {
  message: string
  code?: string
}

export interface SendOptions {
  styles?: string[]
  images?: ImageRef[]
  skillId?: string
  skillValues?: Record<string, string>
}

function blank(role: 'user' | 'assistant', content: string, modelId: string | null): ChatMessage {
  return {
    id: tempId(),
    role,
    content,
    created_at: new Date().toISOString(),
    model_id: modelId,
    status: 'done',
    error: null,
    trace_id: null,
    marks: [],
    previous_trace_ids: [],
    truncated: false,
    styles: [],
    attachments: [],
  }
}

/** One conversation: loads it from the server, sends messages, and streams replies. */
export function useChat(conversationId: string | undefined) {
  const { models, refreshConversations, refreshMe } = useAppData()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [modelId, setModelId] = useState('')
  const [skillName, setSkillName] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [sendError, setSendError] = useState<ChatError | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The conversation currently in `messages`, so navigating to a chat we just
  // created mid-stream doesn't reload and wipe it.
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
      setSkillName(null)
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
        setSkillName(conv.skill_name)
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

  /** Shared streaming loop for new messages and Continue. */
  const run = async (
    body: Parameters<typeof streamChat>[0],
    ids: { user: string | null; reply: string },
    onRefused: () => void,
  ): Promise<boolean> => {
    const controller = new AbortController()
    abortRef.current = controller
    let userId = ids.user
    try {
      await streamChat(
        body,
        (ev: StreamEvent) => {
          switch (ev.type) {
            case 'conversation':
              if (!loadedRef.current) {
                loadedRef.current = ev.conversation_id
                navigate({ page: 'chat', id: ev.conversation_id }, true)
              }
              if (ev.skill_name) setSkillName(ev.skill_name)
              if (userId && ev.user_message_id) {
                patch(userId, { id: ev.user_message_id, styles: ev.styles ?? [] })
                userId = ev.user_message_id
              }
              break
            case 'start':
              patch(ids.reply, { context: ev.context, livePipeline: ev.pipeline })
              if (userId) patch(userId, { marks: ev.prompt_marks })
              void refreshConversations()
              break
            case 'delta':
              patch(ids.reply, (m) => ({ content: m.content + ev.text }))
              break
            case 'done':
            case 'error': {
              const reply: StoredMessage = ev.message
              setMessages((ms) =>
                ms.map((m) => {
                  if (m.id === ids.reply) return { ...reply, trace: ev.trace, streaming: false }
                  if (userId && m.id === userId && ev.user_message) return { ...ev.user_message }
                  return m
                }),
              )
              if (ev.type === 'error' && body.continue_message_id) setSendError({ message: ev.error })
              break
            }
          }
        },
        controller.signal,
      )
      return true
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patch(ids.reply, { streaming: false, status: 'error', error: 'Stopped before the reply finished.' })
        return true
      }
      onRefused()
      setSendError({ message: (err as Error).message, code: err instanceof ApiError ? err.code : undefined })
      return false
    } finally {
      abortRef.current = null
      void refreshConversations()
      void refreshMe()
    }
  }

  /** Send a message. Returns false if the server refused it before streaming (so the composer can keep the text). */
  const send = async (text: string, opts: SendOptions = {}): Promise<boolean> => {
    const content = text.trim()
    const images = opts.images ?? []
    if ((!content && !images.length && !opts.skillId) || isStreaming || !modelId) return false
    setSendError(null)
    const user = { ...blank('user', content, null), styles: opts.styles ?? [], attachments: images }
    const reply = { ...blank('assistant', '', modelId), streaming: true }
    if (opts.skillId) user.content = '…'
    setMessages((ms) => [...ms, user, reply])
    return run(
      {
        conversation_id: loadedRef.current ?? null,
        model: modelId,
        message: content,
        styles: opts.styles,
        image_ids: images.map((i) => i.id),
        skill_id: opts.skillId,
        skill_values: opts.skillValues,
      },
      { user: user.id, reply: reply.id },
      () => setMessages((ms) => ms.filter((m) => m.id !== user.id && m.id !== reply.id)),
    )
  }

  /** Ask the model to pick up a cut-off reply where it stopped; the text is appended in place. */
  const continueReply = async (messageId: string) => {
    if (isStreaming || !loadedRef.current) return
    const target = messages.find((m) => m.id === messageId)
    if (!target) return
    setSendError(null)
    const before = target
    patch(messageId, { streaming: true, truncated: false })
    await run(
      { conversation_id: loadedRef.current, model: modelId, continue_message_id: messageId },
      { user: null, reply: messageId },
      () => patch(messageId, { ...before, streaming: false }),
    )
  }

  const stop = () => abortRef.current?.abort()

  const selected = messages.find((m) => m.id === selectedId && m.role === 'assistant') ?? null

  /** Open a reply's trace, fetching it if this message was loaded from history. */
  const inspect = async (messageId: string | null) => {
    setSelectedId(messageId)
    const m = messages.find((x) => x.id === messageId)
    if (m && (!m.trace || m.trace.id !== m.trace_id) && m.trace_id && !m.streaming) {
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
    skillName,
    loading,
    notFound,
    isStreaming,
    sendError,
    clearSendError: () => setSendError(null),
    send,
    continueReply,
    stop,
    selected,
    inspect,
  }
}
