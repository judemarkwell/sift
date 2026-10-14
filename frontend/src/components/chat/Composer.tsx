import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ShieldAlert, ShieldCheck, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { markClass } from '@/lib/marks'
import { href } from '@/lib/route'
import { EXPECTED_OUTPUT_TOKENS, cn, estimateTokens, formatCost, formatTokens } from '@/lib/utils'
import type { ChatMessage, Finding, ModelInfo } from '@/lib/types'

interface Props {
  messages: ChatMessage[]
  model?: ModelInfo
  isStreaming: boolean
  prefill: string | null
  onPrefillUsed: () => void
  onSend: (text: string) => Promise<string | undefined>
  onStop: () => void
  autoFocus?: boolean
}

function usePiiScan(text: string) {
  const [state, setState] = useState<{ text: string; findings: Finding[]; enabled: boolean }>({
    text: '',
    findings: [],
    enabled: true,
  })
  useEffect(() => {
    if (!text.trim()) {
      setState({ text, findings: [], enabled: true })
      return
    }
    const t = setTimeout(() => {
      api
        .scan(text)
        .then((r) => setState({ text, findings: r.findings, enabled: r.enabled }))
        .catch(() => setState({ text, findings: [], enabled: true }))
    }, 220)
    return () => clearTimeout(t)
  }, [text])
  // Findings are only valid for the exact text they were computed on.
  return state.text === text ? state : { text, findings: [], enabled: state.enabled }
}

/** 'Email address' -> 'email address', but 'API key' stays as is. */
const lowerLabel = (l: string) => (l.length > 1 && l[1] === l[1].toUpperCase() && /[A-Z]/.test(l[1]) ? l : l[0].toLowerCase() + l.slice(1))

function summarize(findings: Finding[], action: Finding['action']) {
  const labels = [...new Set(findings.filter((f) => f.action === action).map((f) => lowerLabel(f.label)))]
  return labels
}

export function Composer({ messages, model, isStreaming, prefill, onPrefillUsed, onSend, onStop, autoFocus }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const scan = usePiiScan(text)

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
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const history = messages.filter((m) => m.status === 'done' && !m.streaming)
  const inputTokens = history.reduce((n, m) => n + estimateTokens(m.content), 0) + estimateTokens(text)
  const windowSize = model?.context_window ?? 1
  const pct = Math.min(100, (inputTokens / windowSize) * 100)
  const forecast = model
    ? (inputTokens * model.input_price_per_mtok + EXPECTED_OUTPUT_TOKENS * model.output_price_per_mtok) / 1_000_000
    : 0

  const blocked = summarize(scan.findings, 'block')
  const redacted = summarize(scan.findings, 'redact')
  const warned = summarize(scan.findings, 'warn')
  const canSend = !!text.trim() && !isStreaming && blocked.length === 0

  const submit = async () => {
    if (!canSend) return
    const sent = text
    setText('')
    const restore = await onSend(sent)
    if (restore) setText(restore) // refused before sending: give the text back
  }

  return (
    <div className="mx-auto w-full max-w-[44rem] px-4 pb-4 sm:px-6">
      {(blocked.length > 0 || redacted.length > 0 || warned.length > 0) && (
        <div
          className={cn(
            'mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-snug',
            blocked.length ? 'border-danger/40 bg-danger/5 text-danger' : 'border-border bg-surface text-muted-foreground',
          )}
          role="status"
        >
          {blocked.length ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />}
          <p>
            {blocked.length > 0 && (
              <>
                Your policy blocks {blocked.join(', ')}. Remove it to send, or{' '}
                <a className="font-medium underline" href={href({ page: 'skills' })}>
                  change the policy
                </a>
                .{' '}
              </>
            )}
            {!blocked.length && redacted.length > 0 && (
              <>
                <span className="text-ink">Will replace {redacted.join(', ')}</span> with placeholders before sending.{' '}
              </>
            )}
            {!blocked.length && warned.length > 0 && <>Sending {warned.join(', ')} as-is.</>}
          </p>
        </div>
      )}
      <div
        className={cn(
          'rounded-xl border bg-surface shadow-[0_1px_0_rgb(28_36_48/0.04)]',
          blocked.length ? 'border-danger/50' : 'border-border focus-within:border-primary/60',
        )}
      >
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <div className="relative">
          {/* Highlights drawn behind the transparent textarea, aligned character for character. */}
          <div
            ref={backdrop}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-transparent"
          >
            {renderBackdrop(text, scan.findings)}
          </div>
          <textarea
            id="composer"
            ref={ref}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = e.currentTarget.scrollTop)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={model ? `Message ${model.name}` : 'Message'}
            className="relative block w-full resize-none break-words bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center justify-between gap-4 px-3 pb-3 pt-1">
          <div className="flex min-w-0 items-center gap-3 pl-1 text-xs text-muted-foreground">
            <div
              className="flex items-center gap-2"
              title="Estimated tokens the next request will send, out of this model's context window"
            >
              <div
                className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Context used"
                aria-valuenow={Math.round(pct * 10) / 10}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(pct, inputTokens ? 3 : 0)}%` }} />
              </div>
              <span className="whitespace-nowrap">~{formatTokens(inputTokens)} tokens</span>
            </div>
            {model && text.trim() && (
              <span
                className="truncate whitespace-nowrap"
                title={`Estimate: ~${formatTokens(inputTokens)} tokens in, ~${EXPECTED_OUTPUT_TOKENS} out`}
              >
                {model.live ? <>≈ <span className="text-cost">{formatCost(forecast)}</span> to send</> : 'Free to send (mock)'}
              </span>
            )}
          </div>
          {isStreaming ? (
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square className="fill-current" /> Stop
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 rounded-lg"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
        {model?.live
          ? `${model.name} is a real model. Usage comes out of your plan.`
          : 'Mock model. Replies are simulated and cost nothing.'}
      </p>
    </div>
  )
}

function renderBackdrop(text: string, findings: Finding[]) {
  const spans = findings.filter((f) => f.start != null && f.end != null).sort((a, b) => a.start! - b.start!)
  const out: ReactNode[] = []
  let cursor = 0
  spans.forEach((f, i) => {
    if (f.start! < cursor) return
    out.push(text.slice(cursor, f.start!))
    out.push(
      <mark key={i} className={cn(markClass(f.action), 'text-transparent')}>
        {text.slice(f.start!, f.end!)}
      </mark>,
    )
    cursor = f.end!
  })
  out.push(text.slice(cursor))
  // A trailing newline needs a character after it to take up height.
  out.push('​')
  return out
}
