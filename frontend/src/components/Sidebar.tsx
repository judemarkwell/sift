import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn, formatCost } from '@/lib/utils'
import type { Conversation } from '@/lib/types'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}

const spend = (c: Conversation) =>
  c.messages.reduce((sum, m) => sum + (m.trace?.response.cost.total_usd ?? 0), 0)

export function Sidebar({ conversations, activeId, onSelect, onNew }: Props) {
  const total = conversations.reduce((sum, c) => sum + spend(c), 0)

  return (
    <nav aria-label="Conversations" className="hidden w-64 shrink-0 flex-col border-r border-border lg:flex">
      <div className="flex items-center gap-2.5 px-5 pb-5 pt-5">
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="text-[17px] font-bold tracking-[-0.01em]">Sift</span>
      </div>
      <div className="px-3">
        <Button variant="outline" className="w-full justify-start" onClick={onNew}>
          <Plus /> New chat
        </Button>
      </div>
      <ul className="mt-4 flex-1 overflow-y-auto px-3">
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              aria-current={c.id === activeId ? 'page' : undefined}
              className={cn(
                'flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                c.id === activeId && 'bg-muted font-medium',
              )}
            >
              <span className="truncate">{c.title}</span>
              {spend(c) > 0 && <span className="shrink-0 text-xs font-normal text-cost">{formatCost(spend(c))}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">
        <p>
          Spent this session <span className="font-medium text-cost">{formatCost(total)}</span>
        </p>
        <p className="mt-1">Personal workspace</p>
      </div>
    </nav>
  )
}
