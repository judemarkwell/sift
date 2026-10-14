import { useEffect, useState } from 'react'
import { Check, Menu } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, PageHeader } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import { cn, formatCost, formatDate } from '@/lib/utils'
import type { BillingResponse, CheckoutSession, Plan } from '@/lib/types'

const KIND_LABEL = { allowance: 'Included usage', usage: 'Usage', topup: 'Top-up', plan: 'Plan change' } as const

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

        <section className="mt-12">
          <h2 className="text-[16px] font-semibold">Activity</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">What</th>
                  <th className="py-2 pr-3 text-right font-medium">Paid</th>
                  <th className="py-2 text-right font-medium">Usage balance</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((e) => (
                  <tr key={e.id} className="border-b border-border/70">
                    <td className="py-2 pr-3 text-muted-foreground">{formatDate(e.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td className="py-2 pr-3">
                      {KIND_LABEL[e.kind]}
                      <span className="text-muted-foreground"> · {e.description}</span>
                    </td>
                    <td className="py-2 pr-3 text-right">{e.paid_usd ? formatCost(e.paid_usd, { cents: true }) : ''}</td>
                    <td className={cn('py-2 text-right', e.amount_usd < 0 ? 'text-muted-foreground' : 'text-primary')}>
                      {e.amount_usd > 0 ? '+' : ''}
                      {formatCost(e.amount_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
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
