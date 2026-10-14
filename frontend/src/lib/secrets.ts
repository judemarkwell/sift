/**
 * Secrets Sift restored into a reply (API keys, AWS keys, private keys,
 * passwords): how to show them masked on screen, and how to swap them for
 * environment variable references when copying code "without secrets".
 */

export const SECRET_KINDS = new Set(['API_KEY', 'AWS_ACCESS_KEY', 'PRIVATE_KEY', 'PASSWORD'])

export interface Secret {
  value: string
  kind: string
  placeholder: string
}

const PREFIXES: [string, string, string][] = [
  // prefix, env var name, label
  ['sk-ant-', 'ANTHROPIC_API_KEY', 'Anthropic API key'],
  ['sk-proj-', 'OPENAI_API_KEY', 'OpenAI API key'],
  ['sk_live_', 'STRIPE_SECRET_KEY', 'Stripe key'],
  ['rk_live_', 'STRIPE_SECRET_KEY', 'Stripe key'],
  ['sk-', 'OPENAI_API_KEY', 'OpenAI API key'],
  ['gh', 'GITHUB_TOKEN', 'GitHub token'],
  ['xox', 'SLACK_TOKEN', 'Slack token'],
  ['AIza', 'GOOGLE_API_KEY', 'Google API key'],
]

export function describeSecret(s: Secret): { envName: string; label: string } {
  if (s.kind === 'AWS_ACCESS_KEY') return { envName: 'AWS_ACCESS_KEY_ID', label: 'AWS access key' }
  if (s.kind === 'PRIVATE_KEY') return { envName: 'PRIVATE_KEY', label: 'private key' }
  if (s.kind === 'PASSWORD') return { envName: 'PASSWORD', label: 'password' }
  const hit = PREFIXES.find(([p]) => s.value.startsWith(p))
  return hit ? { envName: hit[1], label: hit[2] } : { envName: 'API_KEY', label: 'API key' }
}

/** What's shown on screen until the user reveals it. */
export function maskSecret(s: Secret): string {
  if (s.kind === 'PRIVATE_KEY') return '-----BEGIN PRIVATE KEY----- (hidden) -----END PRIVATE KEY-----'
  if (s.kind === 'PASSWORD') return '•'.repeat(Math.min(Math.max(s.value.length, 6), 12))
  const v = s.value
  const prefix = PREFIXES.find(([p]) => v.startsWith(p))?.[0] ?? v.slice(0, 4)
  return `${prefix}…${v.slice(-3)}`
}

/** Distinct restored secrets in a message, longest first (so overlaps match the full value). */
export function secretsFrom(
  content: string,
  marks: { kind: string; placeholder?: string | null; start?: number | null; end?: number | null }[],
): Secret[] {
  const seen = new Map<string, Secret>()
  for (const m of marks) {
    if (!SECRET_KINDS.has(m.kind) || m.start == null || m.end == null) continue
    const value = content.slice(m.start, m.end)
    if (value.length > 3 && !seen.has(value)) seen.set(value, { value, kind: m.kind, placeholder: m.placeholder ?? '' })
  }
  return [...seen.values()].sort((a, b) => b.value.length - a.value.length)
}

/** Split text into plain strings and secrets, for rendering masked spans. */
export function splitSecrets(text: string, secrets: Secret[]): (string | Secret)[] {
  let parts: (string | Secret)[] = [text]
  for (const s of secrets) {
    parts = parts.flatMap((p) =>
      typeof p !== 'string' || !p.includes(s.value)
        ? [p]
        : p.split(s.value).flatMap((chunk, i, arr) => (i < arr.length - 1 ? [chunk, s] : [chunk])),
    )
  }
  return parts.filter((p) => p !== '')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Lang = 'python' | 'js' | 'shell' | 'other'

function langOf(lang: string): Lang {
  const l = lang.toLowerCase()
  if (['python', 'py', 'python3'].includes(l)) return 'python'
  if (['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'node', 'mjs'].includes(l)) return 'js'
  if (['bash', 'sh', 'shell', 'zsh', 'console', 'curl', 'powershell', 'ps1'].includes(l)) return 'shell'
  return 'other'
}

/**
 * Copy text for "Copy without secrets": each secret becomes a reference to an
 * environment variable, as well as a simple rewrite can manage.
 */
export function withoutSecrets(code: string, lang: string, secrets: Secret[]): string {
  const kind = langOf(lang)
  const dotenv = ['env', 'dotenv', '.env', 'ini', 'properties', ''].includes(lang.toLowerCase())
  let out = code
  for (const s of secrets) {
    const { envName } = describeSecret(s)
    const v = escapeRe(s.value)
    // .env files and shell variables: KEY=value  ->  KEY=
    if (dotenv || kind === 'shell') {
      out = out.replace(new RegExp(`^(\\s*(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*=)(["']?)${v}\\2[ \\t]*$`, 'gm'), '$1')
    }
    if (kind === 'python') {
      out = out.replace(new RegExp(`(["'])${v}\\1`, 'g'), `os.environ["${envName}"]`)
    } else if (kind === 'js') {
      out = out.replace(new RegExp(`(["'])${v}\\1`, 'g'), `process.env.${envName}`)
      out = out.replace(new RegExp('(`[^`]*)' + v, 'g'), `$1\${process.env.${envName}}`)
    } else if (kind === 'shell') {
      // Single quotes stop $VAR from expanding, so switch that segment to double quotes.
      out = out.replace(new RegExp(`'([^'\\n]*)${v}([^'\\n]*)'`, 'g'), `"$1$${envName}$2"`)
      out = out.replace(new RegExp(v, 'g'), `$${envName}`)
    }
    out = out.replace(new RegExp(v, 'g'), `YOUR_${envName}`)
  }
  if (kind === 'python' && out.includes('os.environ[') && !/^\s*(import os\b|from os import)/m.test(out)) {
    out = `import os\n${out}`
  }
  return out
}
