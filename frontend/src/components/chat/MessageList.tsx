import { useEffect, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ShieldAlert } from 'lucide-react'

import { SecretSpan, SecretsContext, markdownComponents } from '@/components/chat/CodeAndSecrets'
import { InfoLine } from '@/components/chat/InfoLine'
import { AuthImage } from '@/components/AuthImage'
import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import { renderMarked } from '@/lib/marks'
import { href } from '@/lib/route'
import { remarkRestored } from '@/lib/remark-restored'
import { SECRET_KINDS, secretsFrom } from '@/lib/secrets'
import { cn, formatTokens } from '@/lib/utils'
import type { ChatMessage, ModelInfo } from '@/lib/types'

interface Props {
  messages: ChatMessage[]
  models: ModelInfo[]
  selectedId: string | null
  onInspect: (messageId: string | null) => void
  onContinue: (messageId: string) => void
  busy: boolean
}

function Reply({ m }: { m: ChatMessage }) {
  const restored = useMemo(
    () =>
      m.marks
        .filter((f) => f.placeholder && f.start != null && f.end != null)
        .map((f) => ({ value: m.content.slice(f.start!, f.end!), placeholder: f.placeholder! })),
    [m.marks, m.content],
  )
  const plugins = useMemo(() => [remarkGfm, remarkRestored(restored)], [restored])
  const secrets = useMemo(() => secretsFrom(m.content, m.marks), [m.content, m.marks])
  return (
    <SecretsContext.Provider value={secrets}>
      <div className={cn('prose-reply', m.streaming && 'streaming')}>
        <Markdown remarkPlugins={plugins} components={markdownComponents}>
          {m.content}
        </Markdown>
      </div>
    </SecretsContext.Provider>
  )
}

export function MessageList({ messages, models, selectedId, onInspect, onContinue, busy }: Props) {
  const { styles } = useAppData()
  const styleLabel = (id: string) => styles.find((s) => s.id === id)?.label ?? id
  const endRef = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, last?.content, last?.status])

  const lastId = messages.at(-1)?.id
  // For each reply, the model of the reply before it, to mark where the user switched models.
  const prevModelOf = useMemo(() => {
    const out = new Map<string, string | null>()
    let prev: string | null = null
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      out.set(m.id, prev)
      if (m.status !== 'blocked') prev = m.model_id
    }
    return out
  }, [messages])

  return (
    <div className="mx-auto max-w-[44rem] px-4 pb-8 pt-6 sm:px-6">
      {messages.map((m) => {
        if (m.role === 'user') {
          const blocked = m.status === 'blocked'
          return (
            <div key={m.id} className="mt-8 flex flex-col items-end gap-1.5 first:mt-0">
              {m.attachments.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  {m.attachments.map((a) => (
                    <div key={a.id}>
                      <AuthImage
                        id={a.id}
                        link
                        alt={`Attached image, ${a.width}×${a.height}`}
                        className="block max-h-48 max-w-[16rem] rounded-lg border border-border object-cover"
                        style={{ aspectRatio: `${a.width} / ${a.height}`, width: Math.min(256, (192 * a.width) / a.height) }}
                      />
                      <span className="mt-0.5 block text-right text-[11px] text-muted-foreground">
                        {formatTokens(a.tokens)} tokens
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {m.content && (
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm px-4 py-2.5 text-[15px] leading-relaxed',
                    blocked ? 'border border-dashed border-danger/50 bg-surface text-muted-foreground' : 'bg-muted',
                  )}
                >
                  {renderMarked(m.content, m.marks, (f, value) =>
                    SECRET_KINDS.has(f.kind) ? (
                      <SecretSpan
                        secret={{ value, kind: f.kind, placeholder: f.placeholder ?? '' }}
                        className="border-0 bg-transparent px-0"
                      />
                    ) : (
                      value
                    ),
                  )}
                </div>
              )}
              {m.styles.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1">
                  {m.styles.map((s) => (
                    <span key={s} className="rounded bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-ink/80">
                      {styleLabel(s)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        }

        const model = byId.get(m.model_id ?? '')
        const prevModel = prevModelOf.get(m.id) ?? null
        const switched = prevModel !== null && m.model_id !== prevModel && m.status !== 'blocked'
        const marks = m.marks.filter((f) => f.placeholder)
        return (
          <div key={m.id}>
            {switched && (
              <div className="mt-8 flex items-center gap-3 text-xs text-muted-foreground" role="separator">
                <span className="h-px flex-1 bg-border" />
                Switched to {model?.name ?? m.model_id}. It received the whole conversation so far.
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div className="mt-6">
              {m.status === 'blocked' ? (
                <div role="alert" className="flex gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-sm">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                  <div>
                    <p className="font-medium text-danger">Not sent</p>
                    <p className="mt-0.5 leading-relaxed text-ink/80">{m.error}</p>
                    <p className="mt-1.5 text-[13px] text-muted-foreground">
                      The blocked value was never sent to the model, and Sift didn't keep it.{' '}
                      <a href={href({ page: 'skills', id: 'pipeline' })} className="font-medium text-primary underline-offset-2 hover:underline">
                        Review privacy settings
                      </a>
                    </p>
                  </div>
                </div>
              ) : m.content || !m.streaming ? (
                <Reply m={m} />
              ) : (
                <div className="prose-reply">
                  <span className="caret" />
                </div>
              )}
              {m.status === 'error' && (
                <p role="alert" className="mt-3 rounded-md border border-danger/40 px-3 py-2 text-sm text-danger">
                  {m.content ? `The reply stopped partway: ${m.error?.replace(/\.$/, '')}.` : m.error} Send your message again, or
                  switch models.
                </p>
              )}
              {m.truncated && !m.streaming && m.status === 'done' && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-cost/40 bg-cost/5 px-3 py-2 text-[13px]">
                  <span>This reply hit its length limit and stopped early.</span>
                  {m.id === lastId && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onContinue(m.id)}>
                      Continue
                    </Button>
                  )}
                </div>
              )}
              {marks.length > 0 && !m.streaming && (
                <p className="mt-2 text-xs text-muted-foreground">
                  <span className="pii-restored">Highlighted</span> values were hidden from the model and restored for you:{' '}
                  {[...new Set(marks.map((f) => f.placeholder))].join(', ')}.
                </p>
              )}
              <InfoLine
                message={m}
                model={model}
                selected={selectedId === m.id}
                onInspect={() => onInspect(selectedId === m.id ? null : m.id)}
              />
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

