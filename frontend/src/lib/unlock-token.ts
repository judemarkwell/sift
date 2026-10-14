/**
 * The secure-folder unlock token. Held in memory only, never in browser
 * storage, so a reload always locks the folder.
 */
let token: string | null = null

export const getUnlockToken = () => token
export const setUnlockToken = (t: string | null) => {
  token = t
}

/** Headers to add to every API request. */
export function unlockHeaders(): Record<string, string> {
  return token ? { 'X-Sift-Unlock': token } : {}
}
