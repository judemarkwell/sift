import { useEffect, useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import type { SendOptions } from '@/hooks/useChat'
import { api } from '@/lib/api'
import { SkillIcon } from '@/lib/icons'
import { href } from '@/lib/route'
import type { PromptSkill } from '@/lib/types'

/** The prompt-skill buttons on a new chat, and the short form each one asks you to fill in. */
export function SkillLauncher({
  onStart,
  onOpenChange,
}: {
  onStart: (text: string, opts: SendOptions) => Promise<boolean>
  onOpenChange?: (open: boolean) => void
}) {
  const { styles } = useAppData()
  const [skills, setSkills] = useState<PromptSkill[] | null>(null)
  const [active, setActive] = useState<PromptSkill | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => onOpenChange?.(!!active), [active, onOpenChange])

  useEffect(() => {
    api
      .promptSkills()
      .then((r) => setSkills(r.skills.filter((s) => s.pinned)))
      .catch(() => setSkills([]))
  }, [])

  if (skills === null) return null

  if (active) {
    const missing = active.fields.filter((f) => f.required && !values[f.key]?.trim())
    const canStart = missing.length === 0 || active.ask_for_missing
    const start = async () => {
      setBusy(true)
      const ok = await onStart(extra, { skillId: active.id, skillValues: values })
      setBusy(false)
      if (!ok) return
    }
    return (
      <form
        className="mt-8 w-full max-w-[36rem] rounded-xl border border-border bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (canStart) void start()
        }}
      >
        <button type="button" onClick={() => setActive(null)} className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-ink">
          <ArrowLeft className="size-3.5" /> All skills
        </button>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
            <SkillIcon name={active.icon} className="size-[18px]" />
          </span>
          <div>
            <h2 className="text-[16px] font-semibold">{active.name}</h2>
            {active.description && <p className="text-[13px] text-muted-foreground">{active.description}</p>}
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3.5">
          {active.fields.map((f, i) => {
            const id = `skill-field-${f.key}`
            const common = {
              id,
              value: values[f.key] ?? '',
              placeholder: f.placeholder,
              autoFocus: i === 0,
              onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value })),
              className:
                'w-full rounded-md border border-border bg-ground/40 px-3 py-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-ring',
            }
            return (
              <div key={f.key}>
                <label htmlFor={id} className="mb-1 block text-[13px] font-medium">
                  {f.label}
                  {f.required && <span className="text-muted-foreground"> (needed)</span>}
                </label>
                {f.multiline ? <textarea rows={4} {...common} /> : <input {...common} />}
              </div>
            )
          })}
          <div>
            <label htmlFor="skill-extra" className="mb-1 block text-[13px] font-medium">
              Anything else? <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="skill-extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              className="w-full rounded-md border border-border bg-ground/40 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {missing.length > 0 && active.ask_for_missing
              ? `The model will ask for ${missing.map((f) => f.label.toLowerCase()).join(', ')} first.`
              : active.styles.length
                ? `Replies use: ${active.styles.map((s) => styles.find((x) => x.id === s)?.label ?? s).join(', ')}.`
                : 'The skill stays active for the whole chat.'}
          </p>
          <Button type="submit" disabled={!canStart || busy}>
            {busy ? 'Starting…' : 'Start'}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="mt-8">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium text-muted-foreground">Your skills</h2>
        <a href={href({ page: 'skills' })} className="text-xs text-primary hover:underline">
          Manage
        </a>
      </div>
      <div className="flex flex-wrap gap-2">
        {skills.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setActive(s)
              setValues({})
              setExtra('')
            }}
            title={s.description}
            className="group flex items-center gap-2 rounded-lg border border-border bg-surface py-2 pl-2.5 pr-3.5 text-left text-sm hover:border-primary/50 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-ring"
          >
            <SkillIcon name={s.icon} className="size-4 text-primary" />
            <span className="font-medium">{s.name}</span>
          </button>
        ))}
        <a
          href={href({ page: 'skills', id: 'new' })}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-primary/50 hover:text-ink"
        >
          <Plus className="size-4" /> {skills.length ? 'New skill' : 'Make a skill for a task you repeat'}
        </a>
      </div>
    </div>
  )
}
