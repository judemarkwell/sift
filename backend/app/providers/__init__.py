from app.config import settings
from app.providers.base import ProviderAdapter, ProviderError, StopReason, StreamItem
from app.providers.mock import MOCK_PROVIDERS


def build_adapters() -> list[ProviderAdapter]:
    """Every adapter the gateway can route to. Real providers appear only
    when their key is configured, so the app always starts."""
    adapters: list[ProviderAdapter] = []
    if settings.anthropic_api_key:
        from app.providers.anthropic_adapter import AnthropicAdapter

        adapters.append(
            AnthropicAdapter(settings.anthropic_api_key, settings.max_output_tokens)
        )
    if settings.enable_mock_models or not adapters:
        adapters.extend(MOCK_PROVIDERS)
    return adapters


__all__ = ["ProviderAdapter", "ProviderError", "StopReason", "StreamItem", "build_adapters"]
