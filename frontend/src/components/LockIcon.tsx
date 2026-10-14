import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

const LIFT = '140ms'
const TURN = '220ms'

/**
 * The lucide "lock-keyhole" icon with a padlock-style shackle. Unlocking lifts
 * the shackle, then turns it half a turn on its left leg so the open end faces
 * the other way. Locking reverses it: turn back, then drop in. (The half turn
 * is a horizontal flip, which is what a turn about the leg looks like face-on.)
 */
export function LockIcon({ open, className }: { open: boolean; className?: string }) {
  const reduced = useReducedMotion()
  const transition = reduced
    ? 'none'
    : open
      ? `translate ${LIFT} ease-out, scale ${TURN} ease-in-out ${LIFT}`
      : `scale ${TURN} ease-in-out, translate ${LIFT} ease-in ${TURN}`

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('overflow-visible', className)}
    >
      <path
        d="M7 10V7a5 5 0 0 1 10 0v3"
        style={{
          transformBox: 'view-box',
          transformOrigin: '7px 10px', // the left leg
          translate: open ? '0 -4px' : '0 0',
          scale: open ? '-1 1' : '1 1',
          transition,
        }}
      />
      <rect x="3" y="10" width="18" height="12" rx="2" />
      <circle cx="12" cy="16" r="1" />
    </svg>
  )
}
