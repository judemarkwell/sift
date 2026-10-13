import { useCallback, useState } from 'react'
import { Plus } from 'lucide-react'

import { Composer } from '@/components/Composer'
import { MessageList } from '@/components/MessageList'
import { ModelPicker } from '@/components/ModelPicker'
import { Sidebar } from '@/components/Sidebar'
import { TracePanel } from '@/components/TracePanel'
import { Button } from '@/components/ui/button'
import { useChat } from '@/hooks/useChat'

export default function App() {
  const chat = useChat()
  const [prefill, setPrefill] = useState<string | null>(null)
  const clearPrefill = useCallback(() => setPrefill(null), [])
  const { active, models } = chat
  const model = models.find((m) => m.id === active?.modelId)

  if (chat.loadError) {
    return (
      <main className="grid h-full place-items-center px-6">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold">Sift can't reach its API</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {chat.loadError}. Start the backend with{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">uvicorn app.main:app --reload</code>{' '}
            from the <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">backend</code> folder, then
            reload this page.
          </p>
        </div>
      </main>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={chat.conversations}
        activeId={active?.id ?? null}
        onSelect={chat.selectConversation}
        onNew={chat.startNew}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <ModelPicker models={models} value={active?.modelId ?? ''} onChange={chat.setModel} disabled={chat.isStreaming} />
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={chat.startNew}>
            <Plus /> New chat
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto">
          <MessageList
            messages={active?.messages ?? []}
            models={models}
            selectedTraceId={chat.traceMessage?.id ?? null}
            onInspect={(id) => chat.openTrace(id || null)}
            onSuggest={setPrefill}
          />
        </div>
        <Composer
          messages={active?.messages ?? []}
          model={model}
          isStreaming={chat.isStreaming}
          prefill={prefill}
          onPrefillUsed={clearPrefill}
          onSend={chat.send}
          onStop={chat.stop}
        />
      </main>

      {chat.traceMessage?.trace && (
        <div className="fixed inset-0 z-40 md:static md:z-auto">
          <TracePanel
            key={chat.traceMessage.id}
            message={chat.traceMessage}
            model={models.find((m) => m.id === chat.traceMessage?.modelId)}
            onClose={() => chat.openTrace(null)}
          />
        </div>
      )}
    </div>
  )
}
