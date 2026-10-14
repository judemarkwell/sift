import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ImagePlus, ShieldAlert, ShieldCheck, Square, Type, X } from 'lucide-react'

import { AuthImage } from '@/components/AuthImage'
import { Button } from '@/components/ui/button'
import { useAppData } from '@/hooks/useAppData'
import type { SendOptions } from '@/hooks/useChat'
import { ApiError, api } from '@/lib/api'
import { getDraft, setDraft } from '@/lib/drafts'
import { markClass } from '@/lib/marks'
import { href } from '@/lib/route'
import { EXPECTED_OUTPUT_TOKENS, cn, estimateTokens, formatCost, formatTokens } from '@/lib/utils'
import type { ChatMessage, Finding, ImageQuota, ModelInfo, StyleInfo, UploadedImage } from '@/lib/types'

interface Props {
  messages: ChatMessage[]
  model?: ModelInfo
  isStreaming: boolean
  prefill: string | null
  onPrefillUsed: () => void
  onSend: (text: string, opts: SendOptions) => Promise<boolean>
  onStop: () => void
  autoFocus?: boolean
  /** Which chat the draft belongs to ('new' for a new chat). */
  draftKey: string
  /** Secure chats keep their draft in memory only. */
  secure?: boolean
}

function usePiiScan(text: string) {
  const [state, setState] = useState<{ text: string; findings: Finding[]; enabled: boolean }>({
    text: '',
    findings: [],
    enabled: true,
  })
  useEffect(() => {
    if (!text.trim()) return
    const t = setTimeout(() => {
      api
        .scan(text)
        .then((r) => setState({ text, findings: r.findings, enabled: r.enabled }))
        .catch(() => setState({ text, findings: [], enabled: true }))
    }, 220)
    return () => clearTimeout(t)
  }, [text])
  // Findings are only valid for the exact text they were computed on.
  return state.text === text ? state : { text, findings: [], enabled: state.enabled }
}

/** 'Email address' -> 'email address', but 'API key' stays as is. */
const lowerLabel = (l: string) => (l.length > 1 && /[A-Z]/.test(l[1]) ? l : l[0].toLowerCase() + l.slice(1))

const kinds = (findings: Finding[], action: Finding['action']) => [
  ...new Set(findings.filter((f) => f.action === action).map((f) => lowerLabel(f.label))),
]

/** The "/word" being typed at the caret, if any. */
function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = before.match(/(^|\s)\/([a-z-]*)$/)
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

const GROUPS: StyleInfo['group'][] = ['Length', 'Format', 'Purpose', 'Tone']

export function Composer({
  messages,
  model,
  isStreaming,
  prefill,
  onPrefillUsed,
  onSend,
  onStop,
  autoFocus,
  draftKey,
  secure = false,
}: Props) {
  const { styles: allStyles } = useAppData()
  const [text, setText] = useState(() => getDraft(draftKey)?.text ?? '')
  const [styles, setStyles] = useState<string[]>(() => getDraft(draftKey)?.styles ?? [])
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [quota, setQuota] = useState<ImageQuota | null>(null)
  const [imageError, setImageError] = useState<{ message: string; code?: string } | null>(null)
  const [caret, setCaret] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [styleMenu, setStyleMenu] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const scan = usePiiScan(text)
  const styleById = useMemo(() => new Map(allStyles.map((s) => [s.id, s])), [allStyles])

  // Keep the draft as you type; an empty composer (e.g. after sending) clears it.
  useEffect(() => {
    setDraft(draftKey, { text, styles }, secure)
  }, [draftKey, text, styles, secure])

  useEffect(() => {
    api.imageQuota().then(setQuota).catch(() => setQuota(null))
  }, [])

  useEffect(() => {
    if (prefill === null) return
    setText(prefill)
    onPrefillUsed()
    ref.current?.focus()
  }, [prefill, onPrefillUsed])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  // ---- slash menu ------------------------------------------------------------------
  const token = slashToken(text, caret)
  const matches = token
    ? allStyles.filter((s) => s.id.startsWith(token.query) || s.label.toLowerCase().startsWith(token.query))
    : []
  const menuOpen = !!token && matches.length > 0

  const addStyle = (id: string) => setStyles((cur) => (cur.includes(id) ? cur : [...cur, id]))
  const pickFromMenu = (s: StyleInfo) => {
    if (!token) return
    const next = text.slice(0, token.start) + text.slice(caret).replace(/^\s?/, '')
    setText(next)
    addStyle(s.id)
    setMenuIndex(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(token.start, token.start)
      setCaret(token.start)
    })
  }

  // ---- images ----------------------------------------------------------------------
  const attach = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (!pics.length) return
    setImageError(null)
    for (const f of pics) {
      if (images.length + uploading >= 4) {
        setImageError({ message: 'Up to 4 images per message.' })
        break
      }
      setUploading((n) => n + 1)
      try {
        const up = await api.upload(f)
        setImages((cur) => [...cur, up])
        setQuota(up.quota)
      } catch (e) {
        setImageError({ message: (e as Error).message, code: e instanceof ApiError ? e.code : undefined })
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  // ---- cost and context -------------------------------------------------------------
  const history = messages.filter((m) => m.status === 'done' && !m.streaming)
  const historyTokens = history.reduce(
    (n, m) => n + estimateTokens(m.content) + m.attachments.reduce((t, a) => t + a.tokens, 0),
    0,
  )
  const newImageTokens = images.reduce((n, i) => n + i.tokens, 0)
  const inputTokens = historyTokens + estimateTokens(text) + newImageTokens
  const windowSize = model?.context_window ?? 1
  const pct = Math.min(100, (inputTokens / windowSize) * 100)
  const budgets = styles.map((s) => styleById.get(s)?.max_tokens).filter((n): n is number => !!n)
  const expectedOut = Math.min(EXPECTED_OUTPUT_TOKENS, budgets.length ? Math.max(...budgets) : EXPECTED_OUTPUT_TOKENS)
  const price = (inTok: number, outTok = 0) =>
    model ? (inTok * model.input_price_per_mtok + outTok * model.output_price_per_mtok) / 1_000_000 : 0
  const forecast = price(inputTokens, expectedOut)

  const blocked = kinds(scan.findings, 'block')
  const redacted = kinds(scan.findings, 'redact')
  const warned = kinds(scan.findings, 'warn')
  const canSend =
    (!!text.trim() || images.length > 0 || styles.length > 0) && !isStreaming && blocked.length === 0 && uploading === 0
  const visionBlocked = images.length > 0 && model && !model.vision

  const submit = async () => {
    if (!canSend || visionBlocked) return
    const sent = { text, styles, images }
    setText('')
    setStyles([])
    setImages([])
    const ok = await onSend(sent.text, { styles: sent.styles, images: sent.images })
    if (!ok) {
      // Refused before sending: give everything back.
      setText(sent.text)
      setStyles(sent.styles)
      setImages(sent.images)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickFromMenu(matches[Math.min(menuIndex, matches.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        setCaret(-1)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="mx-auto w-full max-w-[44rem] px-4 pb-3 sm:px-6">
      {(blocked.length > 0 || redacted.length > 0 || warned.length > 0) && (
        <div
          className={cn(
            'mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-snug',
            blocked.length ? 'border-danger/40 bg-danger/5 text-danger' : 'border-border bg-surface text-muted-foreground',
          )}
          role="status"
        >
          {blocked.length ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />}
          <p>
            {blocked.length > 0 && (
              <>
                Your policy blocks {blocked.join(', ')}. Remove it to send, or{' '}
                <a className="font-medium underline" href={href({ page: 'skills', id: 'pipeline' })}>
                  change the policy
                </a>
                .{' '}
              </>
            )}
            {!blocked.length && redacted.length > 0 && (
              <>
                <span className="text-ink">Will replace {redacted.join(', ')}</span> with placeholders before sending.{' '}
              </>
            )}
            {!blocked.length && warned.length > 0 && <>Sending {warned.join(', ')} as-is.</>}
          </p>
        </div>
      )}
      {imageError && (
        <p role="alert" className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-cost/40 bg-cost/5 px-3 py-2 text-[13px]">
          <span>
            {imageError.message}{' '}
            {imageError.code === 'image_limit' && (
              <a className="font-medium text-primary underline" href={href({ page: 'plans' })}>
                See plans
              </a>
            )}
          </span>
          <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-ink" onClick={() => setImageError(null)}>
            <X className="size-4" />
          </button>
        </p>
      )}

      <div className="relative">
        {menuOpen && (
          <ul
            role="listbox"
            aria-label="Output styles"
            className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-[0_8px_30px_-12px_rgb(28_36_48/0.35)]"
          >
            {matches.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === menuIndex}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickFromMenu(s)
                  }}
                  className={cn('flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left text-sm', i === menuIndex && 'bg-muted')}
                >
                  <span className="w-20 shrink-0 font-mono text-[12.5px] text-primary">/{s.id}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-muted-foreground"> · {s.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div
          onDragOver={(e) => {
            if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void attach([...e.dataTransfer.files])
          }}
          className={cn(
            'rounded-xl border bg-surface shadow-[0_1px_0_rgb(28_36_48/0.04)]',
            blocked.length ? 'border-danger/50' : 'border-border focus-within:border-primary/60',
            dragging && 'border-primary ring-2 ring-primary/30',
          )}
        >
          {(styles.length > 0 || images.length > 0 || uploading > 0) && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {styles.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-md bg-primary-soft py-0.5 pl-2 pr-1 text-[12.5px] font-medium text-ink">
                  {styleById.get(id)?.label ?? id}
                  <button type="button" aria-label={`Remove ${styleById.get(id)?.label ?? id} style`} onClick={() => setStyles((c) => c.filter((x) => x !== id))} className="rounded p-0.5 text-muted-foreground hover:text-ink">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {images.map((img) => (
                <span key={img.id} className="inline-flex items-center gap-2 rounded-md border border-border py-1 pl-1 pr-1.5 text-[12px]">
                  <AuthImage id={img.id} alt="" className="size-8 rounded bg-muted object-cover" />
                  <span className="leading-tight">
                    <span className="block text-ink">{formatTokens(img.tokens)} tokens</span>
                    <span className="block text-muted-foreground">
                      {model?.live ? <span className="text-cost">≈ {formatCost(price(img.tokens))}</span> : 'free on mock'} each message
                    </span>
                  </span>
                  <button type="button" aria-label="Remove image" onClick={() => setImages((c) => c.filter((x) => x.id !== img.id))} className="rounded p-0.5 text-muted-foreground hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
              {uploading > 0 && <span className="self-center text-xs text-muted-foreground">Uploading…</span>}
            </div>
          )}
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <div className="relative">
            {/* Highlights drawn behind the transparent textarea, aligned character for character. */}
            <div
              ref={backdrop}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-transparent"
            >
              {renderBackdrop(text, scan.findings)}
            </div>
            <textarea
              id="composer"
              ref={ref}
              rows={1}
              value={text}
              autoFocus={autoFocus}
              aria-autocomplete="list"
              aria-expanded={menuOpen}
              onChange={(e) => {
                setText(e.target.value)
                setCaret(e.target.selectionStart)
                setMenuIndex(0)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = e.currentTarget.scrollTop)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
                if (files.length) {
                  e.preventDefault()
                  void attach(files)
                }
              }}
              onKeyDown={onKeyDown}
              placeholder={model ? `Message ${model.name}, or type / for a style` : 'Message'}
              className="relative block w-full resize-none break-words bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-2 pb-2.5 pt-1">
            <div className="flex min-w-0 items-center gap-1">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  void attach([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => fileInput.current?.click()}
                aria-label="Attach image"
                title={quota ? `Attach image (${quota.remaining} of ${quota.per_day} left today)` : 'Attach image'}
              >
                <ImagePlus />
              </Button>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('h-8 px-2', styles.length && 'text-primary')}
                  onClick={() => setStyleMenu(!styleMenu)}
                  aria-expanded={styleMenu}
                  title="Output style"
                >
                  <Type /> <span className="hidden sm:inline">Style</span>
                </Button>
                {styleMenu && (
                  <StylePicker
                    styles={allStyles}
                    selected={styles}
                    onToggle={(id) => setStyles((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
                    onClose={() => setStyleMenu(false)}
                  />
                )}
              </div>
              <div
                className="ml-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                title="Estimated tokens the next request will send, out of this model's context window"
              >
                <div
                  className="hidden h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
                  role="meter"
                  aria-label="Context used"
                  aria-valuenow={Math.round(pct * 10) / 10}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(pct, inputTokens ? 3 : 0)}%` }} />
                </div>
                <span className="truncate whitespace-nowrap">
                  ~{formatTokens(inputTokens)}
                  {model && (text.trim() || images.length > 0) && (
                    <> · {model.live ? <>≈ <span className="text-cost">{formatCost(forecast)}</span></> : 'free (mock)'}</>
                  )}
                </span>
              </div>
            </div>
            {isStreaming ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                <Square className="fill-current" /> Stop
              </Button>
            ) : (
              <Button size="icon" className="size-8 rounded-lg" onClick={() => void submit()} disabled={!canSend || !!visionBlocked} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11.5px] leading-relaxed text-muted-foreground">
        {visionBlocked ? (
          <span className="text-danger">{model?.name} can't read images. Pick another model.</span>
        ) : images.length > 0 ? (
          <>Images aren't checked for personal data. Location and camera details were removed. Each image is re-sent with later messages in this chat.</>
        ) : model?.live ? (
          <>AI can make mistakes; check anything important. Usage comes out of your plan.</>
        ) : (
          <>Mock model: replies are simulated and free.</>
        )}
      </p>
    </div>
  )
}

function StylePicker({
  styles,
  selected,
  onToggle,
  onClose,
}: {
  styles: StyleInfo[]
  selected: string[]
  onToggle: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Output style"
      className="absolute bottom-full left-0 z-20 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-3 shadow-[0_8px_30px_-12px_rgb(28_36_48/0.35)]"
    >
      <p className="text-xs text-muted-foreground">Shape the next reply. You can also type these, like /tldr.</p>
      {GROUPS.map((g) => (
        <div key={g} className="mt-3">
          <p className="mb-1.5 text-xs font-medium">{g}</p>
          <div className="flex flex-wrap gap-1.5">
            {styles
              .filter((s) => s.group === g)
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={selected.includes(s.id)}
                  title={s.description}
                  onClick={() => onToggle(s.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[12.5px] focus-visible:outline-2 focus-visible:outline-ring',
                    selected.includes(s.id) ? 'border-primary bg-primary-soft font-medium' : 'border-border text-muted-foreground hover:text-ink',
                  )}
                >
                  {s.label}
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function renderBackdrop(text: string, findings: Finding[]) {
  const spans = findings.filter((f) => f.start != null && f.end != null).sort((a, b) => a.start! - b.start!)
  const out: ReactNode[] = []
  let cursor = 0
  spans.forEach((f, i) => {
    if (f.start! < cursor) return
    out.push(text.slice(cursor, f.start!))
    out.push(
      <mark key={i} className={cn(markClass(f.action), 'text-transparent')}>
        {text.slice(f.start!, f.end!)}
      </mark>,
    )
    cursor = f.end!
  })
  out.push(text.slice(cursor))
  // A trailing newline needs a character after it to take up height.
  out.push('​')
  return out
}
