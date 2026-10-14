import { cn } from '@/lib/utils'

/**
 * The lucide "lock-keyhole" icon with a shackle that lifts and swings open.
 * The shackle pivots on its left leg; reduced-motion users get an instant swap.
 */
export function LockIcon({ open, className }: { open: boolean; className?: string }) {
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
        style={{ transformBox: 'view-box', transformOrigin: '7px 10px' }}
        className={cn(
          'transition-transform duration-[250ms] ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none',
          open ? 'translate-y-[-3px] rotate-[-28deg]' : 'translate-y-0 rotate-0',
        )}
      />
      <rect x="3" y="10" width="18" height="12" rx="2" />
      <circle cx="12" cy="16" r="1" />
    </svg>
  )
}
