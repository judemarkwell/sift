import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

import { api } from '@/lib/api'
import type { ConversationSummary, Me, ModelInfo, StyleInfo } from '@/lib/types'

interface AppData {
  me: Me | null
  models: ModelInfo[]
  conversations: ConversationSummary[]
  styles: StyleInfo[]
  loadError: string | null
  refreshMe: () => Promise<void>
  refreshModels: () => Promise<void>
  refreshConversations: () => Promise<void>
}

const Ctx = createContext<AppData | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [styles, setStyles] = useState<StyleInfo[]>([])

  const refreshMe = useCallback(async () => setMe(await api.me()), [])
  const refreshModels = useCallback(async () => setModels(await api.models()), [])
  const refreshConversations = useCallback(async () => setConversations(await api.conversations()), [])

  useEffect(() => {
    Promise.all([refreshMe(), refreshModels(), refreshConversations(), api.styles().then(setStyles)]).catch((err: Error) =>
      setLoadError(err.message),
    )
  }, [refreshMe, refreshModels, refreshConversations])

  return (
    <Ctx.Provider value={{ me, models, conversations, styles, loadError, refreshMe, refreshModels, refreshConversations }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAppData(): AppData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppData must be used inside AppDataProvider')
  return v
}

/** The model a new chat starts on: the cheapest real model the plan allows, else the first mock. */
export function defaultModelId(models: ModelInfo[]): string {
  const live = models.filter((m) => m.live && m.allowed).sort((a, b) => a.input_price_per_mtok - b.input_price_per_mtok)
  return live[0]?.id ?? models.find((m) => m.allowed)?.id ?? models[0]?.id ?? ''
}
