import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import type { Finding, PiiAction } from '@/lib/types'

export const ACTION_LABEL: Record<PiiAction, string> = {
  block: 'Block',
  redact: 'Replace',
  warn: 'Warn',
  allow: 'Allow',
}

/** What each action does, said plainly, for tooltips and legends. */
export const ACTION_HELP: Record<PiiAction, string> = {
  block: "The message isn't sent at all",
  redact: 'Replaced with a placeholder before sending',
  warn: 'Sent as-is, but pointed out',
  allow: 'Ignored',
}

export const markClass = (action: Finding['action']) =>
  cn(
    'rounded-[3px] px-[1px] -mx-[1px] decoration-2 underline-offset-[3px]',
    action === 'redact' && 'bg-primary/15 underline decoration-primary/60 decoration-dotted',
    action === 'warn' && 'bg-cost/15 underline decoration-cost/60 decoration-wavy',
    action === 'block' && 'bg-danger/15 underline decoration-danger',
  )

export function markTitle(f: Finding): string {
  if (f.action === 'redact') return `${f.label}: sent as ${f.placeholder}`
  if (f.action === 'warn') return `${f.label}: sent as-is (warn only)`
  if (f.action === 'block') return `${f.label}: blocked`
  return f.label
}

/**
 * Split text into plain runs and marked runs, for highlighting findings in
 * place. `renderValue` can replace a marked value's text (e.g. to mask secrets).
 */
export function renderMarked(
  text: string,
  marks: Finding[],
  renderValue?: (finding: Finding, value: string) => ReactNode,
): ReactNode[] {
  const spans = marks
    .filter((m) => m.start != null && m.end != null && m.end <= text.length)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  const out: ReactNode[] = []
  let cursor = 0
  spans.forEach((m, i) => {
    const s = m.start as number
    const e = m.end as number
    if (s < cursor) return
    if (s > cursor) out.push(text.slice(cursor, s))
    out.push(
      <mark key={i} className={cn(markClass(m.action), 'text-inherit')} title={markTitle(m)}>
        {renderValue ? renderValue(m, text.slice(s, e)) : text.slice(s, e)}
      </mark>,
    )
    cursor = e
  })
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/** Highlight placeholders like [EMAIL_1] in text the model saw. */
export function renderPlaceholders(text: string): ReactNode[] {
  return text.split(/(\[[A-Z_]+_\d+\])/g).map((part, i) =>
    /^\[[A-Z_]+_\d+\]$/.test(part) ? (
      <span key={i} className="rounded bg-primary/15 px-1 font-mono text-[0.92em] text-primary">
        {part}
      </span>
    ) : (
      part
    ),
  )
}
