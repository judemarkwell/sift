import { useEffect, useMemo, useState } from 'react'
import { Menu } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader, Segmented } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import { href } from '@/lib/route'
import { cn, formatCost, formatDate, formatMs, formatTokens } from '@/lib/utils'
import type { UsageResponse } from '@/lib/types'

/** Series colors follow the model (its position in the full model list), never its rank in this chart. */
const seriesVar = (i: number) => `var(--series-${(i % 8) + 1})`

export function UsagePage({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { models, me } = useAppData()
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [data, setData] = useState<UsageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'chart' | 'table'>('chart')

  useEffect(() => {
    setError(null)
    api.usage(Number(days)).then(setData).catch((e: Error) => setError(e.message))
  }, [days])

  const colorOf = useMemo(() => {
    const order = new Map(models.map((m, i) => [m.id, i]))
    return (id: string) => seriesVar(order.get(id) ?? 7)
  }, [models])

  const t = data?.totals ?? {}
  const p = data?.privacy
  const seriesIds = data ? data.by_model.map((m) => m.model_id) : []

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[60rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader title="Usage" description="Where your tokens and money went, and what Sift's skills caught along the way.">
          <Segmented
            label="Time range"
            value={days}
            onChange={setDays}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        </PageHeader>

        {error && <p className="text-sm text-danger">{error}</p>}
        {!data ? (
          !error && <p className="text-sm text-muted-foreground">Loading usage…</p>
        ) : t.messages ? (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border py-6 sm:grid-cols-4">
              <Stat
                label="Real-model spend"
                value={formatCost(t.live_cost_usd ?? 0)}
                tone="cost"
                note={
                  (t.cost_usd ?? 0) - (t.live_cost_usd ?? 0) > 0
                    ? `plus ${formatCost((t.cost_usd ?? 0) - (t.live_cost_usd ?? 0))} simulated on mocks`
                    : undefined
                }
              />
              <Stat label="Messages" value={String(t.messages)} note={`${formatTokens((t.input_tokens ?? 0) + (t.output_tokens ?? 0))} tokens`} />
              <Stat
                label="Saved by caching"
                value={formatCost(t.cache_saved_usd ?? 0)}
                note={t.cache_read_tokens ? `${formatTokens(t.cache_read_tokens)} tokens from cache` : 'Grows in longer chats'}
              />
              <Stat
                label="Kept from models"
                value={String((p?.redact ?? 0) + (p?.block ?? 0))}
                note={`${p?.blocked_messages ?? 0} message${p?.blocked_messages === 1 ? '' : 's'} blocked`}
              />
            </dl>

            <section className="mt-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[16px] font-semibold">Spend per day, by model</h2>
                <Segmented
                  size="sm"
                  label="Show as"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'chart', label: 'Chart' },
                    { value: 'table', label: 'Table' },
                  ]}
                />
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] text-muted-foreground" aria-label="Legend">
                {data.by_model.map((m) => (
                  <li key={m.model_id} className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: colorOf(m.model_id) }} />
                    {m.name}
                    {!m.live && <span className="text-[11px]">(mock)</span>}
                  </li>
                ))}
              </ul>
              {view === 'chart' ? (
                <DailyChart data={data} seriesIds={seriesIds} colorOf={colorOf} names={new Map(data.by_model.map((m) => [m.model_id, m.name]))} />
              ) : (
                <DailyTable data={data} names={new Map(data.by_model.map((m) => [m.model_id, m.name]))} />
              )}
            </section>

            <section className="mt-10">
              <h2 className="text-[16px] font-semibold">Models compared</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">Averages per message, from your own usage.</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 text-right font-medium">Messages</th>
                      <th className="py-2 pr-3 text-right font-medium">Avg cost</th>
                      <th className="py-2 pr-3 text-right font-medium">First token</th>
                      <th className="py-2 pr-3 text-right font-medium">Full reply</th>
                      <th className="w-[28%] py-2 font-medium">Share of spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_model.map((m) => {
                      const share = t.cost_usd ? m.cost_usd / t.cost_usd : 0
                      return (
                        <tr key={m.model_id} className="border-b border-border/70">
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2">
                              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: colorOf(m.model_id) }} />
                              {m.name}
                              {!m.live && <span className="text-xs text-muted-foreground">mock</span>}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 text-right">{m.messages}</td>
                          <td className="py-2.5 pr-3 text-right text-cost">{formatCost(m.avg_cost_usd)}</td>
                          <td className="py-2.5 pr-3 text-right">{formatMs(m.avg_ttft_ms)}</td>
                          <td className="py-2.5 pr-3 text-right">{formatMs(m.avg_latency_ms)}</td>
                          <td className="py-2.5">
                            <span className="flex items-center gap-2">
                              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full rounded-full bg-ink/70" style={{ width: `${Math.max(share * 100, share ? 2 : 0)}%` }} />
                              </span>
                              <span className="w-10 text-right text-xs text-muted-foreground">{Math.round(share * 100)}%</span>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="mt-10 grid gap-10 md:grid-cols-2">
              <section>
                <h2 className="text-[16px] font-semibold">What PII redaction found</h2>
                {p && Object.keys(p.by_kind).length ? (
                  <ul className="mt-3 flex flex-col gap-2">
                    {Object.entries(p.by_kind).map(([label, n]) => {
                      const max = Math.max(...Object.values(p.by_kind))
                      return (
                        <li key={label} className="grid grid-cols-[9rem_1fr_2rem] items-center gap-3 text-[13px]">
                          <span className="truncate">{label}</span>
                          <span className="h-2 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${(n / max) * 100}%` }} />
                          </span>
                          <span className="text-right text-muted-foreground">{n}</span>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Nothing sensitive in this period. <a className="text-primary underline" href={href({ page: 'skills' })}>Check your policy</a>.
                  </p>
                )}
                {!!p?.reply_flags && (
                  <p className="mt-3 text-[13px] text-muted-foreground">
                    Reply check also flagged {p.reply_flags} item{p.reply_flags > 1 ? 's' : ''} in model replies.
                  </p>
                )}
              </section>
              <section>
                <h2 className="text-[16px] font-semibold">Most expensive messages</h2>
                {data.top_messages.length ? (
                  <ol className="mt-3 flex flex-col divide-y divide-border/70 text-[13px]">
                    {data.top_messages.map((m) => (
                      <li key={m.trace_id} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="min-w-0 truncate">
                          {m.ephemeral ? (
                            <span>Comparison run</span>
                          ) : (
                            <a className="text-primary hover:underline" href={href({ page: 'chat', id: m.conversation_id })}>
                              Open chat
                            </a>
                          )}
                          <span className="text-muted-foreground">
                            {' '}
                            · {models.find((x) => x.id === m.model_id)?.name ?? m.model_id} · {formatTokens(m.input_tokens)} in ·{' '}
                            {formatDate(m.created_at)}
                          </span>
                        </span>
                        <span className="shrink-0 text-cost">{formatCost(m.cost_usd)}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-[13px] text-muted-foreground">No paid messages yet.</p>
                )}
              </section>
            </div>
            {me && (
              <p className="mt-10 text-xs text-muted-foreground">
                Sift-wide safety cap: {formatCost(me.platform.spent_today_usd)} of {formatCost(me.platform.daily_budget_usd, { cents: true })}{' '}
                used today across all real models.
              </p>
            )}
          </>
        ) : (
          <div className="border-y border-border py-12 text-center">
            <p className="font-medium">No messages in this period</p>
            <p className="mt-1 text-sm text-muted-foreground">
              <a className="text-primary underline" href={href({ page: 'chat' })}>Start a chat</a> and your usage will show up here.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'cost' }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-1 text-[26px] font-semibold leading-none tracking-[-0.01em]', tone === 'cost' && 'text-cost')}>{value}</dd>
      {note && <dd className="mt-1.5 text-xs text-muted-foreground">{note}</dd>}
    </div>
  )
}

const H = 200
const PAD = { top: 8, right: 8, bottom: 22, left: 52 }

function niceMax(v: number) {
  if (v <= 0) return 0.001
  const exp = 10 ** Math.floor(Math.log10(v))
  const n = v / exp
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp
}

function DailyChart({
  data,
  seriesIds,
  colorOf,
  names,
}: {
  data: UsageResponse
  seriesIds: string[]
  colorOf: (id: string) => string
  names: Map<string, string>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 900
  const n = data.daily.length
  const max = niceMax(Math.max(...data.daily.map((d) => d.total_usd)))
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const slot = plotW / n
  const barW = Math.max(Math.min(slot * 0.66, 28), 2)
  const y = (v: number) => (v / max) * plotH
  const ticks = [0, max / 2, max]
  const labelEvery = n > 31 ? 14 : n > 10 ? 5 : 1
  const hovered = hover != null ? data.daily[hover] : null

  return (
    <div className="relative mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Spend per day by model. Use the table view for exact values.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH - y(t)} y2={PAD.top + plotH - y(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 8} y={PAD.top + plotH - y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {formatCost(t)}
            </text>
          </g>
        ))}
        {data.daily.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2
          let acc = 0
          const segs = seriesIds.filter((id) => (d.by_model[id] ?? 0) > 0)
          return (
            <g key={d.date}>
              {segs.map((id, j) => {
                const h = y(d.by_model[id])
                const top = PAD.top + plotH - acc - h
                acc += h
                const isTop = j === segs.length - 1
                // 2px surface gap between stacked segments; rounded data-end only on top.
                const gap = j > 0 ? 2 : 0
                return (
                  <path
                    key={id}
                    d={roundedTop(x, top, barW, Math.max(h - gap, 0.5), isTop ? Math.min(4, barW / 2) : 0)}
                    style={{ fill: colorOf(id) }}
                    opacity={hover == null || hover === i ? 1 : 0.45}
                  />
                )
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {formatDate(d.date + 'T12:00:00')}
                </text>
              )}
              {/* Hit target: the whole day column, bigger than the bar. */}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${formatDate(d.date + 'T12:00:00')}: ${formatCost(d.total_usd)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              />
            </g>
          )
        })}
      </svg>
      {hovered && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-[0_8px_30px_-12px_rgb(28_36_48/0.35)]"
          style={{
            left: `clamp(0px, calc(${((PAD.left + (hover + 0.5) * slot) / W) * 100}% - 88px), calc(100% - 176px))`,
          }}
        >
          <p className="font-medium">{formatDate(hovered.date + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
          {seriesIds.filter((id) => hovered.by_model[id]).length === 0 && <p className="mt-1 text-muted-foreground">No spend</p>}
          <ul className="mt-1 flex flex-col gap-0.5">
            {seriesIds
              .filter((id) => hovered.by_model[id])
              .map((id) => (
                <li key={id} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-sm" style={{ background: colorOf(id) }} />
                    {names.get(id) ?? id}
                  </span>
                  <strong className="font-semibold">{formatCost(hovered.by_model[id])}</strong>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h)
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

function DailyTable({ data, names }: { data: UsageResponse; names: Map<string, string> }) {
  const rows = data.daily.filter((d) => d.total_usd > 0)
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Day</th>
            <th className="py-2 pr-3 font-medium">Models</th>
            <th className="py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.date} className="border-b border-border/70">
              <td className="py-2 pr-3">{formatDate(d.date + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
              <td className="py-2 pr-3 text-muted-foreground">
                {Object.entries(d.by_model)
                  .filter(([, v]) => v > 0)
                  .map(([id, v]) => `${names.get(id) ?? id} ${formatCost(v)}`)
                  .join(', ')}
              </td>
              <td className="py-2 text-right text-cost">{formatCost(d.total_usd)}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={3} className="py-4 text-muted-foreground">
                No spend in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
