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
}

export function ModelPicker({ models, value, onChange, disabled }: Props) {
  const providers = [...new Set(models.map((m) => m.provider))]

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-56" aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent className="w-80">
        {providers.map((provider) => (
          <SelectGroup key={provider}>
            <SelectLabel>{provider}</SelectLabel>
            {models
              .filter((m) => m.provider === provider)
              .map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <div className="flex flex-col gap-0.5">
                    <SelectItemText>{m.name}</SelectItemText>
                    <span className="text-xs text-muted-foreground">
                      ${m.input_price_per_mtok} in, ${m.output_price_per_mtok} out per 1M tokens.{' '}
                      {formatTokens(m.context_window)} context.
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
