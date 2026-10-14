import { createContext, isValidElement, useContext, useState, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { Check, Copy, KeyRound } from 'lucide-react'

import { describeSecret, maskSecret, splitSecrets, withoutSecrets, type Secret } from '@/lib/secrets'
import { cn } from '@/lib/utils'

/** The restored secrets in the message being rendered. */
export const SecretsContext = createContext<Secret[]>([])

/** A secret shown masked on screen; click to reveal or hide it again. */
export function SecretSpan({ secret, className }: { secret: Secret; className?: string }) {
  const [shown, setShown] = useState(false)
  const { label } = describeSecret(secret)
  return (
    <button
      type="button"
      onClick={() => setShown((v) => !v)}
      aria-pressed={shown}
      aria-label={shown ? `Hide your ${label}` : `Show your ${label}`}
      title={
        shown
          ? 'Click to hide it again'
          : `Your ${label}, hidden on screen. The model saw ${secret.placeholder}. Click to show; Copy includes the real value.`
      }
      className={cn(
        'inline cursor-pointer break-all rounded-[3px] border-b-[1.5px] border-dotted border-primary/70 bg-primary/15 px-[1px] text-left font-[inherit] text-[length:inherit] text-inherit',
        className,
      )}
    >
      {shown ? secret.value : maskSecret(secret)}
    </button>
  )
}

/** Plain text with any restored secrets masked. */
export function MaskedText({ text, secrets }: { text: string; secrets: Secret[] }) {
  if (!secrets.length) return <>{text}</>
  return (
    <>
      {splitSecrets(text, secrets).map((p, i) =>
        typeof p === 'string' ? p : <SecretSpan key={i} secret={p} />,
      )}
    </>
  )
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return [copied, copy]
}

function CopyButton({ label, text, primary }: { label: string; text: string; primary?: boolean }) {
  const [copied, copy] = useCopied()
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring',
        primary ? 'text-ink' : 'text-muted-foreground hover:text-ink',
      )}
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const secrets = useContext(SecretsContext).filter((s) => code.includes(s.value))
  const labels = [...new Set(secrets.map((s) => describeSecret(s).label))]
  return (
    <div className="code-block overflow-hidden rounded-lg bg-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[11.5px] text-muted-foreground">{lang || 'text'}</span>
        {labels.length > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-primary"
            title="The model only saw a placeholder. Sift put your real value back for copying."
          >
            <KeyRound className="size-3.5" aria-hidden /> Contains your {labels.join(' and ')}
          </span>
        )}
        <span className="flex-1" />
        {secrets.length > 0 && <CopyButton label="Copy without secrets" text={withoutSecrets(code, lang, secrets)} />}
        <CopyButton label="Copy" text={code} primary />
      </div>
      <pre className="!mt-0 !rounded-none !bg-transparent">
        <code>
          <MaskedText text={code} secrets={secrets} />
        </code>
      </pre>
    </div>
  )
}

const textOf = (node: ReactNode): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : isValidElement<{ children?: ReactNode }>(node)
        ? textOf(node.props.children)
        : ''

function InlineCode({ children }: { children?: ReactNode }) {
  const secrets = useContext(SecretsContext)
  return (
    <code>
      <MaskedText text={textOf(children)} secrets={secrets} />
    </code>
  )
}

function RestoredSpan({ className, children }: { className?: string; children?: ReactNode }) {
  const secrets = useContext(SecretsContext)
  const text = textOf(children)
  const secret = className === 'pii-restored' ? secrets.find((s) => s.value === text) : undefined
  if (secret) return <SecretSpan secret={secret} />
  return <span className={className}>{children}</span>
}

/** react-markdown overrides: code blocks with a header, and masked secrets. */
export const markdownComponents: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const lang = /language-([\w.+-]+)/.exec(child.props.className ?? '')?.[1] ?? ''
      return <CodeBlock code={textOf(child.props.children).replace(/\n$/, '')} lang={lang} />
    }
    return <pre>{children}</pre>
  },
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  span: ({ className, children }) => <RestoredSpan className={className}>{children}</RestoredSpan>,
}
