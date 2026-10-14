import { useEffect, useRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-surface shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
  tone?: string // class applied when selected
}

/** A small radio group drawn as joined buttons. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  size = 'md',
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-[5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed',
              size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-[13px]',
              on ? cn('bg-surface text-ink shadow-[0_1px_2px_rgb(28_36_48/0.12)]', o.tone) : 'text-muted-foreground enabled:hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Native <dialog>: focus trapping, Escape and inertness for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-xl border border-border bg-surface p-0 text-ink shadow-[0_20px_60px_-20px_rgb(28_36_48/0.45)] backdrop:bg-[rgb(18_23_29/0.45)]"
    >
      {open && (
        <div className="p-6">
          <h2 className="text-[17px] font-semibold">{title}</h2>
          <div className="mt-3">{children}</div>
        </div>
      )}
    </dialog>
  )
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="max-w-[40rem]">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </header>
  )
}
