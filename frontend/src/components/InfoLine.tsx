import type { ReactNode } from 'react'

import { cn, formatCost, formatMs, formatTokens } from '@/lib/utils'
import type { ChatMessage, ModelInfo } from '@/lib/types'

interface Props {
  message: ChatMessage
  model?: ModelInfo
  selected: boolean
  onInspect: () => void
}

/** The quiet line under every reply: what it cost and how long it took. Click to see the full trace. */
export function InfoLine({ message, model, selected, onInspect }: Props) {
  const r = message.trace?.response
  const name = model?.name ?? message.modelId

  let summary: ReactNode
  if (message.status === 'streaming') {
    summary = <span>{name} is responding</span>
  } else if (r) {
    summary = (
      <>
        <span className="text-ink/80">{name}</span>
        <span title="Input tokens (estimated)">~{formatTokens(r.usage.input_tokens)} in</span>
        <span title="Output tokens (estimated)">~{formatTokens(r.usage.output_tokens)} out</span>
        <span className="text-cost" title="Estimated cost">
          {formatCost(r.cost.total_usd)}
        </span>
        <span title="Total time">{formatMs(r.timing.total_ms)}</span>
      </>
    )
  } else {
    summary = <span>{name}</span>
  }

  return (
    <button
      type="button"
      onClick={onInspect}
      disabled={!message.trace}
      aria-pressed={selected}
      className={cn(
        'group -mx-2 mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 rounded-md px-2 py-1 text-left text-[12.5px] text-muted-foreground transition-colors',
        'enabled:hover:bg-muted enabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-ring',
        selected && 'bg-primary-soft text-ink',
      )}
    >
      {summary}
      {message.trace && (
        <span className={cn('font-medium text-primary', !selected && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}>
          {selected ? 'Showing trace' : 'Show trace'}
        </span>
      )}
    </button>
  )
}
