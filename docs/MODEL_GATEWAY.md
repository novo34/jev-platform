# Model Gateway and provider credentials

PLT-009 introduces a provider-neutral Model Gateway and the minimum secure provider-secret layer required to use real providers.

## Providers

OpenAI Responses requests explicitly send `store: false` so task prompts,
code and generated output are not retained in the provider's default
server-side response store. Provider-side abuse monitoring and other
provider-level data processing are governed separately by the provider's
contract and settings.

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

Provider requests are subject to bounded limits before any paid operation:
at most four distinct provider/model targets and eight provider attempts
across the complete fallback chain; up to five retries per target; 1–300,000
milliseconds per HTTP request including the response body; and optional
`maxOutputTokens` between 1 and 32,768. Invalid limits are rejected before
fetch. Retryable failures use bounded exponential backoff; a server
`Retry-After` header is honored, and backoffs over five seconds skip the
repeated paid call. The final attempt is recorded even when the shared
attempt budget expires. Every paid response requires valid usage and
nonnegative finite configured pricing, capped at CHF 1,000,000 per million tokens per usage category; estimates must fit the persisted NUMERIC(14,6) amount. The supplied order, task, project and
organization must match exactly for cost attribution.

## Prompt caching: NOT_IMPLEMENTED (planificado, prioridad adelantada)

Estado: **NOT_IMPLEMENTED**. Hoy solo existen los adaptadores OpenAI y DeepSeek, y ninguno marca caché de prompts ni registra tokens de escritura o lectura de caché. El operador adelantó esta capacidad en el roadmap el 2026-11-17 por el coste de tokens (ver [ROADMAP](product-specs/ROADMAP.md#prioridad-de-ejecución-ajustada-2026-11-17)); el cambio de prioridad sigue pendiente de reflejarse en Foundation.

Diseño planificado (REQ-CACHE-001..007 en la [SPEC](product-specs/SPEC.md)):

- Prefijo estable al inicio de la petición: instrucciones del sistema, reglas, skills y especificación. Contenido variable (tarea, ContextPack específico, historial) al final. El prefijo debe ser determinista byte a byte.
- El futuro adaptador Anthropic debe nacer con caché (`cache_control`); no se añadirá primero sin caché.
- Cada llamada registra tokens de entrada, salida, escritura de caché y lectura de caché, y se agregan por llamada, tarea y proyecto. El precio de escritura y lectura de caché se configura aparte en `JEV_MODEL_PRICING_JSON`.
- Se expone la tasa de acierto de caché para medir el ahorro real.
- Un fallo de caché no bloquea la llamada: se ejecuta sin caché y se registra el motivo.

## Live verification

CI uses deterministic fake adapters and real PostgreSQL. Final PLT-009 acceptance still requires live DeepSeek and OpenAI/Codex calls after credentials are configured through the secure credential path. (Actualizado 2026-11-17: completada, ver evidencia en el estado de la aceptación más abajo.)

> **Estado de la aceptación (2026-11-17).** Aceptación con llamadas de pago reales confirmada por el operador el 2026-11-17 (estado DONE). Ejecución del 2026-10-13 con el harness de desarrollo `npm run accept:gateway -w @jev/api` sobre `main` local en `4da1e99` (`maxOutputTokens=16`, `maxRetries=0`, sin fallback, organización de desarrollo local): DeepSeek `deepseek-flash` (request `3d714fb4-3801-4dfe-be7c-305245c1a8e2`, 1 intento, tokens 34/16/50, coste estimado CHF 0.0000245) y OpenAI `gpt-4.1-nano` (request `f76632ed-cbc6-4bd0-876b-19c97ef95b46`, 1 intento, tokens 11/2/13, coste estimado CHF 0.0000019), ambos SUCCESS con llamada y coste persistidos en PostgreSQL. Los importes CHF son estimaciones con precios configurados, no facturas. Evidencia: [issue #12](https://github.com/novo34/jev-platform/issues/12) ([comentario del 2026-10-13](https://github.com/novo34/jev-platform/issues/12#issuecomment-6152023926); cerrado como completado por el operador el 2026-10-22); CI de integración del gateway: [run 38158880609](https://github.com/novo34/jev-platform/actions/runs/38158880609) (2026-10-11, merge de PR #9 en `6f4b822`, SUCCESS); CI posterior: [run 39810983854](https://github.com/novo34/jev-platform/actions/runs/39810983854) (2026-10-22, head de PR #22 `805c57b`, validate, staging-runtime-smoke, staging-compose y staging-image-build SUCCESS). Ejecución aportada por el operador, no re-ejecutada en esta revisión. Se conserva el historial: el 2026-10-12 solo constaban health checks de OpenAI y DeepSeek, sin llamada pagada con coste persistido, y el documento [PLT-009-LIVE-ACCEPTANCE.md](PLT-009-LIVE-ACCEPTANCE.md) declaraba `LIVE_PAID_CALL_ACCEPTANCE=PENDING`.
