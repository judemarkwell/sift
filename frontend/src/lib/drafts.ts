/**
 * Unsent composer text, per chat ('new' for a new chat), so switching tabs or
 * chats never loses what you were typing.
 *
 * Normal chats' drafts go in sessionStorage: they survive a refresh, are
 * cleared when the tab closes, and never leave the browser. Secure chats'
 * drafts are kept in memory only and wiped whenever the secure folder locks.
 */

export interface Draft {
  text: string
  styles: string[]
}

const PREFIX = 'sift-draft:'
const secureDrafts = new Map<string, Draft>()

function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function getDraft(key: string): Draft | null {
  const mem = secureDrafts.get(key)
  if (mem) return mem
  try {
    const raw = session()?.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}

export function setDraft(key: string, draft: Draft, secure: boolean): void {
  const empty = !draft.text.trim() && draft.styles.length === 0
  try {
    // A chat that turned out to be secure must not leave a copy in storage.
    if (secure || empty) session()?.removeItem(PREFIX + key)
    else session()?.setItem(PREFIX + key, JSON.stringify(draft))
  } catch {
    /* storage full or blocked: the draft just won't survive a refresh */
  }
  if (secure && !empty) secureDrafts.set(key, draft)
  else secureDrafts.delete(key)
}

/** Called when the secure folder locks. */
export function clearSecureDrafts(): void {
  secureDrafts.clear()
}

/** Called on sign-out, so the next person in this tab starts clean. */
export function clearAllDrafts(): void {
  secureDrafts.clear()
  try {
    const s = session()
    if (!s) return
    for (const k of Object.keys(s)) if (k.startsWith(PREFIX)) s.removeItem(k)
  } catch {
    /* nothing stored */
  }
}
