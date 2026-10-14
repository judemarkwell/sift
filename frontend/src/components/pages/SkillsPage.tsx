import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Lock, Menu } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader, Segmented, Switch } from '@/components/ui/controls'
import { api } from '@/lib/api'
import { ACTION_HELP, ACTION_LABEL, renderMarked } from '@/lib/marks'
import { href } from '@/lib/route'
import { cn } from '@/lib/utils'
import type { Finding, JsonSchemaProp, PiiAction, SkillLayer, SkillView, SkillsResponse } from '@/lib/types'

const STAGE_LABEL = { 'pre-request': 'Before sending', provider: 'Model', 'post-response': 'After the reply' } as const
const ACTIONS: PiiAction[] = ['block', 'redact', 'warn', 'allow']
const ACTION_TONE: Record<PiiAction, string> = {
  block: 'text-danger',
  redact: 'text-primary',
  warn: 'text-cost',
  allow: '',
}

type Mode = 'mine' | 'workspace'

export function SkillsPage({ onOpenMenu }: { onOpenMenu: () => void }) {
  const [data, setData] = useState<SkillsResponse | null>(null)
  const [mode, setMode] = useState<Mode>('mine')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.skills().then(setData).catch((e: Error) => setError(e.message))
  }, [])

  const save = async (id: string, patch: SkillLayer & { reset?: boolean }) => {
    setError(null)
    try {
      setData(await api.patchSkill(id, patch, mode === 'workspace'))
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!data) {
    return <div className="p-8 text-sm text-muted-foreground">{error ?? 'Loading skills…'}</div>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-4 pb-16 pt-4 sm:px-8 sm:pt-8">
        <Button variant="ghost" size="icon" className="mb-2 lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu />
        </Button>
        <PageHeader
          title="Skills"
          description="Each skill runs at one point in a request's journey and shows up in every trace. Turn them on or off, and tune how they behave."
        >
          {data.can_admin ? (
            <Segmented
              label="Settings scope"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'mine', label: 'My settings' },
                { value: 'workspace', label: 'Workspace policy' },
              ]}
            />
          ) : null}
        </PageHeader>

        {mode === 'workspace' && (
          <p className="-mt-2 mb-6 rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-sm leading-relaxed">
            You're editing the policy for everyone in your workspace. Use <strong>Require</strong> to turn a skill on for
            everyone, and <strong>Lock settings</strong> so members can't change how it behaves.
          </p>
        )}
        {!data.workspace_policy_available && (
          <p className="-mt-2 mb-6 text-[13px] text-muted-foreground">
            On the <a className="text-primary underline" href={href({ page: 'plans' })}>Team plan</a>, admins can require
            skills for everyone, such as PII redaction with a fixed policy.
          </p>
        )}

        <div aria-live="polite" className="h-5 text-right text-xs text-primary">
          {saved && 'Saved'}
          {error && <span className="text-danger">{error}</span>}
        </div>

        <ul className="divide-y divide-border border-y border-border">
          {data.skills.map((s) => (
            <SkillRow key={s.manifest.id} view={s} data={data} mode={mode} onSave={(p) => save(s.manifest.id, p)} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function SkillRow({
  view,
  data,
  mode,
  onSave,
}: {
  view: SkillView
  data: SkillsResponse
  mode: Mode
  onSave: (p: SkillLayer & { reset?: boolean }) => void
}) {
  const { manifest: m, resolved } = view
  const ws = resolved.workspace
  const lockedEnabled = mode === 'mine' && resolved.locked.includes('enabled')
  const lockedConfig = mode === 'mine' && resolved.locked.includes('config')
  const enabled = mode === 'workspace' ? (ws.enabled ?? resolved.enabled) : resolved.enabled
  const config = mode === 'workspace' ? { ...resolved.config, ...(ws.config ?? {}) } : resolved.config
  const hasConfig = Object.keys(m.config_schema.properties ?? {}).length > 0
  const [open, setOpen] = useState(m.id === 'pii-redaction')

  const toggleLock = (field: 'enabled' | 'config', on: boolean) => {
    const current = ws.locked ?? []
    const next = on ? [...new Set([...current, field])] : current.filter((f) => f !== field)
    onSave({ locked: next, ...(field === 'enabled' && on ? { enabled: true } : {}) })
  }

  return (
    <li className="py-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="text-[16px] font-semibold">{m.name}</h2>
            <span className="text-xs text-muted-foreground">
              {m.category} · {m.stages.map((st) => STAGE_LABEL[st]).join(' and ')}
              {m.can_modify_request && ' · can change what is sent'}
            </span>
            {(lockedEnabled || lockedConfig) && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Lock className="size-3" /> Set by your workspace
              </span>
            )}
          </div>
          <p className="mt-1 text-[14px] text-ink/85">{m.summary}</p>
          <p className="mt-1 max-w-[40rem] text-[13px] leading-relaxed text-muted-foreground">{m.description}</p>
          {mode === 'workspace' && m.lockable && (
            <div className="mt-3 flex flex-wrap gap-5 text-[13px]">
              <label className="flex items-center gap-2">
                <Switch
                  label={`Require ${m.name} for everyone`}
                  checked={(ws.locked ?? []).includes('enabled')}
                  onChange={(v) => toggleLock('enabled', v)}
                />
                Require for everyone
              </label>
              {hasConfig && (
                <label className="flex items-center gap-2">
                  <Switch
                    label={`Lock ${m.name} settings`}
                    checked={(ws.locked ?? []).includes('config')}
                    onChange={(v) => toggleLock('config', v)}
                  />
                  Lock settings
                </label>
              )}
            </div>
          )}
          {hasConfig && enabled && (
            <button
              type="button"
              className="mt-2 text-[13px] font-medium text-primary hover:underline"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide settings' : 'Settings'}
            </button>
          )}
        </div>
        <Switch
          label={`${m.name} ${enabled ? 'on' : 'off'}`}
          checked={enabled}
          disabled={m.core || lockedEnabled}
          onChange={(v) => onSave({ enabled: v })}
          className="mt-1"
        />
      </div>
      {hasConfig && enabled && open && (
        <div className="mt-4">
          {m.id === 'pii-redaction' ? (
            <PiiSettings config={config} data={data} disabled={lockedConfig} onSave={onSave} />
          ) : (
            <GenericSettings view={view} config={config} disabled={lockedConfig} onSave={onSave} />
          )}
        </div>
      )}
    </li>
  )
}

function GenericSettings({
  view,
  config,
  disabled,
  onSave,
}: {
  view: SkillView
  config: Record<string, unknown>
  disabled: boolean
  onSave: (p: SkillLayer) => void
}) {
  const props = view.manifest.config_schema.properties ?? {}
  return (
    <div className="grid gap-4 rounded-lg bg-muted/60 p-4 sm:grid-cols-2">
      {Object.entries(props).map(([key, prop]) => (
        <Field key={key} name={key} prop={prop} value={config[key]} disabled={disabled} onChange={(v) => onSave({ config: { [key]: v } })} />
      ))}
    </div>
  )
}

function Field({
  name,
  prop,
  value,
  disabled,
  onChange,
}: {
  name: string
  prop: JsonSchemaProp
  value: unknown
  disabled: boolean
  onChange: (v: unknown) => void
}) {
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  const id = `field-${name}`
  const label = prop.title ?? name
  let control
  if (prop.enum) {
    control = (
      <Segmented
        label={label}
        value={String(value)}
        disabled={disabled}
        onChange={onChange}
        options={prop.enum.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
      />
    )
  } else if (prop.type === 'boolean') {
    control = <Switch label={label} checked={!!value} disabled={disabled} onChange={onChange} />
  } else {
    control = (
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        min={prop.minimum}
        max={prop.maximum}
        step={prop.type === 'integer' ? 1000 : 0.01}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft)
          if (draft !== '' && !Number.isNaN(n) && n !== value) onChange(n)
        }}
        className="h-9 w-40 rounded-md border border-border bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
      />
    )
  }
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium">
        {label}
      </label>
      {prop.description && <p className="mb-1.5 text-xs text-muted-foreground">{prop.description}</p>}
      {control}
    </div>
  )
}

function PiiSettings({
  config,
  data,
  disabled,
  onSave,
}: {
  config: Record<string, unknown>
  data: SkillsResponse
  disabled: boolean
  onSave: (p: SkillLayer) => void
}) {
  const preset = String(config.preset)
  const overrides = (config.overrides ?? {}) as Record<string, PiiAction>
  const detectors = (config.detectors ?? []) as string[]
  const base = data.pii.presets[preset]?.policy ?? {}
  const groups = useMemo(() => {
    const g = new Map<string, typeof data.pii.entities>()
    data.pii.entities.forEach((e) => g.set(e.group, [...(g.get(e.group) ?? []), e]))
    return [...g.entries()]
  }, [data.pii.entities])

  const setAction = (kind: string, action: PiiAction) => {
    const next = { ...overrides }
    if (base[kind] === action) delete next[kind]
    else next[kind] = action
    onSave({ config: { overrides: next } })
  }

  return (
    <div className="flex flex-col gap-6 rounded-lg bg-muted/60 p-4 sm:p-5">
      <fieldset disabled={disabled}>
        <legend className="text-[13px] font-semibold">Starting point</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {Object.entries(data.pii.presets).map(([id, p]) => (
            <label
              key={id}
              className={cn(
                'cursor-pointer rounded-lg border bg-surface px-3.5 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                preset === id ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
              )}
            >
              <input
                type="radio"
                name="pii-preset"
                className="sr-only"
                checked={preset === id}
                onChange={() => onSave({ config: { preset: id, overrides: {} } })}
              />
              <span className="block text-sm font-medium">{p.name}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{p.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold">What happens to each kind of data</h3>
          {Object.keys(overrides).length > 0 && !disabled && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => onSave({ config: { overrides: {} } })}>
              Reset {Object.keys(overrides).length} change{Object.keys(overrides).length > 1 ? 's' : ''} to preset
            </button>
          )}
        </div>
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {ACTIONS.map((a) => (
            <div key={a} className="flex gap-1">
              <dt className={cn('font-medium', ACTION_TONE[a])}>{ACTION_LABEL[a]}:</dt>
              <dd>{ACTION_HELP[a].toLowerCase()}</dd>
            </div>
          ))}
        </dl>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {groups.map(([group, entities]) => (
              <GroupRows key={group} group={group}>
                {entities.map((e) => {
                  const action = overrides[e.kind] ?? base[e.kind] ?? 'allow'
                  return (
                    <tr key={e.kind} className="border-t border-border/70">
                      <td className="py-2 pr-3 align-middle">
                        <span className="block">
                          {e.label}
                          {e.kind in overrides && <span className="ml-1.5 text-[11px] text-primary">changed</span>}
                        </span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{e.example}</span>
                      </td>
                      <td className="py-2 text-right align-middle">
                        <Segmented
                          size="sm"
                          label={`${e.label} action`}
                          value={action}
                          disabled={disabled}
                          onChange={(a) => setAction(e.kind, a)}
                          options={ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a], tone: ACTION_TONE[a] }))}
                        />
                      </td>
                    </tr>
                  )
                })}
              </GroupRows>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <div>
          <legend className="text-[13px] font-semibold">Detectors</legend>
          {[
            { id: 'patterns', name: 'Built-in patterns', note: 'Runs on Sift. Emails, cards, IDs, keys and more.' },
            { id: 'comprehend', name: 'AWS Comprehend (mock)', note: 'Adds names. Simulated locally until AWS is set up.' },
          ].map((d) => (
            <label key={d.id} className="mt-2 flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-[var(--accent)]"
                checked={detectors.includes(d.id)}
                onChange={(ev) =>
                  onSave({
                    config: {
                      detectors: ev.target.checked ? [...detectors, d.id] : detectors.filter((x) => x !== d.id),
                    },
                  })
                }
              />
              <span>
                {d.name}
                <span className="block text-xs text-muted-foreground">{d.note}</span>
              </span>
            </label>
          ))}
        </div>
        <div>
          <span className="text-[13px] font-semibold">Replies</span>
          <label className="mt-2 flex items-start gap-2.5 text-sm">
            <Switch
              label="Restore values in replies"
              className="mt-0.5"
              checked={config.restore_in_reply !== false}
              disabled={disabled}
              onChange={(v) => onSave({ config: { restore_in_reply: v } })}
            />
            <span>
              Show real values in replies
              <span className="block text-xs text-muted-foreground">
                Where the model wrote [EMAIL_1], you see the actual email.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <PiiTester />
    </div>
  )
}

function GroupRows({ group, children }: { group: string; children: ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={2} className="pb-1 pt-4 text-left text-xs font-medium text-muted-foreground first:pt-0">
          {group}
        </th>
      </tr>
      {children}
    </>
  )
}

const SAMPLE =
  "Hi, my name is Jordan Ellis. Card 4111 1111 1111 1111, email jordan@ellis.dev, cell (502) 555-0142. Our server is 10.20.30.40 and the key is AKIAIOSFODNN7EXAMPLE."

function PiiTester() {
  const [text, setText] = useState(SAMPLE)
  const [findings, setFindings] = useState<Finding[]>([])
  useEffect(() => {
    const t = setTimeout(() => {
      api.scan(text).then((r) => setFindings(r.findings)).catch(() => setFindings([]))
    }, 200)
    return () => clearTimeout(t)
  }, [text])
  return (
    <div>
      <label htmlFor="pii-test" className="text-[13px] font-semibold">
        Try your policy
      </label>
      <p className="text-xs text-muted-foreground">Nothing typed here is sent to a model.</p>
      <textarea
        id="pii-test"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="mt-2 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
      />
      <p className="mt-2 rounded-md bg-surface px-3 py-2 text-sm leading-relaxed" aria-live="polite">
        {findings.length ? renderMarked(text, findings) : <span className="text-muted-foreground">Nothing caught.</span>}
      </p>
    </div>
  )
}
