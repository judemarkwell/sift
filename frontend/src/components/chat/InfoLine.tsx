import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'

import { cn, formatCost, formatMs, formatTokens } from '@/lib/utils'
import type { ChatMessage, ModelInfo } from '@/lib/types'

interface Props {
  message: ChatMessage
  model?: ModelInfo
  selected: boolean
  onInspect: () => void
}

/** The quiet line under every reply: what it cost and how long it took. Click for the full trace. */
export function InfoLine({ message, model, selected, onInspect }: Props) {
  const r = message.trace?.response
  const t = r?.usage.estimated ? '~' : ''
  const name = model?.name ?? message.model_id
  const canInspect = !message.streaming && !!(message.trace || message.trace_id)
  const protectedCount =
    message.trace?.pipeline
      .filter((s) => s.skill_id === 'pii-redaction')
      .flatMap((s) => s.findings)
      .filter((f) => f.action === 'redact').length ?? 0

  let summary: ReactNode
  if (message.streaming) {
    summary = <span>{name} is responding</span>
  } else if (r && message.status !== 'blocked') {
    summary = (
      <>
        <span className="text-ink/80">{name}</span>
        <span>
          {t}
          {formatTokens(r.usage.total_input_tokens)} in · {t}
          {formatTokens(r.usage.output_tokens)} out
        </span>
        <span className="text-cost" title={r.usage.estimated ? 'Simulated cost (mock model, not charged)' : 'Cost'}>
          {formatCost(r.cost.total_usd)}
        </span>
        <span title="Total time">{formatMs(r.timing.total_ms)}</span>
        {protectedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-primary" title="Values replaced with placeholders">
            <ShieldCheck className="size-3.5" />
            {protectedCount} hidden
          </span>
        )}
      </>
    )
  } else {
    summary = <span>{message.status === 'blocked' ? 'Stopped before sending · $0' : name}</span>
  }

  return (
    <button
      type="button"
      onClick={onInspect}
      disabled={!canInspect}
      aria-pressed={selected}
      className={cn(
        'group -mx-2 mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 rounded-md px-2 py-1 text-left text-[12.5px] text-muted-foreground transition-colors',
        'enabled:hover:bg-muted enabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-ring',
        selected && 'bg-primary-soft text-ink',
      )}
    >
      {summary}
      {canInspect && (
        <span
          className={cn(
            'font-medium text-primary',
            !selected && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        >
          {selected ? 'Showing trace' : 'Show trace'}
        </span>
      )}
    </button>
  )
}
