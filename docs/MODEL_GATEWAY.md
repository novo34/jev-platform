# Model Gateway and provider credentials

PLT-009 introduces a provider-neutral Model Gateway and the minimum secure provider-secret layer required to use real providers.

## Providers

The first production adapters are:

- OpenAI through `POST https://api.openai.com/v1/responses`;
- DeepSeek through `POST https://api.deepseek.com/chat/completions`.

The registry contract is provider-neutral, so Qwen and GLM can be added without changing agent contracts.

## Credential management

Provider API keys are never committed to the repository and are never returned to API clients after submission.

Authorized ADMIN users can use the backend contract that the future UI will consume:

- `GET /providers` — configuration metadata only;
- `PUT /providers/:provider/credential` — configure or rotate a key;
- `DELETE /providers/:provider/credential` — remove a key;
- `POST /providers/:provider/test` — verify the configured credential.

Secret material is encrypted server-side with AES-256-GCM. The master key is supplied externally as `JEV_SECRET_ENCRYPTION_KEY` (32 random bytes encoded as base64). PostgreSQL stores ciphertext, IV, authentication tag, last four characters and audit metadata; it never stores the provider key in plaintext.

PLT-032 expands this baseline with the full secrets-management UI, additional secret types, scoped worker injection and production/development isolation. It must extend this contract rather than replace it.

## Calls, retry and fallback

Each gateway request declares an ordered list of provider/model targets. The gateway verifies pricing before a paid provider call, loads the organization-scoped credential, enforces timeout, retries retryable failures, falls back when allowed, applies a circuit breaker, and persists attempts, latency, fallback provenance, normalized usage and estimated CHF cost.

Pricing is configuration, not hard-coded provider truth. Runtime pricing is supplied through `JEV_MODEL_PRICING_JSON`, keyed by `provider:model` or `provider:*`, with `inputPerMillionChf` and `outputPerMillionChf`.

Missing pricing blocks a paid call instead of silently recording an incorrect cost.

## Live verification

CI uses deterministic fake adapters and real PostgreSQL. Final PLT-009 acceptance still requires live DeepSeek and OpenAI/Codex calls after credentials are configured through the secure credential path.
