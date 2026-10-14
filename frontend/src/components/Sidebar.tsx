import { useEffect, useState } from 'react'
import {
  BarChart3,
  ChevronRight,
  Columns2,
  CreditCard,
  Lock,
  LockKeyhole,
  Monitor,
  Moon,
  Plus,
  Shield,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import { href, navigate, type Route } from '@/lib/route'
import { expandFolder, lock, openSecureChat, useSecure } from '@/lib/secure-store'
import type { ConversationSummary } from '@/lib/types'
import { useTheme, type Theme } from '@/lib/theme'
import { cn, formatCost } from '@/lib/utils'

interface Props {
  route: Route
  open: boolean
  onClose: () => void
}

const NAV = [
  { page: 'compare', label: 'Compare models', icon: Columns2 },
  { page: 'usage', label: 'Usage', icon: BarChart3 },
  { page: 'skills', label: 'Skills', icon: Sparkles },
  { page: 'plans', label: 'Plan & billing', icon: CreditCard },
  { page: 'privacy', label: 'Privacy & data', icon: Shield },
] as const

function ChatRow({
  c,
  active,
  onClick,
  href: to,
}: {
  c: ConversationSummary
  active: boolean
  onClick: (e: React.MouseEvent) => void
  href: string
}) {
  return (
    <li>
      <a
        href={to}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
          active && 'bg-muted font-medium',
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {c.skill_name && <Sparkles className="size-3.5 shrink-0 text-primary" aria-label="Skill chat" />}
          <span className="truncate">{c.title}</span>
        </span>
        {c.spend_usd > 0 && <span className="shrink-0 text-xs font-normal text-cost">{formatCost(c.spend_usd)}</span>}
      </a>
    </li>
  )
}

/** The PIN-protected folder at the top of the chat list. */
function SecureFolder({ route, onClose }: { route: Route; onClose: () => void }) {
  const { status, expanded, chats } = useSecure()
  // Keep the last list on screen while the folder animates closed; it's
  // inert and hidden from assistive tech during that time.
  const [shown, setShown] = useState(chats)
  useEffect(() => {
    if (expanded) setShown(chats)
  }, [expanded, chats])
  if (!status?.visible) return null

  // Only Lock (or opening a non-secure chat) closes it.
  const open = () => {
    if (!expanded) void expandFolder()
  }

  return (
    <li className="mb-1">
      <div className="flex items-center">
        <button
          type="button"
          onClick={open}
          aria-expanded={expanded}
          title={expanded ? 'Use Lock to close the secure folder' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
          <LockKeyhole className="size-3.5 shrink-0 text-primary" />
          <span className="font-medium">Secure</span>
          {!status.pin_set && <span className="text-xs text-muted-foreground">· set up</span>}
        </button>
        {expanded && (
          <button
            type="button"
            onClick={lock}
            className="mr-1 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-ink"
            title="Lock the secure folder"
          >
            <Lock className="size-3" /> Lock
          </button>
        )}
      </div>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        inert={!expanded}
        aria-hidden={!expanded}
        onTransitionEnd={() => !expanded && setShown([])}
      >
        <ul className="ml-4 min-h-0 overflow-hidden border-l border-border pl-1.5">
          {shown.length === 0 && (
            <li className="px-2.5 py-1.5 text-[13px] text-muted-foreground">
              Empty. Use the lock button on a chat to move it here.
            </li>
          )}
          {shown.map((c) => (
            <ChatRow
              key={c.id}
              c={c}
              active={route.page === 'chat' && route.id === c.id}
              href={href({ page: 'chat', id: c.id })}
              onClick={(e) => {
                e.preventDefault()
                openSecureChat(c.id) // the folder stays open
                navigate({ page: 'chat', id: c.id })
                onClose()
              }}
            />
          ))}
        </ul>
      </div>
    </li>
  )
}

export function Sidebar({ route, open, onClose }: Props) {
  const { conversations, me } = useAppData()
  const secure = useSecure()
  const [theme, setTheme] = useTheme()

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
          <SecureFolder route={route} onClose={onClose} />
          {conversations.length === 0 && !secure.status?.pin_set && (
            <li className="px-2.5 py-1 text-[13px] text-muted-foreground">Your chats will appear here.</li>
          )}
          {conversations.map((c) => (
            <ChatRow
              key={c.id}
              c={c}
              active={route.page === 'chat' && route.id === c.id}
              href={href({ page: 'chat', id: c.id })}
              onClick={onClose}
            />
          ))}
        </ul>

        <div className="flex items-center justify-between border-t border-border px-5 py-2.5">
          <span className="text-xs text-muted-foreground">Theme</span>
          <div role="radiogroup" aria-label="Theme" className="flex rounded-md border border-border bg-muted p-0.5">
            {(
              [
                { v: 'system', icon: Monitor, label: 'Match system' },
                { v: 'light', icon: Sun, label: 'Light' },
                { v: 'dark', icon: Moon, label: 'Dark' },
              ] as { v: Theme; icon: typeof Sun; label: string }[]
            ).map(({ v, icon: Icon, label }) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={theme === v}
                aria-label={label}
                title={label}
                onClick={() => setTheme(v)}
                className={cn(
                  'grid size-7 place-items-center rounded-[5px] focus-visible:outline-2 focus-visible:outline-ring',
                  theme === v ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(28_36_48/0.12)]' : 'text-muted-foreground hover:text-ink',
                )}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </div>
        {me && (
          <a
            href={href({ page: 'plans' })}
            onClick={onClose}
            className="block border-t border-border px-5 py-3.5 text-xs text-muted-foreground hover:bg-muted"
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
