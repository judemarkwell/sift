import { useCallback, useState } from 'react'
import { Download, Menu, Sparkles } from 'lucide-react'

import { Composer } from '@/components/chat/Composer'
import { SkillLauncher } from '@/components/chat/SkillLauncher'
import { MessageList } from '@/components/chat/MessageList'
import { TracePanel } from '@/components/chat/TracePanel'
import { ModelPicker } from '@/components/ModelPicker'
import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import { useChat } from '@/hooks/useChat'
import { api } from '@/lib/api'
import { href } from '@/lib/route'

const SUGGESTIONS = [
  { text: 'Draft a reply to jane.doe@acme.com confirming Thursday. My cell is (502) 555-0142.', note: 'see PII redaction work' },
  { text: '/tldr What is the difference between a process and a thread?', note: 'try an output style' },
  { text: 'Here is my key sk-ant-api03-AbCdEfGhIjKlMnOp, why does it fail?', note: 'a secret Sift catches' },
]

export function ChatPage({ conversationId, onOpenMenu }: { conversationId?: string; onOpenMenu: () => void }) {
  const { models } = useAppData()
  const chat = useChat(conversationId)
  const [prefill, setPrefill] = useState<string | null>(null)
  const [skillFormOpen, setSkillFormOpen] = useState(false)
  const clearPrefill = useCallback(() => setPrefill(null), [])
  const model = models.find((m) => m.id === chat.modelId)
  const selectedModel = models.find((m) => m.id === chat.selected?.model_id)

  const exportReport = async () => {
    if (!conversationId) return
    const text = await api.report(conversationId)
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: 'sift-transparency-report.md' })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-3 py-3 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
            <Menu />
          </Button>
          <ModelPicker models={models} value={chat.modelId} onChange={chat.setModelId} disabled={chat.isStreaming} />
          {chat.skillName && (
            <span
              className="hidden items-center gap-1.5 truncate rounded-md bg-primary-soft px-2 py-1 text-[12.5px] font-medium sm:inline-flex"
              title="This chat follows a saved skill's instructions on every turn"
            >
              <Sparkles className="size-3.5 text-primary" />
              {chat.skillName}
            </span>
          )}
          <div className="flex-1" />
          {conversationId && chat.messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void exportReport()} title="Download this conversation as a transparency report">
              <Download /> <span className="hidden sm:inline">Report</span>
            </Button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          {chat.notFound ? (
            <div className="mx-auto max-w-[36rem] px-6 pt-24 text-center">
              <p className="text-lg font-semibold">This chat doesn't exist anymore</p>
              <p className="mt-2 text-sm text-muted-foreground">
                It may have been deleted. <a className="text-primary underline" href={href({ page: 'chat' })}>Start a new chat</a>.
              </p>
            </div>
          ) : chat.messages.length === 0 && !chat.loading ? (
            <div className="mx-auto flex min-h-full max-w-[44rem] flex-col justify-center px-6 py-10">
{!skillFormOpen && (
                <>
              <h1 className="max-w-[30rem] text-[30px] font-semibold leading-[1.15] tracking-[-0.015em]">
                Ask anything. See everything it took.
              </h1>
              <p className="mt-3 max-w-[34rem] text-[15px] leading-relaxed text-muted-foreground">
                Every reply shows its tokens, cost and timing. Personal details are caught before they leave, and each
                reply's trace shows exactly what the model received.
              </p>
              <ul className="mt-8 flex flex-col items-start gap-2">
                {SUGGESTIONS.map((s) => (
                  <li key={s.text}>
                    <button
                      type="button"
                      onClick={() => setPrefill(s.text)}
                      className="rounded-md border border-border bg-surface px-3.5 py-2 text-left text-sm hover:border-primary/50 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {s.text}
                      <span className="ml-2 text-xs text-muted-foreground">({s.note})</span>
                    </button>
                  </li>
                ))}
              </ul>
                </>
              )}
              <SkillLauncher onStart={chat.send} onOpenChange={setSkillFormOpen} />
            </div>
          ) : (
            <MessageList
              messages={chat.messages}
              models={models}
              selectedId={chat.selected?.id ?? null}
              onInspect={(id) => void chat.inspect(id)}
              onContinue={(id) => void chat.continueReply(id)}
              busy={chat.isStreaming}
            />
          )}
        </div>

        {chat.sendError && (
          <div className="mx-auto w-full max-w-[44rem] px-4 sm:px-6">
            <div role="alert" className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-cost/40 bg-cost/5 px-3 py-2 text-[13px]">
              <p>
                {chat.sendError.message}{' '}
                {['model_not_in_plan', 'out_of_usage', 'feature_not_in_plan'].includes(chat.sendError.code ?? '') && (
                  <a className="font-medium text-primary underline" href={href({ page: 'plans' })}>
                    See plans
                  </a>
                )}
              </p>
              <button type="button" className="text-muted-foreground hover:text-ink" onClick={chat.clearSendError} aria-label="Dismiss">
                ×
              </button>
            </div>
          </div>
        )}

        <Composer
          key={conversationId ?? 'new'}
          messages={chat.messages}
          model={model}
          isStreaming={chat.isStreaming}
          prefill={prefill}
          onPrefillUsed={clearPrefill}
          onSend={chat.send}
          onStop={chat.stop}
          autoFocus
        />
      </main>

      {chat.selected && (
        <div className="fixed inset-0 z-40 md:static md:z-auto">
          <TracePanel
            key={chat.selected.id}
            message={chat.selected}
            model={selectedModel}
            onClose={() => void chat.inspect(null)}
          />
        </div>
      )}
    </div>
  )
}
