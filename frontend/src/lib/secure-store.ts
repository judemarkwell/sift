/**
 * Secure folder state shared by the sidebar, chat page and links elsewhere.
 *
 * Access rules (the server enforces the same ones):
 * - Entering the PIN expands the folder and lists its chats.
 * - Picking a secure chat collapses the folder; only that chat stays open.
 * - Leaving that chat (or collapsing the folder when no secure chat is open)
 *   locks again, so the next visit needs the PIN.
 */
import { useSyncExternalStore } from 'react'

import { api } from './api'
import { clearSecureDrafts } from './drafts'
import { navigate } from './route'
import type { ConversationSummary, SecureStatus } from './types'
import { getUnlockToken, setUnlockToken } from './unlock-token'

export type PinMode = 'setup' | 'unlock'

interface PinRequest {
  mode: PinMode
  reason: string
  resolve: (ok: boolean) => void
}

interface State {
  status: SecureStatus | null
  expanded: boolean
  chats: ConversationSummary[]
  /** The secure chat currently allowed to be open ('new' for a new secure chat). */
  openId: string | null
  pin: PinRequest | null
}

let state: State = { status: null, expanded: false, chats: [], openId: null, pin: null }
const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useSecure(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export async function refreshSecureStatus(): Promise<SecureStatus | null> {
  try {
    const status = await api.secureStatus()
    set({ status })
    return status
  } catch {
    return null
  }
}

export async function refreshSecureChats(): Promise<void> {
  if (!getUnlockToken()) return set({ chats: [] })
  try {
    set({ chats: await api.secureConversations() })
  } catch {
    set({ chats: [] })
  }
}

/**
 * Ask for the PIN (or to set one up). Resolves true once the folder is
 * unlocked. Skips the prompt if this tab is already unlocked, except when
 * `always` is set (opening the folder always asks).
 */
export async function requestPin(reason: string, always = false): Promise<boolean> {
  if (getUnlockToken() && !always) {
    const status = await refreshSecureStatus()
    if (status?.unlocked) return true
    setUnlockToken(null)
  }
  const status = state.status ?? (await refreshSecureStatus())
  const mode: PinMode = status?.pin_set ? 'unlock' : 'setup'
  return new Promise((resolve) => set({ pin: { mode, reason, resolve } }))
}

/** Called by the PIN dialog. */
export function finishPin(token: string | null) {
  const pending = state.pin
  if (token) setUnlockToken(token)
  set({ pin: null })
  if (token) void refreshSecureStatus()
  pending?.resolve(!!token)
}

export async function expandFolder(): Promise<void> {
  if (!(await requestPin('Enter your PIN to open the secure folder.', true))) return
  await refreshSecureChats()
  set({ expanded: true })
}

/** Collapse the folder; locks too unless a secure chat is open. */
export function collapseFolder() {
  set({ expanded: false, chats: [] })
  if (!state.openId) lock()
}

/** Allow one secure chat to stay open while the folder is closed. */
export function openSecureChat(id: string | null) {
  set({ openId: id, expanded: false, chats: [] })
}

/** End access: forget the token, wipe secure drafts, and tell the server. */
export function lock() {
  const had = getUnlockToken()
  setUnlockToken(null)
  clearSecureDrafts()
  set({ expanded: false, chats: [], openId: null })
  if (had) void api.lockSecure().then(refreshSecureStatus).catch(() => undefined)
}

/** Lock when the user has moved away from the open secure chat. */
export function onRouteChange(page: string, id: string | undefined) {
  const here = page === 'chat' ? (id ?? 'new') : null
  if (state.openId && here !== state.openId) {
    set({ openId: null })
    if (!state.expanded) lock()
  }
}

/** Open a secure chat from a link elsewhere (activity, usage): PIN first. */
export async function openSecureChatFromLink(id: string): Promise<void> {
  if (!(await requestPin('Enter your PIN to open this secure chat.'))) return
  openSecureChat(id)
  navigate({ page: 'chat', id })
}
