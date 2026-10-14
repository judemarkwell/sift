import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatTokens } from '@/lib/utils'
import type { ChatMessage, ModelInfo } from '@/lib/types'

interface Props {
  messages: ChatMessage[]
  model?: ModelInfo
  isStreaming: boolean
  prefill: string | null
  onPrefillUsed: () => void
  onSend: (text: string) => void
  onStop: () => void
}

/** Same rough estimate as the backend: ~4 characters per token plus per-message overhead. */
const estimate = (text: string) => (text ? Math.ceil(text.length / 4) + 4 : 0)

export function Composer({ messages, model, isStreaming, prefill, onPrefillUsed, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (prefill === null) return
    setText(prefill)
    onPrefillUsed()
    ref.current?.focus()
  }, [prefill, onPrefillUsed])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const contextTokens =
    messages.filter((m) => m.status !== 'error').reduce((n, m) => n + estimate(m.content), 0) + estimate(text)
  const windowSize = model?.context_window ?? 1
  const pct = Math.min(100, (contextTokens / windowSize) * 100)

  const submit = () => {
    if (!text.trim() || isStreaming) return
    onSend(text)
    setText('')
  }

  return (
    <div className="mx-auto w-full max-w-[42rem] px-6 pb-5">
      <div className="rounded-xl border border-border bg-surface shadow-[0_1px_0_rgb(28_36_48/0.04)] focus-within:border-primary/60">
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={model ? `Message ${model.name}` : 'Message'}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-4 px-3 pb-3 pt-1">
          <div
            className="flex min-w-0 items-center gap-2.5 pl-1 text-xs text-muted-foreground"
            title="Estimated tokens the next request will send, out of this model's context window"
          >
            <div
              className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label="Context used"
              aria-valuenow={Math.round(pct * 10) / 10}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(pct, contextTokens ? 2 : 0)}%` }} />
            </div>
            <span className="truncate">
              ~{formatTokens(contextTokens)} of {formatTokens(windowSize)} tokens
            </span>
          </div>
          {isStreaming ? (
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square className="fill-current" /> Stop
            </Button>
          ) : (
            <Button size="icon" className="size-8 rounded-lg" onClick={submit} disabled={!text.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
        {model?.live
          ? `${model.name} is a real model. Each message is billed to the Sift account.`
          : 'Mock model. Replies are simulated and cost nothing.'}
      </p>
    </div>
  )
}
