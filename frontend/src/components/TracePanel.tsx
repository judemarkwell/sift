import type { ReactNode } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn, formatCost, formatMs, formatTokens } from '@/lib/utils'
import type { ChatMessage, ModelInfo, PipelineStep, Trace } from '@/lib/types'

interface Props {
  message: ChatMessage
  model?: ModelInfo
  onClose: () => void
}

type StageKey = PipelineStep['stage']

/** Plugins that will slot into each stage later. Shown as "off" so the pipeline's shape is visible now. */
const PLANNED: Record<StageKey, { name: string; detail: string }[]> = {
  'pre-request': [{ name: 'PII redaction', detail: 'Off. Will hide emails, phone numbers and IDs before sending.' }],
  provider: [],
  'post-response': [{ name: 'Source check', detail: 'Off. Will mark which claims are backed by your files.' }],
}

const STAGES: { key: StageKey; title: string }[] = [
  { key: 'pre-request', title: 'Before sending' },
  { key: 'provider', title: 'Model' },
  { key: 'post-response', title: 'After the reply' },
]

const SEGMENT_SHADES = ['bg-primary/35', 'bg-primary/60', 'bg-primary']

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'cost' }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-[17px] font-semibold', tone === 'cost' && 'text-cost')}>{value}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-5">
      <h3 className="mb-3.5 text-[13.5px] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

/** The memorable bit: the request drawn as a sieve, falling through each stage in order. */
function Sieve({ trace }: { trace: Trace }) {
  return (
    <ol className="relative">
      {/* the rail */}
      <span aria-hidden className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
      <span
        aria-hidden
        className="sieve-drop absolute left-[8px] top-3 size-[7px] rounded-full bg-primary"
      />
      {STAGES.map((stage) => {
        const steps = trace.pipeline.filter((s) => s.stage === stage.key)
        const planned = PLANNED[stage.key]
        return (
          <li key={stage.key} className="relative pb-4 pl-8 last:pb-0">
            <svg aria-hidden viewBox="0 0 24 24" className="absolute left-0 top-0.5 size-[23px] rounded-md bg-surface">
              <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" className="fill-surface stroke-border" />
              <path d="M6 8h12M8 12h8M10.5 16h3" className="stroke-primary" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="pt-0.5 text-xs text-muted-foreground">{stage.title}</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {steps.map((s) => (
                <li key={s.name} className="rounded-lg bg-muted px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13.5px] font-medium">{s.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatMs(s.duration_ms)}</span>
                  </div>
                  {s.detail && (
                    <p
                      className={cn(
                        'mt-0.5 text-[12.5px] leading-snug text-muted-foreground',
                        trace.response.finish_reason === 'error' && s.stage === 'provider' && 'text-danger',
                      )}
                    >
                      {s.detail}
                    </p>
                  )}
                </li>
              ))}
              {planned.map((p) => (
                <li key={p.name} className="rounded-lg border border-dashed border-border px-3 py-2">
                  <span className="text-[13.5px] font-medium text-muted-foreground">{p.name}</span>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{p.detail}</p>
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

export function TracePanel({ message, model, onClose }: Props) {
  const trace = message.trace
  if (!trace) return null
  const r = trace.response
  const ctx = trace.context

  return (
    <aside
      aria-label="Request trace"
      className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface md:w-[400px]"
    >
      <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Trace for this reply</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {model?.name ?? r.model}, {r.provider}. {new Date(trace.created_at).toLocaleTimeString()}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 size-8" onClick={onClose} aria-label="Close trace">
          <X />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pb-5">
          <Figure label="Estimated cost" value={formatCost(r.cost.total_usd)} tone="cost" />
          <Figure label="Total time" value={formatMs(r.timing.total_ms)} />
          <Figure label="Tokens in / out" value={`~${formatTokens(r.usage.input_tokens)} / ~${formatTokens(r.usage.output_tokens)}`} />
          <Figure label="First token after" value={formatMs(r.timing.time_to_first_token_ms)} />
        </dl>

        <Section title="How this request was handled">
          <Sieve trace={trace} />
        </Section>

        <Section title="Context window">
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
            {ctx.segments.map((seg, i) =>
              seg.tokens > 0 ? (
                <div
                  key={seg.label}
                  className={SEGMENT_SHADES[i % SEGMENT_SHADES.length]}
                  style={{ width: `${Math.max((seg.tokens / ctx.total_tokens) * 100, 2)}%` }}
                />
              ) : null,
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Bar shows the makeup of ~{formatTokens(ctx.total_tokens)} tokens, which is {ctx.percent}% of the{' '}
            {formatTokens(ctx.window)} window.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
            {ctx.segments.map((seg, i) => (
              <li key={seg.label} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className={cn('size-2.5 rounded-sm', SEGMENT_SHADES[i % SEGMENT_SHADES.length])} />
                  {seg.label}
                </span>
                <span className="text-muted-foreground">{formatTokens(seg.tokens)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Exactly what was sent">
          <ol className="flex flex-col gap-2">
            {trace.sent_messages.map((m, i) => (
              <li key={i} className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs font-medium capitalize text-primary">{m.role}</p>
                <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[13px] leading-snug">{m.content}</p>
              </li>
            ))}
          </ol>
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-muted-foreground hover:text-ink">Raw trace JSON</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11.5px] leading-relaxed">
              {JSON.stringify(trace, null, 2)}
            </pre>
          </details>
        </Section>
      </div>
    </aside>
  )
}
