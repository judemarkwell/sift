/**
 * Sign-in with Cognito's hosted login, using the authorization code flow with
 * PKCE (the standard, secret-free flow for browser apps):
 *
 *   1. signIn(): make a random verifier, send its SHA-256 "challenge" with the
 *      user to Cognito's sign-in page.
 *   2. Cognito sends them back to /?code=...&state=...
 *   3. handleCallback(): trade the code + verifier for tokens.
 *   4. Every API call sends the ID token; it's refreshed a minute before expiry.
 *
 * Tokens live in sessionStorage: this tab only, gone when the browser closes.
 * When the server says "signed out" (401), listeners are told so the app can
 * show the sign-in screen again.
 *
 * With SIFT_AUTH=local the server reports mode "local" and none of this runs.
 */

export interface AuthConfig {
  mode: 'local' | 'cognito'
  region?: string
  client_id?: string
  domain?: string
  providers?: string[]
}

interface Session {
  id_token: string
  refresh_token?: string
  expires_at: number // ms
}

const SESSION_KEY = 'sift-auth'
const PENDING_KEY = 'sift-auth-pending'

let config: AuthConfig = { mode: 'local' }
let refreshing: Promise<string | null> | null = null
const signedOutListeners = new Set<() => void>()

function store(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readSession(): Session | null {
  try {
    const raw = store()?.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function writeSession(s: Session | null) {
  try {
    if (s) store()?.setItem(SESSION_KEY, JSON.stringify(s))
    else store()?.removeItem(SESSION_KEY)
  } catch {
    /* storage blocked: sign-in lasts until the page reloads */
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)))

export const redirectUri = () => `${window.location.origin}/`

export async function loadAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config')
  if (!res.ok) throw new Error(`Couldn't load sign-in settings (HTTP ${res.status})`)
  config = (await res.json()) as AuthConfig
  return config
}

export const authMode = () => config.mode
export const authProviders = () => config.providers ?? []

export function isSignedIn(): boolean {
  return config.mode === 'local' || !!readSession()
}

/** Go to Cognito's sign-in page (or straight to Google). */
export async function signIn(provider?: string): Promise<void> {
  const verifier = randomString(64)
  const state = randomString(24)
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  store()?.setItem(PENDING_KEY, JSON.stringify({ verifier, state, hash: window.location.hash }))
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.client_id ?? '',
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (provider) params.set('identity_provider', provider)
  window.location.assign(`${config.domain}/oauth2/authorize?${params}`)
}

async function tokenRequest(body: Record<string, string>): Promise<Session> {
  const res = await fetch(`${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.client_id ?? '', ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || 'Sign-in failed.')
  return {
    id_token: data.id_token,
    refresh_token: data.refresh_token ?? body.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

/**
 * If Cognito just sent the user back with a code, finish signing in. Returns
 * the page hash they started from, so the app can put them back there.
 */
export async function handleCallback(): Promise<string | null> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (!code && !error) return null
  const pending = JSON.parse(store()?.getItem(PENDING_KEY) ?? 'null') as
    | { verifier: string; state: string; hash: string }
    | null
  store()?.removeItem(PENDING_KEY)
  // Clean the code out of the address bar either way.
  window.history.replaceState(null, '', `${url.pathname}${pending?.hash ?? ''}`)
  if (error) throw new Error(error)
  if (!pending || url.searchParams.get('state') !== pending.state) {
    throw new Error('That sign-in link expired or came from another tab. Please sign in again.')
  }
  writeSession(
    await tokenRequest({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    }),
  )
  return pending.hash
}

/** The ID token to send to the API, refreshed shortly before it expires. */
export async function idToken(): Promise<string | null> {
  if (config.mode !== 'cognito') return null
  const s = readSession()
  if (!s) return null
  if (s.expires_at - Date.now() > 60_000) return s.id_token
  if (!s.refresh_token) return null
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token })
    .then((next) => {
      writeSession(next)
      return next.id_token
    })
    .catch(() => {
      writeSession(null)
      return null
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

export async function authHeaders(): Promise<Record<string, string>> {
  const t = await idToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener)
  return () => signedOutListeners.delete(listener)
}

/** The server refused our token: drop it and show the sign-in screen. */
export function notifySignedOut() {
  if (config.mode !== 'cognito') return
  writeSession(null)
  signedOutListeners.forEach((l) => l())
}

/** Sign out here and at Cognito (which ends its sign-in cookie too). */
export function signOut(beforeLeave?: () => void) {
  writeSession(null)
  beforeLeave?.()
  if (config.mode !== 'cognito') return
  const params = new URLSearchParams({ client_id: config.client_id ?? '', logout_uri: redirectUri() })
  window.location.assign(`${config.domain}/logout?${params}`)
}
