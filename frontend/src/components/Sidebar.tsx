import { BarChart3, Columns2, CreditCard, Plus, SlidersHorizontal, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import { href, type Route } from '@/lib/route'
import { cn, formatCost } from '@/lib/utils'

interface Props {
  route: Route
  open: boolean
  onClose: () => void
}

const NAV = [
  { page: 'compare', label: 'Compare models', icon: Columns2 },
  { page: 'usage', label: 'Usage', icon: BarChart3 },
  { page: 'skills', label: 'Skills', icon: SlidersHorizontal },
  { page: 'plans', label: 'Plan & billing', icon: CreditCard },
] as const

export function Sidebar({ route, open, onClose }: Props) {
  const { conversations, me } = useAppData()

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-[rgb(18_23_29/0.4)] lg:hidden" onClick={onClose} aria-hidden />}
      <nav
        aria-label="Main"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-ground transition-transform lg:static lg:w-64 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 pb-4 pt-5">
          <a href={href({ page: 'chat' })} className="flex items-center gap-2.5" onClick={onClose}>
            <img src="/favicon.svg" alt="" className="size-6" />
            <span className="text-[17px] font-bold tracking-[-0.01em]">Sift</span>
          </a>
          <Button variant="ghost" size="icon" className="size-8 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X />
          </Button>
        </div>
        <div className="px-3">
          <Button asChild variant="outline" className="w-full justify-start">
            <a href={href({ page: 'chat' })} onClick={onClose}>
              <Plus /> New chat
            </a>
          </Button>
        </div>
        <ul className="mt-3 px-3">
          {NAV.map(({ page, label, icon: Icon }) => (
            <li key={page}>
              <a
                href={href({ page })}
                onClick={onClose}
                aria-current={route.page === page ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-ink/85 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                  route.page === page && 'bg-muted font-medium text-ink',
                )}
              >
                <Icon className="size-4 text-muted-foreground" />
                {label}
              </a>
            </li>
          ))}
        </ul>

        <p className="mt-5 px-5 pb-1.5 text-xs font-medium text-muted-foreground">Chats</p>
        <ul className="flex-1 overflow-y-auto px-3 pb-3">
          {conversations.length === 0 && (
            <li className="px-2.5 py-1 text-[13px] text-muted-foreground">Your chats will appear here.</li>
          )}
          {conversations.map((c) => {
            const active = route.page === 'chat' && route.id === c.id
            return (
              <li key={c.id}>
                <a
                  href={href({ page: 'chat', id: c.id })}
                  onClick={onClose}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                    active && 'bg-muted font-medium',
                  )}
                >
                  <span className="truncate">{c.title}</span>
                  {c.spend_usd > 0 && <span className="shrink-0 text-xs font-normal text-cost">{formatCost(c.spend_usd)}</span>}
                </a>
              </li>
            )
          })}
        </ul>

        {me && (
          <a
            href={href({ page: 'plans' })}
            onClick={onClose}
            className="block border-t border-border px-5 py-4 text-xs text-muted-foreground hover:bg-muted"
          >
            <span className="flex items-baseline justify-between">
              <span className="font-medium text-ink">{me.plan_name} plan</span>
              <span>
                <span className="font-medium text-cost">{formatCost(me.available_usd, { cents: true })}</span> left
              </span>
            </span>
            <span className="mt-1 block truncate">{me.principal.email}</span>
          </a>
        )}
      </nav>
    </>
  )
}
