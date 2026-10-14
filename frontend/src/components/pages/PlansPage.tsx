import { useEffect, useState } from 'react'
import { Check, Columns2, CreditCard, MessageSquare, Menu, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, PageHeader, Segmented } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import { href } from '@/lib/route'
import { cn, formatCost, formatDate, formatTokens } from '@/lib/utils'
import type { BillingResponse, CheckoutSession, LedgerEntry, Plan } from '@/lib/types'


export function PlansPage({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { refreshMe, refreshModels } = useAppData()
  const [data, setData] = useState<BillingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<CheckoutSession | null>(null)
  const [seats, setSeats] = useState(3)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.billing().then(setData).catch((e: Error) => setError(e.message))
  }, [])

  const start = async (body: { plan_id?: string; topup_usd?: number; seats?: number }) => {
    setError(null)
    try {
      setSession(await api.checkout(body))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const confirm = async () => {
    if (!session) return
    setBusy(true)
    try {
      setData(await api.completeCheckout(session.id))
      setSession(null)
      await Promise.all([refreshMe(), refreshModels()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <div className="p-8 text-sm text-muted-foreground">{error ?? 'Loading…'}</div>

  const usedPct = data.included_usd ? Math.min(100, (data.allowance_used_usd / data.included_usd) * 100) : 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[64rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader
          title="Plan & billing"
          description="Every plan shows how much of its price pays for model usage at cost, and how much is Sift. No markup hidden in the tokens."
        />
        {error && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {error}
          </p>
        )}

        <section className="grid gap-6 border-y border-border py-6 md:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="text-xs text-muted-foreground">Current plan</p>
            <p className="mt-1 text-[22px] font-semibold">
              {data.plan.name}
              {data.seats > 1 && <span className="text-base font-normal text-muted-foreground"> · {data.seats} seats</span>}
            </p>
            <div className="mt-4">
              <div className="flex items-baseline justify-between text-[13px]">
                <span>Included usage this month</span>
                <span className="text-muted-foreground">
                  <span className="text-ink">{formatCost(data.allowance_used_usd)}</span> of {formatCost(data.included_usd, { cents: true })} used
                </span>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Included usage used"
                aria-valuenow={Math.round(usedPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className={cn('h-full rounded-full', usedPct > 90 ? 'bg-danger' : 'bg-primary')} style={{ width: `${Math.max(usedPct, usedPct ? 1.5 : 0)}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Resets {formatDate(data.period_end, { month: 'long', day: 'numeric' })}. Unused included usage doesn't roll over; top-up credit never expires.
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Top-up credit</p>
            <p className="mt-1 text-[22px] font-semibold text-cost">{formatCost(data.credit_usd, { cents: true })}</p>
            {data.plan.features.includes('topups') ? (
              <>
                <p className="mt-2 text-xs text-muted-foreground">
                  Used after your included usage runs out. Priced at cost plus {Math.round(data.topups.fee * 100)}%.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.topups.amounts.map((a) => (
                    <Button key={a} size="sm" variant="outline" onClick={() => void start({ topup_usd: a })}>
                      Add ${a}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Top-ups are available on Plus and above.</p>
            )}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-[16px] font-semibold">Plans</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.plans.map((p) => (
              <PlanColumn
                key={p.id}
                plan={p}
                current={p.id === data.plan.id}
                seats={seats}
                onSeats={setSeats}
                onChoose={() => void start({ plan_id: p.id, seats: p.per_seat ? seats : 1 })}
              />
            ))}
          </div>
        </section>

        <Activity entries={data.ledger} />
      </div>

      <Dialog open={!!session} onClose={() => setSession(null)} title="Confirm purchase">
        {session && (
          <>
            <p className="text-sm">{session.label}</p>
            <p className="mt-1 text-[28px] font-semibold">{formatCost(session.amount_usd, { cents: true })}</p>
            {session.test_mode && (
              <p className="mt-3 rounded-md bg-cost/10 px-3 py-2 text-[13px] leading-relaxed text-ink/85">
                Test mode: payments aren't connected yet, so no card is needed and nothing is charged. In production this
                step is Stripe's hosted checkout.
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setSession(null)}>
                Cancel
              </Button>
              <Button onClick={() => void confirm()} disabled={busy}>
                {busy ? 'Confirming…' : 'Confirm test purchase'}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  )
}

function PlanColumn({
  plan,
  current,
  seats,
  onSeats,
  onChoose,
}: {
  plan: Plan
  current: boolean
  seats: number
  onSeats: (n: number) => void
  onChoose: () => void
}) {
  const usagePct = plan.price_usd ? (plan.included_usage_usd / plan.price_usd) * 100 : 100
  return (
    <div className={cn('flex flex-col rounded-xl border bg-surface p-5', current ? 'border-primary ring-1 ring-primary' : 'border-border')}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[17px] font-semibold">{plan.name}</h3>
        {current && <span className="text-xs font-medium text-primary">Current</span>}
      </div>
      <p className="mt-1 min-h-[2.5em] text-[13px] leading-snug text-muted-foreground">{plan.tagline}</p>
      <p className="mt-3">
        <span className="text-[30px] font-semibold tracking-[-0.02em]">${plan.price_usd}</span>
        <span className="text-[13px] text-muted-foreground"> /month{plan.per_seat ? ' per seat' : ''}</span>
      </p>

      {/* Where the money goes: the honest part. */}
      {plan.price_usd > 0 ? (
        <div className="mt-3">
          <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden>
            <span className="h-full rounded-l-full bg-cost" style={{ width: `${usagePct}%` }} />
            <span className="h-full flex-1 rounded-r-full bg-primary" />
          </div>
          <p className="mt-1.5 flex justify-between text-[12px]">
            <span>
              <span className="font-medium text-cost">${plan.included_usage_usd}</span> model usage
            </span>
            <span>
              <span className="font-medium text-primary">${plan.sift_fee_usd}</span> Sift
            </span>
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[12px]">
          <span className="font-medium text-cost">${plan.included_usage_usd}</span> of model usage, on us
        </p>
      )}

      <ul className="mt-4 flex flex-1 flex-col gap-2 text-[13px] leading-snug">
        {plan.highlights.map((h) => (
          <li key={h} className="flex gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
            {h}
          </li>
        ))}
      </ul>

      {plan.per_seat && !current && (
        <label className="mt-4 flex items-center justify-between text-[13px]">
          Seats
          <input
            type="number"
            min={1}
            max={500}
            value={seats}
            onChange={(e) => onSeats(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-right focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
      )}
      <Button className="mt-4 w-full" variant={current ? 'outline' : 'default'} disabled={current} onClick={onChoose}>
        {current ? 'Your plan' : plan.price_usd === 0 ? 'Switch to Free' : `Choose ${plan.name}`}
      </Button>
    </div>
  )
}

type Filter = 'all' | 'usage' | 'billing'

/** Billing activity, grouped by day. Usage lines say which chat or comparison they came from. */
function Activity({ entries }: { entries: LedgerEntry[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(25)
  const rows = entries.filter((e) => filter === 'all' || (filter === 'usage' ? e.kind === 'usage' : e.kind !== 'usage'))
  const visible = rows.slice(0, limit)
  const days = new Map<string, LedgerEntry[]>()
  visible.forEach((e) => {
    const d = new Date(e.created_at).toDateString()
    days.set(d, [...(days.get(d) ?? []), e])
  })
  const usageTotal = (list: LedgerEntry[]) => list.filter((e) => e.kind === 'usage').reduce((n, e) => n - e.amount_usd, 0)

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold">Activity</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Every charge and credit. Click a usage line to open the chat or comparison it came from.
          </p>
        </div>
        <Segmented
          size="sm"
          label="Show"
          value={filter}
          onChange={(v) => {
            setFilter(v)
            setLimit(25)
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'usage', label: 'Usage' },
            { value: 'billing', label: 'Plan & credit' },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <p className="mt-6 border-y border-border py-8 text-center text-sm text-muted-foreground">
          {filter === 'usage' ? 'No paid model usage yet. Mock models are free and don’t appear here.' : 'Nothing here yet.'}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {[...days.entries()].map(([day, list]) => (
            <div key={day}>
              <div className="flex items-baseline justify-between border-b border-border pb-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-ink">{formatDate(list[0].created_at, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                {usageTotal(list) > 0 && (
                  <span>
                    Usage <span className="text-cost">{formatCost(usageTotal(list))}</span>
                  </span>
                )}
              </div>
              <ul className="divide-y divide-border/60">
                {list.map((e) => (
                  <ActivityRow key={e.id} e={e} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {rows.length > limit && (
        <div className="mt-4 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + 25)}>
            Show more ({rows.length - limit} left)
          </Button>
        </div>
      )}
    </section>
  )
}

function ActivityRow({ e }: { e: LedgerEntry }) {
  const time = new Date(e.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const amount = (
    <span className={cn('shrink-0 text-right tabular-nums', e.amount_usd < 0 ? 'text-ink' : 'text-primary')}>
      {e.amount_usd > 0 ? '+' : ''}
      {formatCost(e.amount_usd)}
    </span>
  )

  if (e.kind === 'usage') {
    const Icon = e.source_kind === 'comparison' ? Columns2 : MessageSquare
    const link = e.source_id ? href({ page: e.source_kind === 'comparison' ? 'compare' : 'chat', id: e.source_id }) : null
    const what = e.source_kind === 'comparison' ? 'Comparison' : 'Chat'
    const details = [
      e.input_tokens != null && `${formatTokens(e.input_tokens)} in`,
      e.output_tokens != null && `${formatTokens(e.output_tokens)} out`,
      e.cache_read_tokens ? `${formatTokens(e.cache_read_tokens)} from cache` : null,
      e.image_tokens ? `incl. ${formatTokens(e.image_tokens)} image tokens` : null,
      e.continued ? 'continued reply' : null,
      e.truncated ? 'hit length limit' : null,
    ].filter(Boolean)
    const body = (
      <>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px]">
            <span className="text-muted-foreground">{what}:</span>{' '}
            <span className={cn(link && 'group-hover:underline')}>{e.source_title ?? 'Unknown'}</span>
          </span>
          <span className="block text-xs text-muted-foreground">
            {e.model_name ?? e.description} · {details.join(' · ')} · {time}
          </span>
        </span>
        {amount}
      </>
    )
    return (
      <li>
        {link ? (
          <a href={link} className="group -mx-2 flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            {body}
          </a>
        ) : (
          <div className="flex items-start gap-3 py-2.5" title="This chat was deleted">
            {body}
          </div>
        )}
      </li>
    )
  }

  const Icon = e.kind === 'allowance' ? RefreshCw : CreditCard
  const label = { allowance: 'Included usage added', topup: 'Usage credit added', plan: 'Plan changed', usage: '' }[e.kind]
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px]">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {e.description}
          {e.paid_usd ? ` · paid ${formatCost(e.paid_usd, { cents: true })}` : ''} · {time}
        </span>
      </span>
      {amount}
    </li>
  )
}
