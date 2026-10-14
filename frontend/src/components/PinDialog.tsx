import { useEffect, useState } from 'react'
import { LockKeyhole } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/controls'
import { api } from '@/lib/api'
import { finishPin, useSecure } from '@/lib/secure-store'

const digitsOnly = (v: string) => v.replace(/\D/g, '').slice(0, 8)

function PinInput({
  id,
  label,
  value,
  onChange,
  autoFocus,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]*"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(digitsOnly(e.target.value))}
        className="mt-1 block w-full rounded-md border border-border bg-ground px-3 py-2 font-mono text-[18px] tracking-[0.4em] outline-none focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-ring"
      />
    </div>
  )
}

/** One PIN prompt for the whole app; opened through requestPin(). */
export function PinDialog() {
  const { pin: request } = useSecure()
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPin('')
    setConfirm('')
    setError(null)
  }, [request])

  if (!request) return null
  const setup = request.mode === 'setup'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length < 4) return setError('Use 4 to 8 digits.')
    if (setup && pin !== confirm) return setError("The two PINs don't match.")
    setBusy(true)
    setError(null)
    try {
      const { token } = setup ? await api.setPin(pin) : await api.unlock(pin)
      finishPin(token)
    } catch (err) {
      setError((err as Error).message)
      setPin('')
      setConfirm('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={() => finishPin(null)} title={setup ? 'Set up your secure folder' : 'Secure folder'}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="flex items-start gap-3 text-[13.5px] leading-relaxed text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {setup ? (
            <p>
              Choose a 4 to 8 digit PIN. Chats in the secure folder stay out of the sidebar, and show only as “Secure
              chat” elsewhere, until you enter it. It hides chats from view; it isn't encryption.
            </p>
          ) : (
            <p>{request.reason}</p>
          )}
        </div>
        <PinInput id="pin" label={setup ? 'New PIN' : 'PIN'} value={pin} onChange={setPin} autoFocus />
        {setup && <PinInput id="pin-confirm" label="Enter it again" value={confirm} onChange={setConfirm} />}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {setup && (
          <p className="text-xs text-muted-foreground">PIN recovery isn't available yet, so pick one you'll remember.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => finishPin(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || pin.length < 4 || (setup && confirm.length < 4)}>
            {setup ? 'Set PIN' : 'Unlock'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
