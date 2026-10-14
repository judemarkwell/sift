import type { ReactNode } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { renderPlaceholders } from '@/lib/marks'
import { href } from '@/lib/route'
import { cn, formatCost, formatMs, formatTokens } from '@/lib/utils'
import type { ChatMessage, Finding, ModelInfo, PipelineStep, Trace } from '@/lib/types'

interface Props {
  message: ChatMessage
  model?: ModelInfo
  onClose: () => void
}

type StageKey = PipelineStep['stage']

const STAGES: { key: StageKey; title: string }[] = [
  { key: 'pre-request', title: 'Before sending' },
  { key: 'provider', title: 'Model' },
  { key: 'post-response', title: 'After the reply' },
]

const STATUS: Record<PipelineStep['status'], { label: string; tone: string } | null> = {
  ok: null,
  changed: { label: 'Changed request', tone: 'bg-primary/15 text-primary' },
  warn: { label: 'Warning', tone: 'bg-cost/15 text-cost' },
  blocked: { label: 'Blocked', tone: 'bg-danger/15 text-danger' },
  error: { label: 'Error', tone: 'bg-danger/15 text-danger' },
}

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

function FindingChips({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {findings.map((f, i) => (
        <li
          key={i}
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[11.5px]',
            f.action === 'block' && 'bg-danger/10 text-danger',
            f.action === 'redact' && 'bg-primary/10 text-primary',
            (f.action === 'warn' || f.action === 'info') && 'bg-cost/10 text-cost',
          )}
          title={f.detector ? `Found by ${f.detector === 'comprehend' ? 'AWS Comprehend (mock)' : f.detector}` : undefined}
        >
          {f.label}
          {f.preview && <span className="opacity-75"> {f.preview}</span>}
          {f.placeholder && <span className="font-mono"> → {f.placeholder}</span>}
        </li>
      ))}
    </ul>
  )
}

/** The request drawn as a sieve, falling through each stage in order. */
function Sieve({ trace }: { trace: Trace }) {
  return (
    <ol className="relative">
      <span aria-hidden className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
      <span aria-hidden className="sieve-drop absolute left-[8px] top-3 size-[7px] rounded-full bg-primary" />
      {STAGES.map((stage) => {
        const steps = trace.pipeline.filter((s) => s.stage === stage.key)
        const skipped = stage.key === 'provider' && trace.response.finish_reason === 'blocked'
        return (
          <li key={stage.key} className="relative pb-4 pl-8 last:pb-0">
            <svg aria-hidden viewBox="0 0 24 24" className="absolute left-0 top-0.5 size-[23px] rounded-md bg-surface">
              <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" className="fill-surface stroke-border" />
              <path d="M6 8h12M8 12h8M10.5 16h3" className="stroke-primary" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="pt-0.5 text-xs text-muted-foreground">{stage.title}</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {skipped && (
                <li className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
                  Never called. Nothing left Sift, and nothing was charged.
                </li>
              )}
              {steps.map((s, i) => {
                const status = STATUS[s.status]
                return (
                  <li key={`${s.name}-${i}`} className="rounded-lg bg-muted px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="flex items-center gap-2 text-[13.5px] font-medium">
                        {s.skill_id ? (
                          <a href={href({ page: 'skills' })} className="hover:underline" title="Open skill settings">
                            {s.name}
                          </a>
                        ) : (
                          s.name
                        )}
                        {status && <span className={cn('rounded px-1.5 py-px text-[10.5px] font-semibold', status.tone)}>{status.label}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatMs(s.duration_ms)}</span>
                    </div>
                    {s.detail && (
                      <p className={cn('mt-0.5 text-[12.5px] leading-snug text-muted-foreground', s.status === 'error' && 'text-danger')}>
                        {s.detail}
                      </p>
                    )}
                    <FindingChips findings={s.findings} />
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

export function TracePanel({ message, model, onClose }: Props) {
  const trace = message.trace
  return (
    <aside
      aria-label="Request trace"
      className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface md:w-[420px]"
    >
      <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Trace for this reply</h2>
          {trace && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {model?.name ?? trace.model}, {trace.response.provider}. {new Date(trace.created_at).toLocaleString()}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 size-8" onClick={onClose} aria-label="Close trace">
          <X />
        </Button>
      </header>
      {!trace ? (
        <p className="px-5 text-sm text-muted-foreground">Loading trace…</p>
      ) : (
        <TraceBody trace={trace} />
      )}
    </aside>
  )
}

function TraceBody({ trace }: { trace: Trace }) {
  const r = trace.response
  const ctx = trace.context
  const est = r.usage.estimated
  const tilde = est ? '~' : ''
  const saved = r.cost.uncached_usd - r.cost.total_usd

  return (
    <div className="flex-1 overflow-y-auto">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pb-4">
        <Figure label={est ? 'Simulated cost' : 'Cost'} value={formatCost(r.cost.total_usd)} tone="cost" />
        <Figure label="Total time" value={formatMs(r.timing.total_ms)} />
        <Figure
          label="Tokens in / out"
          value={`${tilde}${formatTokens(r.usage.total_input_tokens)} / ${tilde}${formatTokens(r.usage.output_tokens)}`}
        />
        <Figure label="First token after" value={formatMs(r.timing.time_to_first_token_ms)} />
      </dl>
      <p className="px-5 pb-5 text-xs leading-relaxed text-muted-foreground">
        {r.finish_reason === 'blocked'
          ? 'Blocked before sending, so there was no cost.'
          : est
            ? 'Mock model: token counts and cost are estimates. Nothing was charged.'
            : `Counts reported by ${r.provider}. ${trace.charged_usd ? `${formatCost(trace.charged_usd)} came out of your plan.` : ''}${
                r.usage.cache_read_tokens > 0
                  ? ` ${formatTokens(r.usage.cache_read_tokens)} input tokens were read from the prompt cache, saving ${formatCost(Math.max(saved, 0))}.`
                  : ''
              }`}
      </p>

      <Section title="How this request was handled">
        <Sieve trace={trace} />
      </Section>

      <Section title="Context window">
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-muted">
          {ctx.segments.map((seg, i) =>
            seg.tokens > 0 ? (
              <div
                key={seg.label}
                className={SEGMENT_SHADES[i % SEGMENT_SHADES.length]}
                style={{ width: `${Math.max((seg.tokens / Math.max(ctx.total_tokens, 1)) * 100, 2)}%` }}
              />
            ) : null,
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          ~{formatTokens(ctx.total_tokens)} tokens sent, {ctx.percent}% of the {formatTokens(ctx.window)} window.
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

      <Section title="Exactly what the model received">
        <ol className="flex flex-col gap-2">
          {trace.sent_messages.map((m, i) => (
            <li key={i} className="rounded-lg border border-border px-3 py-2">
              <p className="text-xs font-medium capitalize text-primary">{m.role}</p>
              <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap break-words text-[13px] leading-snug">
                {renderPlaceholders(m.content)}
              </p>
            </li>
          ))}
        </ol>
        {r.content && (
          <>
            <p className="mt-4 text-xs font-medium text-primary">What the model replied, before Sift restored any values</p>
            <p className="mt-1 line-clamp-6 whitespace-pre-wrap break-words rounded-lg border border-border px-3 py-2 text-[13px] leading-snug">
              {renderPlaceholders(r.content)}
            </p>
          </>
        )}
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-ink">Raw trace JSON</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11.5px] leading-relaxed">
            {JSON.stringify(trace, null, 2)}
          </pre>
        </details>
      </Section>
    </div>
  )
}
