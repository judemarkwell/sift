import { useEffect, useState } from 'react'
import { Download, Menu, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, PageHeader, Segmented } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import type { AuditEntry } from '@/lib/types'

const RETENTION = [
  { value: 'forever', label: 'Keep' },
  { value: '365', label: '1 year' },
  { value: '90', label: '90 days' },
  { value: '30', label: '30 days' },
  { value: '7', label: '7 days' },
] as const

const ACTION_LABEL: Record<string, string> = {
  'skill.update': 'Changed a pipeline skill',
  'workspace_policy.update': 'Changed workspace policy',
  'billing.checkout': 'Changed plan or added credit',
  'prompt_skill.create': 'Created a skill',
  'prompt_skill.update': 'Edited a skill',
  'prompt_skill.delete': 'Deleted a skill',
  'privacy.retention': 'Changed data retention',
  'data.export': 'Exported their data',
  'data.delete': 'Deleted their data',
}

export function PrivacyPage({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { me, refreshConversations } = useAppData()
  const [retention, setRetention] = useState<string>('forever')
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    api.privacy().then((r) => setRetention(r.retention_days ? String(r.retention_days) : 'forever'))
    if (me?.principal.role === 'admin') api.audit().then(setAudit).catch(() => setAudit([]))
  }, [me?.principal.role])

  const changeRetention = async (v: string) => {
    setRetention(v)
    await api.setRetention(v === 'forever' ? null : Number(v))
    setNotice(v === 'forever' ? 'Chats are kept until you delete them.' : `Chats and traces older than ${v} days are now deleted automatically.`)
    void refreshConversations()
    if (me?.principal.role === 'admin') api.audit().then(setAudit)
  }

  const download = async () => {
    const text = await api.exportData()
    const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
    Object.assign(document.createElement('a'), { href: url, download: 'sift-export.json' }).click()
    URL.revokeObjectURL(url)
    if (me?.principal.role === 'admin') api.audit().then(setAudit)
  }

  const erase = async () => {
    const r = await api.deleteData()
    setConfirming(false)
    setTyped('')
    setNotice(
      `Deleted ${r.deleted.conversations} chats, ${r.deleted.traces} traces, ${r.deleted.uploads} images and ${r.deleted.prompt_skills} skills. ${r.kept}`,
    )
    void refreshConversations()
    if (me?.principal.role === 'admin') api.audit().then(setAudit)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[48rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader
          title="Privacy & data"
          description="What Sift keeps, for how long, and how to take it with you or delete it."
        />

        {notice && (
          <p role="status" className="mb-6 rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-sm">
            {notice}
          </p>
        )}

        <section className="border-y border-border py-6">
          <h2 className="text-[16px] font-semibold">Your data</h2>
          <div className="mt-4 flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="max-w-[26rem]">
                <p className="text-sm font-medium">Keep chats for</p>
                <p className="text-[13px] text-muted-foreground">
                  Older chats, their traces and images are deleted automatically.
                </p>
              </div>
              <Segmented size="sm" label="Retention" value={retention} onChange={(v) => void changeRetention(v)} options={RETENTION.map((r) => ({ ...r }))} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="max-w-[26rem]">
                <p className="text-sm font-medium">Download your data</p>
                <p className="text-[13px] text-muted-foreground">
                  Every chat, trace, skill and setting as one JSON file.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void download()}>
                <Download /> Download
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="max-w-[26rem]">
                <p className="text-sm font-medium">Delete your data</p>
                <p className="text-[13px] text-muted-foreground">
                  Permanently removes your chats, traces, images, skills and settings. This can't be undone.
                </p>
              </div>
              <Button variant="outline" size="sm" className="border-danger/50 text-danger hover:bg-danger/10" onClick={() => setConfirming(true)}>
                <Trash2 /> Delete everything
              </Button>
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-[16px] font-semibold">How Sift handles your data</h2>
          <dl className="mt-4 grid gap-x-8 gap-y-4 text-[14px] leading-relaxed sm:grid-cols-2">
            {[
              ['What leaves Sift', 'Only the messages you send, after redaction, go to the model provider you pick. Each trace shows exactly what was sent.'],
              ['Personal data', 'PII redaction replaces or blocks personal details before they leave. Blocked values are never sent, logged or saved.'],
              ['Logs', 'Traces store only the redacted text. The map from placeholders to real values is kept per chat, separately.'],
              ['Images', "Re-encoded on upload, which removes location and camera details. Images aren't scanned for personal data, so check before sending."],
              ['Training', "Sift never uses your conversations to train models. Model providers handle requests under their own API terms; Anthropic's commercial terms say API data isn't used for training by default."],
              ['Cookies', 'No tracking or advertising cookies. Your browser stores only your theme choice.'],
            ].map(([t, d]) => (
              <div key={t}>
                <dt className="font-medium">{t}</dt>
                <dd className="text-muted-foreground">{d}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-8 text-sm font-semibold">Service providers</h3>
          <ul className="mt-2 text-[14px] text-muted-foreground">
            <li>Anthropic: model provider for Claude (only when you choose a Claude model)</li>
            <li>Amazon Web Services: hosting, storage, sign-in and PII detection (when deployed)</li>
            <li>Stripe: payments (when enabled); Sift never sees card numbers</li>
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="text-[16px] font-semibold">Policies</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Drafts for review. Have them checked by a lawyer before launch.
          </p>
          <details className="mt-3 rounded-lg border border-border bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">Privacy policy (draft)</summary>
            <div className="prose-reply mt-3 text-[14px]">
              <p>
                <strong>Who we are.</strong> Sift ("we") provides an AI chat service that shows how each request is
                handled. This policy explains what personal data we process and why.
              </p>
              <p>
                <strong>What we collect.</strong> Account details (email, workspace), the content you send and receive,
                request metadata (model, tokens, cost, timing), uploaded images, your settings, and billing records.
              </p>
              <p>
                <strong>How we use it.</strong> To provide the service you request, show you traces and usage, enforce
                plan limits and spending caps, prevent abuse, and meet legal obligations. We don't sell personal data or
                use your content to train models.
              </p>
              <p>
                <strong>Sharing.</strong> We send your messages, after any redaction you've configured, to the model
                provider you select, and use the service providers listed on this page to run Sift. Each is bound by
                contract to protect your data.
              </p>
              <p>
                <strong>Retention.</strong> You choose how long chats are kept. Billing records are kept as long as
                accounting law requires; they contain no message content.
              </p>
              <p>
                <strong>Your rights.</strong> You can access and download your data, delete it, and change retention on
                this page at any time. Depending on where you live (for example under the GDPR or CCPA) you may have
                further rights, including objecting to processing or complaining to a regulator.
              </p>
              <p>
                <strong>Security.</strong> Data is encrypted in transit and at rest when deployed. Access is limited to
                your workspace, and admin actions are recorded in an audit log.
              </p>
              <p>
                <strong>Children.</strong> Sift isn't intended for anyone under 18.
              </p>
            </div>
          </details>
          <details className="mt-2 rounded-lg border border-border bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">Terms of use (draft)</summary>
            <div className="prose-reply mt-3 text-[14px]">
              <p>
                <strong>AI output.</strong> Replies are generated by AI models and can be wrong, incomplete or out of
                date. Check anything important, and don't rely on Sift for medical, legal or financial decisions.
              </p>
              <p>
                <strong>Acceptable use.</strong> You agree to follow the usage policies of the model providers you use and
                not to use Sift for anything unlawful or harmful.
              </p>
              <p>
                <strong>Your content.</strong> You own what you send and receive. You give us permission to process it
                only to provide the service.
              </p>
              <p>
                <strong>Plans and billing.</strong> Plans renew monthly. Included usage resets each period; top-up credit
                doesn't expire. Model usage is charged at the provider's published price, shown before and after each
                message.
              </p>
            </div>
          </details>
        </section>

        {audit && (
          <section className="mt-10">
            <h2 className="text-[16px] font-semibold">Audit log</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Changes to settings, plans and data in your workspace. Only admins see this.
            </p>
            {audit.length ? (
              <ol className="mt-3 divide-y divide-border/70 border-y border-border text-[13px]">
                {audit.slice(0, 50).map((e, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                    <span>
                      {ACTION_LABEL[e.action] ?? e.action}
                      {e.target && <span className="text-muted-foreground"> · {e.target}</span>}
                    </span>
                    <span className="text-muted-foreground">
                      {e.actor} · {formatDate(e.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-[13px] text-muted-foreground">Nothing yet.</p>
            )}
          </section>
        )}
      </div>

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Delete all your data?">
        <p className="text-sm leading-relaxed text-muted-foreground">
          This permanently deletes every chat, trace, image and skill you've made, and resets your settings. Download
          your data first if you want a copy.
        </p>
        <label htmlFor="confirm-delete" className="mt-4 block text-sm">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="confirm-delete"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button className="bg-danger hover:bg-danger/90" disabled={typed !== 'DELETE'} onClick={() => void erase()}>
            Delete everything
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
