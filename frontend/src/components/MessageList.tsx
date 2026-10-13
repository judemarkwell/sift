import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { InfoLine } from '@/components/InfoLine'
import { cn } from '@/lib/utils'
import type { ChatMessage, ModelInfo } from '@/lib/types'

interface Props {
  messages: ChatMessage[]
  models: ModelInfo[]
  selectedTraceId: string | null
  onInspect: (messageId: string) => void
  onSuggest: (text: string) => void
}

const SUGGESTIONS = [
  'How should I plan a small AWS project?',
  'Compare two approaches to caching /long',
  'Test what a provider failure looks like /error',
]

export function MessageList({ messages, models, selectedTraceId, onInspect, onSuggest }: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, last?.content, last?.status])

  if (messages.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-[42rem] flex-col justify-center px-6 pb-16">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.01em]">
          Ask anything. See everything it took.
        </h1>
        <p className="mt-3 max-w-[34rem] text-[15px] leading-relaxed text-muted-foreground">
          Every reply shows its tokens, cost and timing. Open a reply's trace to see exactly what was sent and
          each step it passed through.
        </p>
        <div className="mt-8 flex flex-col items-start gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggest(s)}
              className="rounded-md border border-border bg-surface px-3.5 py-2 text-left text-sm hover:border-primary/50 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[42rem] px-6 pb-8 pt-6">
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="mt-8 flex justify-end first:mt-0">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-muted px-4 py-2.5 text-[15px] leading-relaxed">
              {m.content}
            </div>
          </div>
        ) : (
          <div key={m.id} className="mt-6">
            {m.content ? (
              <div className={cn('prose-reply', m.status === 'streaming' && 'streaming')}>
                <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
              </div>
            ) : (
              m.status === 'streaming' && <div className="prose-reply"><span className="caret" /></div>
            )}
            {m.status === 'error' && (
              <p role="alert" className="mt-3 rounded-md border border-danger/40 px-3 py-2 text-sm text-danger">
                The reply stopped partway: {m.error?.replace(/\.$/, '')}. Send your message again, or switch to another
                model.
              </p>
            )}
            <InfoLine
              message={m}
              model={models.find((x) => x.id === m.modelId)}
              selected={selectedTraceId === m.id}
              onInspect={() => onInspect(selectedTraceId === m.id ? '' : m.id)}
            />
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  )
}
