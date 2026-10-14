import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemText,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatTokens } from '@/lib/utils'
import type { ModelInfo } from '@/lib/types'

interface Props {
  models: ModelInfo[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  className?: string
}

export function ModelPicker({ models, value, onChange, disabled, className = 'w-56' }: Props) {
  // Real providers first, then the free mocks.
  const providers = [...new Set([...models].sort((a, b) => Number(b.live) - Number(a.live)).map((m) => m.provider))]

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent className="w-80">
        {providers.map((provider) => (
          <SelectGroup key={provider}>
            <SelectLabel>{provider}</SelectLabel>
            {models
              .filter((m) => m.provider === provider)
              .map((m) => (
                <SelectItem key={m.id} value={m.id} disabled={!m.allowed}>
                  <div className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <SelectItemText>{m.name}</SelectItemText>
                      {!m.allowed && (
                        <span className="rounded bg-primary/10 px-1.5 text-[11px] font-medium text-primary">
                          {m.required_plan}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {m.live
                        ? `$${m.input_price_per_mtok} in, $${m.output_price_per_mtok} out per 1M tokens. ${formatTokens(m.context_window)} context.`
                        : `Free mock. Simulates $${m.input_price_per_mtok} / $${m.output_price_per_mtok} per 1M tokens.`}
                    </span>
                  </div>
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
