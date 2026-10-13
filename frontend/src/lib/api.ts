import type { AIRequest, ContextBreakdown, ModelInfo, Trace } from './types'

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch('/api/models')
  if (!res.ok) throw new Error(`Couldn't load models (HTTP ${res.status})`)
  return res.json()
}

export type StreamEvent =
  | { type: 'start'; trace_id: string; model: ModelInfo; context: ContextBreakdown }
  | { type: 'delta'; text: string }
  | { type: 'done'; trace: Trace }
  | { type: 'error'; message: string; trace?: Trace }

/**
 * POST to the streaming endpoint and parse Server-Sent Events.
 * (EventSource only supports GET, so we read the body stream ourselves.)
 */
export async function streamChat(
  body: Pick<AIRequest, 'model' | 'messages'> & Partial<AIRequest>,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `Request failed (HTTP ${res.status})`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = raw.match(/^event: (.*)$/m)?.[1]
      const data = raw.match(/^data: (.*)$/m)?.[1]
      if (event && data) onEvent({ type: event, ...JSON.parse(data) } as StreamEvent)
    }
  }
}
