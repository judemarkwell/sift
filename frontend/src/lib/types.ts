/**
 * Types for the Sift API. Shapes with a Pydantic model come from the
 * generated api-schema.ts (`npm run gen:types`); dict-returning endpoints are
 * typed by hand below.
 */
import type { components } from './api-schema'

type S = components['schemas']
type Req<T> = { [K in keyof T]-?: Exclude<T[K], undefined> }

export type ModelInfo = Req<S['ModelView']>
export type Message = S['Message']
export type ContextBreakdown = Req<S['ContextBreakdown']>
export type Finding = Req<S['Finding']>
export type PipelineStep = Req<Omit<S['PipelineStep'], 'findings'>> & { findings: Finding[] }
export type Usage = Req<S['Usage']>
export type Cost = Req<S['Cost']>
export type AIResponse = Req<Omit<S['AIResponse'], 'usage' | 'cost'>> & { usage: Usage; cost: Cost }
export type Trace = Req<Omit<S['Trace'], 'response' | 'pipeline' | 'context'>> & {
  response: AIResponse
  pipeline: PipelineStep[]
  context: ContextBreakdown
}
export type StoredMessage = Req<Omit<S['StoredMessage'], 'marks'>> & { marks: Finding[] }
export type Conversation = Req<Omit<S['Conversation'], 'messages'>> & { messages: StoredMessage[] }
export type ConversationSummary = Req<S['ConversationSummary']>

export type PiiAction = 'block' | 'redact' | 'warn' | 'allow'

/** A message in the thread, including in-flight state the server doesn't store. */
export interface ChatMessage extends StoredMessage {
  streaming?: boolean
  trace?: Trace
  context?: ContextBreakdown
  livePipeline?: PipelineStep[]
}

export interface Me {
  principal: { org_id: string; user_id: string; email: string; role: 'admin' | 'member' }
  plan_id: string
  plan_name: string
  features: string[]
  available_usd: number
  platform: { daily_budget_usd: number; spent_today_usd: number; live_models: boolean }
}

export interface SkillManifest {
  id: string
  name: string
  summary: string
  description: string
  category: 'Privacy' | 'Cost' | 'Context' | 'Quality'
  stages: PipelineStep['stage'][]
  can_modify_request: boolean
  core: boolean
  default_enabled: boolean
  lockable: boolean
  config_schema: JsonSchema
}

export interface JsonSchema {
  properties?: Record<string, JsonSchemaProp>
  $defs?: Record<string, JsonSchemaProp>
}
export interface JsonSchemaProp {
  type?: string
  title?: string
  description?: string
  enum?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  items?: JsonSchemaProp
  $ref?: string
  allOf?: JsonSchemaProp[]
}

export interface SkillLayer {
  enabled?: boolean
  config?: Record<string, unknown>
  locked?: ('enabled' | 'config')[]
}

export interface SkillView {
  manifest: SkillManifest
  resolved: { id: string; enabled: boolean; config: Record<string, unknown>; locked: string[]; workspace: SkillLayer }
  user: SkillLayer
}

export interface PiiEntity {
  kind: string
  label: string
  group: string
  example: string
}

export interface SkillsResponse {
  skills: SkillView[]
  pii: {
    entities: PiiEntity[]
    presets: Record<string, { name: string; description: string; policy: Record<string, PiiAction> }>
  }
  can_admin: boolean
  workspace_policy_available: boolean
}

export interface Plan {
  id: string
  name: string
  tagline: string
  price_usd: number
  included_usage_usd: number
  sift_fee_usd: number
  per_seat: boolean
  models: string[] | null
  features: string[]
  highlights: string[]
}

export interface LedgerEntry {
  id: string
  created_at: string
  kind: 'allowance' | 'usage' | 'topup' | 'plan'
  amount_usd: number
  description: string
  paid_usd?: number
  trace_id?: string
}

export interface BillingResponse {
  plan: Plan
  seats: number
  period_start: string
  period_end: string
  included_usd: number
  allowance_remaining_usd: number
  allowance_used_usd: number
  credit_usd: number
  available_usd: number
  test_mode: boolean
  plans: Plan[]
  topups: { amounts: number[]; fee: number }
  ledger: LedgerEntry[]
}

export interface CheckoutSession {
  id: string
  amount_usd: number
  label: string
  test_mode: boolean
}

export interface UsageResponse {
  days: number
  daily: { date: string; by_model: Record<string, number>; total_usd: number }[]
  by_model: {
    model_id: string
    name: string
    provider: string
    live: boolean
    messages: number
    cost_usd: number
    avg_cost_usd: number
    input_tokens: number
    output_tokens: number
    avg_latency_ms: number
    avg_ttft_ms: number
  }[]
  totals: Partial<
    Record<
      | 'messages'
      | 'cost_usd'
      | 'live_cost_usd'
      | 'input_tokens'
      | 'output_tokens'
      | 'cache_read_tokens'
      | 'cache_saved_usd'
      | 'charged_usd',
      number
    >
  >
  privacy: Partial<Record<'redact' | 'warn' | 'block' | 'blocked_messages' | 'reply_flags', number>> & {
    by_kind: Record<string, number>
  }
  top_messages: {
    trace_id: string
    conversation_id: string
    model_id: string
    cost_usd: number
    input_tokens: number
    created_at: string
    ephemeral: boolean
  }[]
}

export type ImageRef = Req<S['ImageRef']>
export type SkillField = Req<S['SkillField']>
export interface PromptSkill {
  id: string
  org_id: string
  owner_id: string
  name: string
  description: string
  icon: string
  instructions: string
  fields: SkillField[]
  starter: string
  styles: string[]
  model_id: string | null
  ask_for_missing: boolean
  shared: boolean
  pinned: boolean
  use_count: number
  created_at: string
  updated_at: string
  mine: boolean
}

export interface StyleInfo {
  id: string
  label: string
  group: 'Length' | 'Format' | 'Purpose' | 'Tone'
  description: string
  max_tokens: number | null
}

export interface ImageQuota {
  per_day: number
  used_today: number
  remaining: number
}

export interface UploadedImage extends ImageRef {
  bytes: number
  original: { width: number; height: number; bytes: number }
  resized: boolean
  metadata_removed: boolean
  quota: ImageQuota
}

export interface PromptSkillTemplate {
  name: string
  description: string
  icon: string
  instructions: string
  fields: SkillField[]
  starter: string
  styles: string[]
}

export interface PromptSkillsResponse {
  skills: PromptSkill[]
  templates: PromptSkillTemplate[]
  icons: string[]
  limit: number | null
  can_share: boolean
}

export type PromptSkillInput = Pick<
  PromptSkill,
  'name' | 'description' | 'icon' | 'instructions' | 'fields' | 'starter' | 'styles' | 'ask_for_missing' | 'shared' | 'pinned'
> & { model_id?: string | null }

export interface AuditEntry {
  created_at: string
  actor: string
  action: string
  target: string
  detail: Record<string, unknown>
}
