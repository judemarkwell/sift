/**
 * Frontend types come from the backend's Pydantic schema, via
 * `npm run gen:types` (writes api-schema.ts). Never edit api-schema.ts by hand.
 */
import type { components } from './api-schema'

type S = components['schemas']

export type ModelInfo = S['ModelInfo']
export type Message = S['Message']
export type AIRequest = S['AIRequest']
export type ContextBreakdown = S['ContextBreakdown']
export type PipelineStep = S['PipelineStep']
export type AIResponse = Required<S['AIResponse']>
export type Trace = Required<Omit<S['Trace'], 'response'>> & { response: AIResponse }

/** UI-side state for one message in the thread. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  modelId?: string
  status?: 'streaming' | 'done' | 'error'
  error?: string
  traceId?: string
  trace?: Trace
  context?: ContextBreakdown
}

export interface Conversation {
  id: string
  title: string
  modelId: string
  messages: ChatMessage[]
  updatedAt: number
}
