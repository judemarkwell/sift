from app.providers.base import ProviderAdapter
from app.providers.mock import MOCK_PROVIDERS

# Registry of every adapter the gateway can route to.
# Add real adapters here later, e.g. OpenAIAdapter(), BedrockAdapter().
ADAPTERS: list[ProviderAdapter] = [*MOCK_PROVIDERS]

__all__ = ["ADAPTERS", "ProviderAdapter"]
