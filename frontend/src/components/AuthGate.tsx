import { useEffect, useState, type ReactNode } from 'react'
import { LockKeyhole } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { authProviders, handleCallback, isSignedIn, loadAuthConfig, onSignedOut, signIn } from '@/lib/auth'

type State = { kind: 'loading' } | { kind: 'in' } | { kind: 'out'; error?: string }

// Runs once per page load, even though React's dev mode mounts effects twice:
// the sign-in code in the URL can only be spent once.
let boot: Promise<State> | null = null
function start(): Promise<State> {
  boot ??= (async (): Promise<State> => {
    try {
      await loadAuthConfig()
      const back = await handleCallback()
      if (back !== null && back !== window.location.hash) window.location.hash = back
      return isSignedIn() ? { kind: 'in' } : { kind: 'out' }
    } catch (err) {
      return { kind: 'out', error: (err as Error).message }
    }
  })()
  return boot
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  )
}

function SignInScreen({ error }: { error?: string }) {
  const [busy, setBusy] = useState(false)
  const go = (provider?: string) => {
    setBusy(true)
    void signIn(provider)
  }
  const google = authProviders().includes('Google')
  return (
    <main className="grid h-full place-items-center bg-ground px-4">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-[19px] font-bold tracking-[-0.01em]">Sift</span>
        </div>
        <h1 className="mt-8 text-[26px] font-semibold leading-tight tracking-[-0.01em]">Sign in to Sift</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">
          Your chats, usage and privacy settings belong to your account. New here? You can create one on the next
          page.
        </p>
        {error && (
          <p role="alert" className="mt-5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-7 flex flex-col gap-2.5">
          {google && (
            <Button variant="outline" className="h-11 w-full text-[14.5px]" disabled={busy} onClick={() => go('Google')}>
              <GoogleMark /> Continue with Google
            </Button>
          )}
          <Button className="h-11 w-full text-[14.5px]" disabled={busy} onClick={() => go()}>
            {google ? 'Sign in with email' : 'Sign in or create an account'}
          </Button>
        </div>
        <p className="mt-6 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          Sign-in is handled by Amazon Cognito. Sift never sees your password.
        </p>
      </div>
    </main>
  )
}

/** Shows the app when signed in (or in local mode), otherwise the sign-in screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    void start().then((s) => alive && setState(s))
    const off = onSignedOut(() => setState({ kind: 'out', error: 'Your session ended. Please sign in again.' }))
    return () => {
      alive = false
      off()
    }
  }, [])
  if (state.kind === 'loading') return <div className="h-full bg-ground" aria-busy="true" />
  if (state.kind === 'out') return <SignInScreen error={state.error} />
  return <>{children}</>
}
