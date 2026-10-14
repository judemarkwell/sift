import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Tiny costs need more precision than cents to be meaningful. */
export function formatCost(value: number, opts: { cents?: boolean } = {}): string {
  if (!value) return '$0'
  const abs = Math.abs(value)
  const sign = value < 0 ? '−' : ''
  if (abs < 0.0001) return `${sign}<$0.0001`
  if (opts.cents || abs >= 1) return `${sign}$${abs.toFixed(2)}`
  if (abs >= 0.01) return `${sign}$${abs.toFixed(3)}`
  return `${sign}$${abs.toFixed(4)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) {
  return new Date(iso).toLocaleDateString('en-US', opts)
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return formatDate(iso)
}

/** Same rough estimate as the backend: ~4 characters per token plus per-message overhead. */
export const estimateTokens = (text: string) => (text ? Math.ceil(text.length / 4) + 4 : 0)

export const EXPECTED_OUTPUT_TOKENS = 600
