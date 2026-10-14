import { useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Menu, Play, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { streamChat } from '@/lib/api'
import { href } from '@/lib/route'
import { cn, formatCost, formatMs, formatTokens } from '@/lib/utils'
import type { ModelInfo, Trace } from '@/lib/types'

interface Lane {
  modelId: string
  text: string
  status: 'idle' | 'streaming' | 'done' | 'error'
  error?: string
  trace?: Trace
}

const MAX = 3

export function ComparePage({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { models, me, refreshMe } = useAppData()
  const allowed = useMemo(() => models.filter((m) => m.allowed), [models])
  const [picked, setPicked] = useState<string[]>(() => [])
  const [prompt, setPrompt] = useState('Explain the difference between a mutex and a semaphore in three sentences.')
  const [lanes, setLanes] = useState<Lane[]>([])
  const aborts = useRef<AbortController[]>([])
  const featureOn = me?.features.includes('compare') ?? false

  const chosen = picked.length ? picked : allowed.slice(0, 2).map((m) => m.id)
  const running = lanes.some((l) => l.status === 'streaming')

  const toggle = (id: string) =>
    setPicked((p) => {
      const base = p.length ? p : chosen
      return base.includes(id) ? base.filter((x) => x !== id) : base.length >= MAX ? base : [...base, id]
    })

  const run = async () => {
    if (!prompt.trim() || running || chosen.length < 2) return
    aborts.current.forEach((a) => a.abort())
    aborts.current = chosen.map(() => new AbortController())
    setLanes(chosen.map((modelId) => ({ modelId, text: '', status: 'streaming' })))
    const update = (i: number, p: Partial<Lane> | ((l: Lane) => Partial<Lane>)) =>
      setLanes((ls) => ls.map((l, j) => (j === i ? { ...l, ...(typeof p === 'function' ? p(l) : p) } : l)))
    await Promise.all(
      chosen.map(async (modelId, i) => {
        try {
          await streamChat(
            { model: modelId, message: prompt.trim(), ephemeral: true },
            (ev) => {
              if (ev.type === 'delta') update(i, (l) => ({ text: l.text + ev.text }))
              if (ev.type === 'done') update(i, { status: 'done', trace: ev.trace, text: ev.message.content })
              if (ev.type === 'error') update(i, { status: 'error', error: ev.error, trace: ev.trace })
            },
            aborts.current[i].signal,
          )
        } catch (e) {
          update(i, { status: 'error', error: (e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message })
        }
      }),
    )
    void refreshMe()
  }

  const done = lanes.filter((l) => l.status === 'done' && l.trace)
  const cheapest = done.length > 1 ? done.reduce((a, b) => (a.trace!.response.cost.total_usd <= b.trace!.response.cost.total_usd ? a : b)).modelId : null
  const fastest = done.length > 1 ? done.reduce((a, b) => (a.trace!.response.timing.total_ms <= b.trace!.response.timing.total_ms ? a : b)).modelId : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[76rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader
          title="Compare models"
          description="Send one prompt to two or three models at once and see the answers next to what each one cost and how fast it was. Your skills, including PII redaction, apply to every model."
        />
        {!featureOn && me && (
          <p className="mb-6 rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-sm">
            Comparing models is part of Pro and Team. You're on {me.plan_name}.{' '}
            <a className="font-medium text-primary underline" href={href({ page: 'plans' })}>
              See plans
            </a>
          </p>
        )}

        <fieldset className="flex flex-wrap gap-2" disabled={!featureOn}>
          <legend className="mb-2 text-[13px] font-medium">Models (pick up to {MAX})</legend>
          {allowed.map((m: ModelInfo) => {
            const on = chosen.includes(m.id)
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(m.id)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50',
                  on ? 'border-primary bg-primary-soft font-medium text-ink' : 'border-border bg-surface text-muted-foreground hover:text-ink',
                )}
              >
                {m.name}
                {!m.live && <span className="ml-1 text-[11px] opacity-70">mock</span>}
              </button>
            )
          })}
        </fieldset>

        <div className="mt-5 rounded-xl border border-border bg-surface focus-within:border-primary/60">
          <label htmlFor="compare-prompt" className="sr-only">
            Prompt
          </label>
          <textarea
            id="compare-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
            }}
            className="block w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-3">
            <span className="pl-1 text-xs text-muted-foreground">
              Runs aren't saved as chats, but real models are billed as usual.
            </span>
            {running ? (
              <Button size="sm" variant="outline" onClick={() => aborts.current.forEach((a) => a.abort())}>
                <Square className="fill-current" /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => void run()} disabled={!featureOn || chosen.length < 2 || !prompt.trim()}>
                <Play /> Run on {chosen.length} models
              </Button>
            )}
          </div>
        </div>

        {lanes.length > 0 && (
          <div className={cn('mt-8 grid gap-5', lanes.length === 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2')}>
            {lanes.map((l) => {
              const m = models.find((x) => x.id === l.modelId)
              const r = l.trace?.response
              const tilde = r?.usage.estimated ? '~' : ''
              return (
                <article key={l.modelId} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface">
                  <header className="border-b border-border px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-semibold">{m?.name ?? l.modelId}</h2>
                      <span className="flex gap-1.5">
                        {cheapest === l.modelId && <Badge tone="cost">Cheapest</Badge>}
                        {fastest === l.modelId && <Badge tone="primary">Fastest</Badge>}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <Metric label="Cost" value={r ? formatCost(r.cost.total_usd) : '…'} tone="cost" />
                      <Metric label="First token" value={r ? formatMs(r.timing.time_to_first_token_ms) : '…'} />
                      <Metric label="Total" value={r ? formatMs(r.timing.total_ms) : '…'} />
                    </dl>
                    {r && (
                      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                        {tilde}
                        {formatTokens(r.usage.total_input_tokens)} in · {tilde}
                        {formatTokens(r.usage.output_tokens)} out{r.usage.estimated ? ' · simulated' : ''}
                      </p>
                    )}
                  </header>
                  <div className="min-h-40 flex-1 px-4 py-3">
                    {l.status === 'error' ? (
                      <p className="text-sm text-danger">{l.error}</p>
                    ) : (
                      <div className={cn('prose-reply text-[14.5px]', l.status === 'streaming' && 'streaming')}>
                        {l.text ? <Markdown remarkPlugins={[remarkGfm]}>{l.text}</Markdown> : <span className="caret" />}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Badge({ tone, children }: { tone: 'cost' | 'primary'; children: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', tone === 'cost' ? 'bg-cost/15 text-cost' : 'bg-primary/15 text-primary')}>
      {children}
    </span>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'cost' }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-[15px] font-semibold', tone === 'cost' && 'text-cost')}>{value}</dd>
    </div>
  )
}
