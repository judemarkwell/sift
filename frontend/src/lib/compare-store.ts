/**
 * The comparison being run right now, kept outside React so it survives
 * switching tabs: streams keep writing here even while the Compare page is
 * unmounted, and the page picks up exactly where it was when you come back.
 * Finished comparisons are also saved on the server (see /api/comparisons).
 */
import { useSyncExternalStore } from 'react'

import { ApiError, api, streamChat } from '@/lib/api'
import type { Comparison, ComparisonLane, LaneStats, Trace } from '@/lib/types'

export interface LiveComparison extends Comparison {
  running: boolean
}

let current: LiveComparison | null = null
let controllers: AbortController[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function set(next: LiveComparison | null) {
  current = next
  emit()
}

function patchLane(i: number, p: Partial<ComparisonLane> | ((l: ComparisonLane) => Partial<ComparisonLane>)) {
  if (!current) return
  const lanes = current.lanes.map((l, j) => (j === i ? { ...l, ...(typeof p === 'function' ? p(l) : p) } : l))
  const running = lanes.some((l) => l.status === 'running')
  const total = lanes.reduce((n, l) => n + (l.stats?.cost_usd ?? 0), 0)
  set({ ...current, lanes, running, total_usd: total })
}

const statsFrom = (t: Trace): LaneStats => ({
  cost_usd: t.response.cost.total_usd,
  ttft_ms: t.response.timing.time_to_first_token_ms,
  total_ms: t.response.timing.total_ms,
  input_tokens: t.response.usage.total_input_tokens,
  output_tokens: t.response.usage.output_tokens,
  estimated: t.response.usage.estimated,
  truncated: t.response.finish_reason === 'length',
})

export const compareStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  get: () => current,

  /** Start a new comparison. Resolves once every lane has finished. */
  async run(prompt: string, models: string[], hooks: { onCreated?: (id: string) => void; onDone?: () => void } = {}): Promise<void> {
    controllers.forEach((c) => c.abort())
    let created: Comparison
    try {
      created = await api.createComparison(models)
    } catch (e) {
      throw e instanceof ApiError ? e : new Error((e as Error).message)
    }
    set({ ...created, prompt, title: prompt.slice(0, 60), running: true })
    hooks.onCreated?.(created.id)
    controllers = models.map(() => new AbortController())
    await Promise.all(
      models.map(async (model, i) => {
        try {
          await streamChat(
            { model, message: prompt, ephemeral: true, compare_id: created.id },
            (ev) => {
              if (ev.type === 'conversation' && current?.id === created.id && ev.styles) {
                set({ ...current, styles: ev.styles })
              }
              if (current?.id !== created.id) return
              if (ev.type === 'delta') patchLane(i, (l) => ({ content: l.content + ev.text }))
              if (ev.type === 'done')
                patchLane(i, { status: 'done', content: ev.message.content, marks: ev.message.marks, trace_id: ev.trace.id, stats: statsFrom(ev.trace) })
              if (ev.type === 'error')
                patchLane(i, {
                  status: ev.blocked ? 'blocked' : 'error',
                  error: ev.error,
                  trace_id: ev.trace.id,
                  stats: statsFrom(ev.trace),
                })
            },
            controllers[i].signal,
          )
        } catch (e) {
          if (current?.id !== created.id) return
          patchLane(i, { status: 'error', error: (e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message })
        }
      }),
    )
    // Pick up the server's masked prompt and title.
    try {
      const saved = await api.comparison(created.id)
      if (current?.id === created.id) set({ ...current, title: saved.title, prompt: saved.prompt, running: false })
    } catch {
      /* keep what we have */
    }
    hooks.onDone?.()
  },

  stop() {
    controllers.forEach((c) => c.abort())
  },

  /** Show a saved comparison (from history). */
  show(c: Comparison) {
    if (current?.running && current.id !== c.id) return // don't hide a live run; history opens read-only instead
    set({ ...c, running: false })
  },

  clear() {
    if (current?.running) return
    set(null)
  },
}

export function useLiveComparison(): LiveComparison | null {
  return useSyncExternalStore(compareStore.subscribe, compareStore.get)
}
