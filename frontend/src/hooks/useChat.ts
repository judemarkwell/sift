import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchModels, streamChat } from '@/lib/api'
import type { ChatMessage, Conversation, ModelInfo } from '@/lib/types'

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`

function newConversation(modelId: string): Conversation {
  return { id: uid('conv'), title: 'New chat', modelId, messages: [], updatedAt: Date.now() }
}

export function useChat() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedTraceMsg, setSelectedTraceMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchModels()
      .then((list) => {
        setModels(list)
        const first = newConversation(list[0]?.id ?? '')
        setConversations([first])
        setActiveId(first.id)
      })
      .catch((err: Error) => setLoadError(err.message))
  }, [])

  const active = conversations.find((c) => c.id === activeId) ?? null
  const isStreaming = active?.messages.some((m) => m.status === 'streaming') ?? false

  const update = useCallback((convId: string, fn: (c: Conversation) => Conversation) => {
    setConversations((cs) => cs.map((c) => (c.id === convId ? fn(c) : c)))
  }, [])

  const patchMessage = useCallback(
    (convId: string, msgId: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) =>
      update(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === msgId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m,
        ),
      })),
    [update],
  )

  const setModel = (modelId: string) => active && update(active.id, (c) => ({ ...c, modelId }))

  const startNew = () => {
    const conv = newConversation(active?.modelId ?? models[0]?.id ?? '')
    setConversations((cs) => [conv, ...cs])
    setActiveId(conv.id)
    setSelectedTraceMsg(null)
  }

  const selectConversation = (id: string) => {
    setActiveId(id)
    setSelectedTraceMsg(null)
  }

  const send = async (text: string) => {
    if (!active || isStreaming || !text.trim()) return
    const conv = active
    const userMsg: ChatMessage = { id: uid('msg'), role: 'user', content: text.trim() }
    const reply: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: '',
      modelId: conv.modelId,
      status: 'streaming',
    }
    const history = [...conv.messages.filter((m) => m.status !== 'error'), userMsg]

    update(conv.id, (c) => ({
      ...c,
      title: c.messages.length === 0 ? userMsg.content.slice(0, 48) : c.title,
      messages: [...c.messages, userMsg, reply],
      updatedAt: Date.now(),
    }))

    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamChat(
        {
          conversation_id: conv.id,
          model: conv.modelId,
          messages: history.map(({ role, content }) => ({ role, content })),
        },
        (ev) => {
          switch (ev.type) {
            case 'start':
              patchMessage(conv.id, reply.id, { traceId: ev.trace_id, context: ev.context })
              break
            case 'delta':
              patchMessage(conv.id, reply.id, (m) => ({ content: m.content + ev.text }))
              break
            case 'done':
              patchMessage(conv.id, reply.id, { status: 'done', trace: ev.trace })
              break
            case 'error':
              patchMessage(conv.id, reply.id, { status: 'error', error: ev.message, trace: ev.trace })
              break
          }
        },
        controller.signal,
      )
    } catch (err) {
      const stopped = (err as Error).name === 'AbortError'
      patchMessage(conv.id, reply.id, {
        status: stopped ? 'done' : 'error',
        error: stopped ? 'Stopped before the reply finished.' : (err as Error).message,
      })
    } finally {
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const traceMessage =
    active?.messages.find((m) => m.id === selectedTraceMsg && m.role === 'assistant') ?? null

  return {
    models,
    loadError,
    conversations,
    active,
    isStreaming,
    traceMessage,
    setModel,
    startNew,
    selectConversation,
    send,
    stop,
    openTrace: setSelectedTraceMsg,
  }
}
