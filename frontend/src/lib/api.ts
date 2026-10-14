import type {
  BillingResponse,
  CheckoutSession,
  ContextBreakdown,
  Conversation,
  ConversationSummary,
  Finding,
  Me,
  ModelInfo,
  PipelineStep,
  SkillLayer,
  SkillsResponse,
  StoredMessage,
  Trace,
  UsageResponse,
} from './types'

/** An API error with the server's message and, for plan limits, a code. */
export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  const detail = body?.detail
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return new ApiError(detail.message, res.status, detail.code)
  }
  if (typeof detail === 'string') return new ApiError(detail, res.status)
  return new ApiError(`Request failed (HTTP ${res.status})`, res.status)
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json' } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!res.ok) throw await errorFrom(res)
  if (res.status === 204) return undefined as T
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>
}

export const api = {
  me: () => request<Me>('/api/me'),
  models: () => request<ModelInfo[]>('/api/models'),
  conversations: () => request<ConversationSummary[]>('/api/conversations'),
  conversation: (id: string) => request<Conversation>(`/api/conversations/${id}`),
  renameConversation: (id: string, title: string) =>
    request<ConversationSummary>(`/api/conversations/${id}`, { method: 'PATCH', json: { title } }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),
  report: (id: string) => request<string>(`/api/conversations/${id}/report`),
  trace: (id: string) => request<Trace>(`/api/traces/${id}`),
  skills: () => request<SkillsResponse>('/api/skills'),
  patchSkill: (id: string, patch: SkillLayer & { reset?: boolean }, workspace = false) =>
    request<SkillsResponse>(`/api/${workspace ? 'workspace/' : ''}skills/${id}`, { method: 'PATCH', json: patch }),
  scan: (text: string) => request<{ enabled: boolean; findings: Finding[] }>('/api/pii/scan', { method: 'POST', json: { text } }),
  usage: (days: number) => request<UsageResponse>(`/api/usage?days=${days}`),
  billing: () => request<BillingResponse>('/api/billing'),
  checkout: (body: { plan_id?: string; topup_usd?: number; seats?: number }) =>
    request<CheckoutSession>('/api/billing/checkout', { method: 'POST', json: body }),
  completeCheckout: (id: string) =>
    request<BillingResponse>(`/api/billing/checkout/${id}/complete`, { method: 'POST' }),
}

export type StreamEvent =
  | { type: 'conversation'; conversation_id: string; user_message_id: string }
  | {
      type: 'start'
      trace_id: string
      model: ModelInfo
      context: ContextBreakdown
      prompt_marks: Finding[]
      pipeline: PipelineStep[]
    }
  | { type: 'delta'; text: string }
  | { type: 'done'; trace: Trace; message: StoredMessage; user_message: StoredMessage }
  | { type: 'error'; error: string; blocked: boolean; trace: Trace; message: StoredMessage; user_message: StoredMessage }

/**
 * POST to the streaming endpoint and parse Server-Sent Events.
 * (EventSource only supports GET, so we read the body stream ourselves.)
 */
export async function streamChat(
  body: { conversation_id?: string | null; model: string; message: string; ephemeral?: boolean },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw await errorFrom(res)

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
      if (!event || !data) continue
      onEvent({ type: event, ...JSON.parse(data) } as StreamEvent)
    }
  }
}
