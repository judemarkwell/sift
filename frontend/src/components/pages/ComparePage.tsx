import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { History, Menu, Play, Plus, RotateCcw, Square, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { ApiError, api } from '@/lib/api'
import { compareStore, useLiveComparison } from '@/lib/compare-store'
import { remarkRestored } from '@/lib/remark-restored'
import { href, navigate } from '@/lib/route'
import { cn, formatCost, formatMs, formatTokens, relativeTime } from '@/lib/utils'
import type { Comparison, ComparisonLane, ComparisonSummary, ModelInfo } from '@/lib/types'

const MAX = 3
const DEFAULT_PROMPT = 'Explain the difference between a mutex and a semaphore in three sentences.'

export function ComparePage({ comparisonId, onOpenMenu }: { comparisonId?: string; onOpenMenu: () => void }) {
  const { models, me, refreshMe, styles } = useAppData()
  const live = useLiveComparison()
  const allowed = useMemo(() => models.filter((m) => m.allowed), [models])
  // Coming back to this page picks up the last run's prompt and models.
  const [picked, setPicked] = useState<string[]>(() => live?.lanes.map((l) => l.model_id) ?? [])
  const [prompt, setPrompt] = useState(() => live?.prompt || DEFAULT_PROMPT)
  const [saved, setSaved] = useState<Comparison | null>(null)
  const [history, setHistory] = useState<ComparisonSummary[]>([])
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const featureOn = me?.features.includes('compare') ?? false

  const loadHistory = useCallback(() => {
    api.comparisons().then(setHistory).catch(() => setHistory([]))
  }, [])
  useEffect(loadHistory, [loadHistory])

  // What's on screen: the live run if it's the one in the URL (or there's no URL id), else a saved one.
  useEffect(() => {
    if (!comparisonId || live?.id === comparisonId) {
      setSaved(null)
      return
    }
    api
      .comparison(comparisonId)
      .then(setSaved)
      .catch(() => setSaved(null))
  }, [comparisonId, live?.id])
  const shown: (Comparison & { running?: boolean }) | null =
    comparisonId && live?.id !== comparisonId ? saved : live

  const chosen = picked.length ? picked : allowed.slice(0, 2).map((m) => m.id)
  const running = !!live?.running

  const toggle = (id: string) =>
    setPicked((p) => {
      const base = p.length ? p : chosen
      return base.includes(id) ? base.filter((x) => x !== id) : base.length >= MAX ? base : [...base, id]
    })

  const run = async (text = prompt, ms = chosen) => {
    if (!text.trim() || running || ms.length < 2) return
    setError(null)
    try {
      await compareStore.run(text.trim(), ms, {
        onCreated: (id) => navigate({ page: 'compare', id }, true),
        onDone: () => {
          loadHistory()
          void refreshMe()
        },
      })
    } catch (e) {
      setError({ message: (e as Error).message, code: e instanceof ApiError ? e.code : undefined })
    }
  }

  const rerun = (c: Comparison) => {
    setPrompt(c.prompt)
    setPicked(c.lanes.map((l) => l.model_id))
    void run(c.prompt, c.lanes.map((l) => l.model_id))
  }

  const remove = async (id: string) => {
    await api.deleteComparison(id)
    if (comparisonId === id) navigate({ page: 'compare' })
    if (live?.id === id) compareStore.clear()
    loadHistory()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[76rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader
          title="Compare models"
          description="Send one prompt to two or three models at once and see the answers next to what each one cost and how fast it was. Your skills, including PII redaction, apply to every model. Every comparison is saved below."
        />
        {!featureOn && me && (
          <p className="mb-6 rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-sm">
            Comparing models is part of Pro and Team. You're on {me.plan_name}.{' '}
            <a className="font-medium text-primary underline" href={href({ page: 'plans' })}>
              See plans
            </a>
          </p>
        )}

        <div className="grid gap-8 xl:grid-cols-[1fr_17rem]">
          <div className="min-w-0">
            <fieldset className="flex flex-wrap gap-2" disabled={!featureOn || running}>
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
                  Styles like /tldr work here too. Real models are billed as usual.
                </span>
                {running ? (
                  <Button size="sm" variant="outline" onClick={() => compareStore.stop()}>
                    <Square className="fill-current" /> Stop
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void run()} disabled={!featureOn || chosen.length < 2 || !prompt.trim()}>
                    <Play /> Run on {chosen.length} models
                  </Button>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error.message}{' '}
                {error.code === 'feature_not_in_plan' && (
                  <a className="text-primary underline" href={href({ page: 'plans' })}>
                    See plans
                  </a>
                )}
              </p>
            )}

            {shown ? (
              <section className="mt-8" aria-live="polite">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {shown.running ? 'Running now' : relativeTime(shown.created_at)}
                      {shown.total_usd > 0 && <> · total <span className="text-cost">{formatCost(shown.total_usd)}</span></>}
                      {shown.styles.length > 0 && (
                        <> · {shown.styles.map((s) => styles.find((x) => x.id === s)?.label ?? s).join(', ')}</>
                      )}
                    </p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[15px] font-medium">{shown.prompt || shown.title}</p>
                  </div>
                  {!shown.running && (
                    <Button variant="outline" size="sm" disabled={!featureOn || running} onClick={() => rerun(shown)}>
                      <RotateCcw /> Run again
                    </Button>
                  )}
                </div>
                <Lanes comparison={shown} models={models} />
              </section>
            ) : (
              <p className="mt-10 text-sm text-muted-foreground">
                Pick models, write a prompt, and run it. Results stay here while you use the rest of Sift.
              </p>
            )}
          </div>

          <aside aria-label="Earlier comparisons" className="xl:border-l xl:border-border xl:pl-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <History className="size-4 text-muted-foreground" /> Earlier comparisons
              </h2>
              {comparisonId && (
                <a href={href({ page: 'compare' })} onClick={() => compareStore.clear()} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <Plus className="size-3.5" /> New
                </a>
              )}
            </div>
            {history.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Your comparisons will be listed here.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {history.map((h) => {
                  const active = (comparisonId ?? live?.id) === h.id
                  return (
                    <li key={h.id} className="group relative">
                      <a
                        href={href({ page: 'compare', id: h.id })}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'block rounded-md py-2 pl-2.5 pr-8 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                          active && 'bg-muted',
                        )}
                      >
                        <span className="block truncate text-[13.5px] font-medium">{h.title || 'Comparison'}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {h.models.map((id) => models.find((m) => m.id === id)?.name ?? id).join(' vs ')}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {relativeTime(h.created_at)}
                          {h.total_usd > 0 && <> · <span className="text-cost">{formatCost(h.total_usd)}</span></>}
                        </span>
                      </a>
                      <button
                        type="button"
                        aria-label={`Delete comparison ${h.title}`}
                        onClick={() => void remove(h.id)}
                        className="absolute right-1.5 top-2 rounded p-1 text-muted-foreground opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function Lanes({ comparison, models }: { comparison: Comparison; models: ModelInfo[] }) {
  const done = comparison.lanes.filter((l) => l.status === 'done' && l.stats)
  const best = (key: 'cost_usd' | 'total_ms') =>
    done.length > 1 ? done.reduce((a, b) => (a.stats![key] <= b.stats![key] ? a : b)).model_id : null
  const cheapest = best('cost_usd')
  const fastest = best('total_ms')
  return (
    <div className={cn('grid gap-5', comparison.lanes.length === 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2')}>
      {comparison.lanes.map((l) => (
        <Lane
          key={l.model_id}
          lane={l}
          model={models.find((x) => x.id === l.model_id)}
          cheapest={cheapest === l.model_id}
          fastest={fastest === l.model_id}
        />
      ))}
    </div>
  )
}

function Lane({ lane: l, model: m, cheapest, fastest }: { lane: ComparisonLane; model?: ModelInfo; cheapest: boolean; fastest: boolean }) {
  const s = l.stats
  const tilde = s?.estimated ? '~' : ''
  const restored = useMemo(
    () =>
      l.marks
        .filter((f) => f.placeholder && f.start != null && f.end != null)
        .map((f) => ({ value: l.content.slice(f.start!, f.end!), placeholder: f.placeholder! })),
    [l.marks, l.content],
  )
  const plugins = useMemo(() => [remarkGfm, remarkRestored(restored)], [restored])
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{m?.name ?? l.model_id}</h3>
          <span className="flex gap-1.5">
            {cheapest && <Badge tone="cost">Cheapest</Badge>}
            {fastest && <Badge tone="primary">Fastest</Badge>}
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <Metric label="Cost" value={s ? formatCost(s.cost_usd) : '…'} tone="cost" />
          <Metric label="First token" value={s ? formatMs(s.ttft_ms) : '…'} />
          <Metric label="Total" value={s ? formatMs(s.total_ms) : '…'} />
        </dl>
        {s && (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {tilde}
            {formatTokens(s.input_tokens)} in · {tilde}
            {formatTokens(s.output_tokens)} out{s.estimated ? ' · simulated' : ''}
            {s.truncated ? ' · hit length limit' : ''}
          </p>
        )}
      </header>
      <div className="min-h-40 flex-1 px-4 py-3">
        {l.status === 'error' || l.status === 'blocked' ? (
          <p className="text-sm text-danger">{l.error}</p>
        ) : (
          <div className={cn('prose-reply text-[14.5px]', l.status === 'running' && 'streaming')}>
            {l.content ? <Markdown remarkPlugins={plugins}>{l.content}</Markdown> : <span className="caret" />}
          </div>
        )}
      </div>
    </article>
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
