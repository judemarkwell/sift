import { useEffect, useState } from 'react'
import { ArrowLeft, Menu, Plus, Trash2, Users } from 'lucide-react'

import { PipelineSkills } from '@/components/pages/PipelineSkills'
import { Button } from '@/components/ui/button'
import { Dialog, PageHeader, Switch } from '@/components/ui/controls'
import { useAppData } from '@/hooks/useAppData'
import { ApiError, api } from '@/lib/api'
import { SKILL_ICONS, SkillIcon } from '@/lib/icons'
import { href, navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import type { PromptSkill, PromptSkillInput, PromptSkillTemplate, PromptSkillsResponse, SkillField } from '@/lib/types'

/**
 * Skills, two kinds:
 *  - My skills: reusable tasks the user sets up (instructions + the details to collect), started from new-chat buttons.
 *  - Pipeline: built-in skills that run inside every request (PII redaction, cost meter, ...).
 */
export function SkillsPage({ sub, onOpenMenu }: { sub?: string; onOpenMenu: () => void }) {
  const tab = sub === 'pipeline' ? 'pipeline' : 'mine'
  const editing = sub && sub !== 'pipeline' ? sub : null // "new" or a skill id

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        {editing ? (
          <SkillEditor id={editing} />
        ) : (
          <>
            <PageHeader title="Skills" />
            <nav aria-label="Skill types" className="-mt-2 mb-6 flex gap-6 border-b border-border text-sm">
              {[
                { id: undefined, label: 'My skills' },
                { id: 'pipeline', label: 'Pipeline' },
              ].map((t) => {
                const on = (t.id ?? 'mine') === tab
                return (
                  <a
                    key={t.label}
                    href={href({ page: 'skills', id: t.id })}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      '-mb-px border-b-2 pb-2.5 font-medium',
                      on ? 'border-primary text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
                    )}
                  >
                    {t.label}
                  </a>
                )
              })}
            </nav>
            {tab === 'pipeline' ? <PipelineSkills /> : <MySkills />}
          </>
        )}
      </div>
    </div>
  )
}

function MySkills() {
  const { me } = useAppData()
  const [data, setData] = useState<PromptSkillsResponse | null>(null)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [deleting, setDeleting] = useState<PromptSkill | null>(null)

  const load = () => api.promptSkills().then(setData).catch((e: Error) => setError({ message: e.message }))
  useEffect(() => {
    void load()
  }, [])

  if (!data) return <p className="text-sm text-muted-foreground">{error?.message ?? 'Loading…'}</p>

  const mine = data.skills.filter((s) => s.mine)
  const atLimit = data.limit !== null && mine.length >= data.limit

  const addTemplate = async (t: PromptSkillTemplate) => {
    setError(null)
    try {
      const s = await api.createPromptSkill({ ...t, ask_for_missing: true, shared: false, pinned: true })
      navigate({ page: 'skills', id: s.id })
    } catch (e) {
      setError({ message: (e as Error).message, code: e instanceof ApiError ? e.code : undefined })
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-[36rem] text-[14px] leading-relaxed text-muted-foreground">
          Save a task you do often. A skill shows up as a button on new chats, asks for the details it needs, and keeps
          its instructions for the whole conversation.
        </p>
        <Button asChild={!atLimit} disabled={atLimit}>
          {atLimit ? (
            <span>
              <Plus /> New skill
            </span>
          ) : (
            <a href={href({ page: 'skills', id: 'new' })}>
              <Plus /> New skill
            </a>
          )}
        </Button>
      </div>
      {atLimit && (
        <p className="mb-4 text-[13px] text-muted-foreground">
          {me?.plan_name} includes {data.limit} skills.{' '}
          <a className="text-primary underline" href={href({ page: 'plans' })}>
            Upgrade for unlimited
          </a>
          , or delete one.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error.message}
        </p>
      )}

      {data.skills.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {data.skills.map((s) => (
            <li key={s.id} className="flex items-start gap-4 py-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                <SkillIcon name={s.icon} className="size-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 font-medium">
                  {s.name}
                  {s.shared && (
                    <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                      <Users className="size-3.5" /> Shared with workspace
                    </span>
                  )}
                </p>
                {s.description && <p className="text-[13px] text-muted-foreground">{s.description}</p>}
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.fields.length ? `Asks for ${s.fields.map((f) => f.label.toLowerCase()).join(', ')}` : 'No inputs'}
                  {' · '}
                  Used {s.use_count} time{s.use_count === 1 ? '' : 's'}
                  {!s.pinned && ' · hidden from new chats'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {s.mine && (
                  <Button asChild variant="ghost" size="sm">
                    <a href={href({ page: 'skills', id: s.id })}>Edit</a>
                  </Button>
                )}
                {s.mine && (
                  <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-y border-border py-8 text-center text-sm text-muted-foreground">
          No skills yet. Start from a template below, or make your own.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold">Start from a template</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Adds a copy you can edit.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {data.templates.map((t) => (
            <li key={t.name}>
              <button
                type="button"
                disabled={atLimit}
                onClick={() => void addTemplate(t)}
                className="flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-left hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              >
                <SkillIcon name={t.icon} className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">{t.name}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">{t.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={`Delete “${deleting?.name}”?`}>
        <p className="text-sm text-muted-foreground">
          Chats that already used it keep working; it just won't be offered for new chats.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button
            className="bg-danger hover:bg-danger/90"
            onClick={async () => {
              if (deleting) await api.deletePromptSkill(deleting.id)
              setDeleting(null)
              void load()
            }}
          >
            Delete skill
          </Button>
        </div>
      </Dialog>
    </>
  )
}

const EMPTY: PromptSkillInput = {
  name: '',
  description: '',
  icon: 'sparkles',
  instructions: '',
  fields: [],
  starter: '',
  styles: [],
  ask_for_missing: true,
  shared: false,
  pinned: true,
}

const keyFrom = (label: string, taken: string[]) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 30) || 'detail'
  let key = base
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`
  return key
}

function SkillEditor({ id }: { id: string }) {
  const { styles } = useAppData()
  const isNew = id === 'new'
  const [form, setForm] = useState<PromptSkillInput>(EMPTY)
  const [canShare, setCanShare] = useState(false)
  const [loaded, setLoaded] = useState(isNew)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.promptSkills().then((r) => {
      setCanShare(r.can_share)
      if (!isNew) {
        const s = r.skills.find((x) => x.id === id)
        if (s) {
          const { name, description, icon, instructions, fields, starter, styles: st, ask_for_missing, shared, pinned } = s
          setForm({ name, description, icon, instructions, fields, starter, styles: st, ask_for_missing, shared, pinned })
        } else setError('That skill no longer exists.')
        setLoaded(true)
      }
    })
  }, [id, isNew])

  const set = <K extends keyof PromptSkillInput>(k: K, v: PromptSkillInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setField = (i: number, patch: Partial<SkillField>) =>
    set('fields', form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (isNew) await api.createPromptSkill(form)
      else await api.updatePromptSkill(id, form)
      navigate({ page: 'skills' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>

  const input =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-ring'
  const unknownVars = [...form.starter.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)]
    .map((m) => m[1])
    .filter((k) => !form.fields.some((f) => f.key === k))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <a href={href({ page: 'skills' })} className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-ink">
        <ArrowLeft className="size-3.5" /> Skills
      </a>
      <PageHeader title={isNew ? 'New skill' : `Edit ${form.name || 'skill'}`} description="A skill is a set of instructions plus the details it should ask for. It stays active for the whole chat it starts." />

      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="ps-name" className="mb-1 block text-[13px] font-medium">
              Name
            </label>
            <input id="ps-name" required maxLength={60} className={input} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Weekly status update" />
          </div>
          <fieldset>
            <legend className="mb-1 text-[13px] font-medium">Icon</legend>
            <div className="flex flex-wrap gap-1">
              {Object.keys(SKILL_ICONS).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={k}
                  aria-pressed={form.icon === k}
                  onClick={() => set('icon', k)}
                  className={cn(
                    'grid size-8 place-items-center rounded-md border focus-visible:outline-2 focus-visible:outline-ring',
                    form.icon === k ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted-foreground hover:text-ink',
                  )}
                >
                  <SkillIcon name={k} className="size-4" />
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div>
          <label htmlFor="ps-desc" className="mb-1 block text-[13px] font-medium">
            Short description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input id="ps-desc" maxLength={200} className={input} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>

        <div>
          <label htmlFor="ps-instr" className="mb-1 block text-[13px] font-medium">
            Instructions
          </label>
          <p className="mb-1.5 text-xs text-muted-foreground">
            What should the model do, and how? These are sent with every message in chats that use this skill.
          </p>
          <textarea
            id="ps-instr"
            required
            rows={6}
            maxLength={8000}
            className={input}
            value={form.instructions}
            onChange={(e) => set('instructions', e.target.value)}
            placeholder="e.g. Turn my notes into a status update with Done, In progress and Blockers. One line per bullet."
          />
        </div>

        <fieldset>
          <legend className="text-[13px] font-medium">Details to ask for</legend>
          <p className="mb-2 text-xs text-muted-foreground">
            Shown as a short form when someone starts the skill. Values go in the first message, so PII redaction still
            applies.
          </p>
          <ul className="flex flex-col gap-2">
            {form.fields.map((f, i) => (
              <li key={i} className="grid gap-2 rounded-lg border border-border bg-surface p-3 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  aria-label="Label"
                  required
                  maxLength={80}
                  className={input}
                  value={f.label}
                  placeholder="Label, e.g. Recipient"
                  onChange={(e) => {
                    const others = form.fields.filter((_, j) => j !== i).map((x) => x.key)
                    // Keep the key in step with the label until the user has used it in the first message.
                    const used = form.starter.includes(`{{${f.key}}}`)
                    setField(i, { label: e.target.value, ...(used ? {} : { key: keyFrom(e.target.value, others) }) })
                  }}
                />
                <input
                  aria-label="Hint"
                  maxLength={200}
                  className={input}
                  value={f.placeholder}
                  placeholder="Hint (optional)"
                  onChange={(e) => setField(i, { placeholder: e.target.value })}
                />
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                    Needed
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={f.multiline} onChange={(e) => setField(i, { multiline: e.target.checked })} />
                    Long
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${f.label || 'detail'}`}
                    className="text-muted-foreground hover:text-danger"
                    onClick={() => set('fields', form.fields.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground sm:col-span-3">
                  Use in the first message as <code className="font-mono text-primary">{`{{${f.key}}}`}</code>
                </p>
              </li>
            ))}
          </ul>
          {form.fields.length < 12 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                const label = `Detail ${form.fields.length + 1}`
                set('fields', [...form.fields, { key: keyFrom(label, form.fields.map((f) => f.key)), label, placeholder: '', required: false, multiline: false }])
              }}
            >
              <Plus /> Add a detail
            </Button>
          )}
          <label className="mt-3 flex items-start gap-2.5 text-sm">
            <Switch label="Ask for missing details" className="mt-0.5" checked={form.ask_for_missing} onChange={(v) => set('ask_for_missing', v)} />
            <span>
              Let the model ask for anything missing
              <span className="block text-xs text-muted-foreground">
                Start even with blanks; the model asks for what it needs instead of guessing.
              </span>
            </span>
          </label>
        </fieldset>

        <div>
          <label htmlFor="ps-starter" className="mb-1 block text-[13px] font-medium">
            First message <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Sent when the skill starts. Details you don't place here are listed after it.
          </p>
          <textarea
            id="ps-starter"
            rows={3}
            maxLength={2000}
            className={cn(input, 'font-mono text-[13px]')}
            value={form.starter}
            onChange={(e) => set('starter', e.target.value)}
            placeholder={form.fields[0] ? `e.g. Here are my notes: {{${form.fields[0].key}}}` : 'e.g. Let’s get started.'}
          />
          {unknownVars.length > 0 && (
            <p className="mt-1 text-xs text-danger">No detail called {unknownVars.map((v) => `{{${v}}}`).join(', ')}.</p>
          )}
        </div>

        <fieldset>
          <legend className="text-[13px] font-medium">Reply style</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {styles.map((s) => {
              const on = form.styles.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  title={s.description}
                  disabled={!on && form.styles.length >= 4}
                  onClick={() => set('styles', on ? form.styles.filter((x) => x !== s.id) : [...form.styles, s.id])}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[12.5px] disabled:opacity-40',
                    on ? 'border-primary bg-primary-soft font-medium' : 'border-border text-muted-foreground hover:text-ink',
                  )}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2.5">
            <Switch label="Show on new chats" checked={form.pinned} onChange={(v) => set('pinned', v)} />
            Show as a button on new chats
          </label>
          <label className={cn('flex items-center gap-2.5', !canShare && 'opacity-60')}>
            <Switch label="Share with workspace" checked={form.shared} disabled={!canShare} onChange={(v) => set('shared', v)} />
            Share with my workspace
            {!canShare && (
              <a href={href({ page: 'plans' })} className="text-xs text-primary underline">
                Team plan
              </a>
            )}
          </label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-5">
          <Button asChild variant="ghost">
            <a href={href({ page: 'skills' })}>Cancel</a>
          </Button>
          <Button type="submit" disabled={saving || unknownVars.length > 0}>
            {saving ? 'Saving…' : isNew ? 'Create skill' : 'Save changes'}
          </Button>
        </div>
      </div>
    </form>
  )
}
