import { useEffect, useState } from 'react'

import { ChatPage } from '@/components/chat/ChatPage'
import { PinDialog } from '@/components/PinDialog'
import { ComparePage } from '@/components/pages/ComparePage'
import { PlansPage } from '@/components/pages/PlansPage'
import { PrivacyPage } from '@/components/pages/PrivacyPage'
import { SkillsPage } from '@/components/pages/SkillsPage'
import { UsagePage } from '@/components/pages/UsagePage'
import { Sidebar } from '@/components/Sidebar'
import { AppDataProvider, useAppData } from '@/hooks/useAppData'
import { useRoute } from '@/lib/route'
import { onRouteChange, refreshSecureStatus } from '@/lib/secure-store'

function Shell() {
  const route = useRoute()
  const { loadError } = useAppData()
  const [menuOpen, setMenuOpen] = useState(false)
  const openMenu = () => setMenuOpen(true)

  useEffect(() => {
    void refreshSecureStatus()
  }, [])

  // Leaving the open secure chat ends access to it.
  useEffect(() => onRouteChange(route.page, route.id), [route.page, route.id])

  useEffect(() => {
    const titles = {
      chat: 'Sift',
      compare: 'Compare · Sift',
      usage: 'Usage · Sift',
      skills: 'Skills · Sift',
      plans: 'Plan · Sift',
      privacy: 'Privacy · Sift',
    }
    document.title = titles[route.page]
  }, [route.page])

  if (loadError) {
    return (
      <main className="grid h-full place-items-center px-6">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold">Sift can't reach its API</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {loadError}. Start the backend with{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">docker compose up</code> (or{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">uvicorn app.main:app --reload</code> in{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">backend</code>), then reload this page.
          </p>
        </div>
      </main>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar route={route} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <PinDialog />
      <div className="flex min-w-0 flex-1">
        {route.page === 'chat' && <ChatPage conversationId={route.id} onOpenMenu={openMenu} />}
        {route.page === 'compare' && <ComparePage comparisonId={route.id} onOpenMenu={openMenu} />}
        {route.page === 'usage' && <UsagePage onOpenMenu={openMenu} />}
        {route.page === 'skills' && <SkillsPage sub={route.id} onOpenMenu={openMenu} />}
        {route.page === 'privacy' && <PrivacyPage onOpenMenu={openMenu} />}
        {route.page === 'plans' && <PlansPage onOpenMenu={openMenu} />}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  )
}
