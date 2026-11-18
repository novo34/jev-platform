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

Pricing is configuration, not hard-coded provider truth. Runtime pricing is supplied through `JEV_MODEL_PRICING_JSON`, keyed by `provider:model` or `provider:*`, with `inputPerMillionChf` and `outputPerMillionChf`. Optional cache fields (PLT-052, all CHF per million tokens, same bounds): `cacheReadPerMillionChf`, `cacheWrite5mPerMillionChf`, `cacheWrite1hPerMillionChf`, `cacheWrite30mPerMillionChf`, `cacheWrite12hPerMillionChf`, `cacheWriteBilledAs: "input"` (explicit declaration that writes are billed at the input rate; never assumed; honoured only for DeepSeek and OpenAI models before 5.6, ignored for Anthropic, whose per-TTL write rates stay mandatory) and `maxPromptTokens` (pricing-tier ceiling, e.g. Haiku 5.5 at 100000).

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

<a id="prompt-caching"></a>

## Prompt caching: implementado, pendiente de la aceptación pagada (PLT-052, PR 6/6)

Estado: diseño aprobado el 2026-11-18 ([PLT-052-PROMPT-CACHING.md](architecture/PLT-052-PROMPT-CACHING.md)); implementación por PR, cada una autorizada aparte (R3). **El adaptador Anthropic (PR 4/6) ya marca caché con `cache_control` explícito solo con `JEV_PROMPT_CACHE=on` y un prompt segmentado; por defecto sigue `off` y no se ha hecho ninguna llamada real.** Hecho hasta la PR 5/6:

- Modelo de uso normalizado común (`NormalizedUsage`: entrada ordinaria, salida, lectura, escritura total y por TTL, `totalInputTokens`, `totalTokens`) y mapeo puro de Anthropic, OpenAI y DeepSeek (`usage.ts`). OpenAI y DeepSeek ya lo usan; el mapeo de Anthropic solo tiene pruebas, sin adaptador. Una respuesta con contadores de caché inconsistentes se rechaza como `PROVIDER_RESPONSE_INVALID`.
- Verificación real de la caché (2026-11-18): OpenAI `gpt-6.1-terra` (una ejecución, PASS 7/7) y Anthropic `claude-sonnet-5-5` (una ejecución, PASS, anthropic_error_format NOT_RUN), y DeepSeek `deepseek-flash` (una ejecución, PASS, sin comprobación de escritura), ver [PLT-052-CACHE-ACCEPTANCE.md](PLT-052-CACHE-ACCEPTANCE.md). La caché está verificada con tráfico real en los tres proveedores. Sigue sin verificar: el formato real de los errores de caché de Anthropic y la heurística `isCacheAttributableError`; el coste real en los paneles de OpenAI y DeepSeek (el de Anthropic sí coincidió: US$ 0,02 en el panel frente a CHF 0,0176, unos US$ 0,021, del harness); el caso null/ausente en `input_tokens_details` de OpenAI. PLT-052 no está marcada DONE.
- Precios de caché en `JEV_MODEL_PRICING_JSON` y validación previa: si falta una tarifa aplicable, la llamada queda `BLOCKED` con `PRICING_REQUIRED` antes de ejecutarse. **Cambio intencional:** OpenAI y DeepSeek exigen ya `cacheReadPerMillionChf` (cachean de forma automática y no se puede apagar); solo afecta al harness de desarrollo `accept:gateway`, único llamador. `NOT_ESTIMABLE` solo para respuestas inesperadas ya recibidas (por ejemplo, tokens de caché sin tarifa): se registra la llamada con `error_code=NOT_ESTIMABLE`, el motivo en `cache_reason` y una alerta, sin evento de coste y sin sustituir por la tarifa de entrada; `ModelGatewayResult.estimatedCostChf` es `null` en ese caso. Con `maxPromptTokens` configurado (tramo ≤ 100.000 tokens de Haiku 5.5) un prompt mayor queda `BLOCKED` con `PROMPT_TOO_LARGE_FOR_TIER` antes de llamar, con una estimación conservadora (2 bytes UTF-8 por token); si tras la respuesta `totalInputTokens` lo supera, el coste es `NOT_ESTIMABLE`.
- Migración `0029` (columnas de caché y `anthropic` en los `CHECK` de proveedor). Cada llamada registra tokens de lectura/escritura, `cache_status` (observable `HIT`, `PARTIAL` o `WRITE`, vacío si no hay tokens de caché; `DISABLED` y `ERROR` los decide el gateway), coste sin caché y ahorro. Los hashes de prefijo se rellenan desde la PR 4/6 en las llamadas con prompt segmentado (`NULL` con `prompt` de texto).

- Interruptor de caché (PR 3/6): `JEV_PROMPT_CACHE=on|off`, **por defecto `off`** (ausente = `off`; cualquier otro valor, incluidos vacío, `ON` o `true`, es un error `CACHE_CONFIG_INVALID`, nunca `on` en silencio). `JEV_PROMPT_CACHE_PROVIDERS` (lista separada por comas, validada contra los proveedores conocidos) limita dónde se permite con `on`; sin lista, todos; nunca activa un `off`. Se lee con `CachePolicy.fromEnv(env)` y se inyecta en `ModelGateway` (último parámetro; por defecto apagada). Con `off`, o con el proveedor fuera de la lista, el gateway no pide marcas de caché al adaptador y la llamada registra `cache_status=DISABLED` con `cache_reason`. **OpenAI y DeepSeek cachean de forma automática y eso no se puede apagar:** con `off` solo se deja de enviar `cache_control` y `prompt_cache_key`; sus lecturas siguen registrándose en las columnas de tokens y facturándose, y el motivo lo dice. Cada adaptador declara `cacheSupport` (`explicit`, `automatic` o `none`; opcional: sin declarar equivale a `none`).
- Fallo seguro (PR 3/6): si la caché estaba marcada (interruptor `on`, proveedor permitido y adaptador `explicit`) y el proveedor responde 400 o 422 con un mensaje que nombra la caché (`cache`, `breakpoint`, `ephemeral`, `ttl`), se reintenta **una sola vez** sin caché, sin consumir `maxRetries` pero sí el tope de 8 intentos. No se reintenta sin caché ante 401, 429, 5xx, tiempos de espera ni un 400 ajeno a la caché. Se registra el intento rechazado como una fila `FAILED` con `cache_status=ERROR`, sin coste (una petición rechazada no se factura), y la llamada con éxito con `cache_status=ERROR` y el motivo; solo esta genera `cost_events`, de modo que el coste nunca se duplica. Si el segundo intento falla también, el error se propaga (ambas filas `ERROR`). Los precios ausentes bloquean antes de llamar, con la caché en `on` u `off`.

- Adaptador Anthropic (PR 4/6): `anthropic` en `MODEL_PROVIDERS` (la credencial se configura por organización como las demás; el nombre del proveedor ya está admitido en los `CHECK` de `0020`/`0029`, y un test lo exige para todo `MODEL_PROVIDERS`). `POST {base}/v1/messages` con cabeceras `x-api-key` y `anthropic-version: 2026-10-21` (valor de la documentación consultada el 2026-11-18). `ModelGatewayRequest` admite `prompt` (texto, nunca se cachea) o `segments` (+ `tools`), exactamente uno; los segmentos pasan por `buildPrompt` con un `tenant_namespace` HMAC por organización y proyecto, cuyo secreto se inyecta como último parámetro de `ModelGateway` (`JEV_TENANT_NAMESPACE_SECRET`, que lee quien construye el gateway; sin él, un prompt segmentado se rechaza con `INVALID_REQUEST`). Diseño de la petición: `system` = texto de `tools` + bloques de proyecto + `task_context`; un único mensaje `user` con `history` + `input`. Breakpoints explícitos por bloque (máximo 3 de los 4 permitidos, nunca el `cache_control` automático de nivel superior): final del bloque de proyecto (TTL `JEV_PROMPT_CACHE_PROJECT_TTL`, por defecto `1h`), último bloque de tarea (`task_context`) y último bloque de `history` (TTL `JEV_PROMPT_CACHE_TASK_TTL`, por defecto `5m`); 1 h siempre antes que 5 min, y `5m` para proyecto con `1h` para tarea es un error de configuración. Las `tools` se envían como el texto canónico que se hashea, no como parámetro `tools` de la API (el gateway no tiene bucle de herramientas). Mínimos de caché por modelo (512 tokens en Sonnet 5.5, Haiku 5.5 y Opus 5.5; 1.024, 2.048 y 4.096 en otros) en `cacheSupport.minPrefixTokens`; un modelo desconocido no tiene mínimo. Con el interruptor `on` se exige antes de llamar la tarifa de lectura y la de escritura de cada TTL que se va a marcar (si falta, `BLOCKED` con `PRICING_REQUIRED`), aunque la tarifa declare `cacheWriteBilledAs: "input"`; si planificar la petición falla, el destino queda `BLOCKED` sin llamar y se prueba el siguiente; con `off`, solo entrada y salida. Estados nuevos: `UNSUPPORTED` (interruptor `on` pero adaptador sin soporte de marcas, o `prompt` de texto sin segmentos que marcar; los tokens de caché observados prevalecen), `MISS` y `BELOW_MINIMUM` (marcas enviadas y ambos contadores a 0; `BELOW_MINIMUM` si `totalInputTokens` es menor que el mínimo del modelo, `MISS` si no o si el mínimo no se conoce). Errores: 429, 529 y 5xx son reintentables y respetan `Retry-After`; 400/401/403/404/413 no; un 400 que nombra la caché sigue la política de reintento único sin caché de la PR 3/6. Sin `maxOutputTokens` se envía `max_tokens=4096` (obligatorio en la API). Los modelos Claude 5.x piensan por defecto y el razonamiento comparte `max_tokens`: un tope muy pequeño puede dejar la respuesta sin bloque de texto (`PROVIDER_RESPONSE_INVALID`).

- Métricas y alerta (PR 5/6, migración `0030`): tres vistas de solo lectura, `model_cache_metrics_by_call`, `_by_task` y `_by_project`, con `organization_id` como primera columna: tokens leídos, escritos y ordinarios, tasa de acierto (lectura / (lectura + escritura + entrada ordinaria), 0 sin entrada), coste real, coste sin caché, ahorro estimado en CHF (puede ser negativo) y recuento de `cache_status`. Las vistas agregadas devuelven `calls_without_cache_baseline` (llamadas `SUCCESS` sin coste sin caché o sin ahorro, p. ej. anteriores a `0029`): si es mayor que 0, `cost_without_cache_chf` y `cache_savings_chf` son `NULL` (desconocidos, nunca una suma parcial); `cost_chf` suma los costes conocidos y `calls_not_estimable` cuenta los que faltan. El nivel `project` rechaza `taskId` con 400 (la vista no tiene dimensión de tarea) en vez de ignorarlo; `task` y `call` aplican `projectId` y `taskId` a la vez. Se leen con `CacheMetricsReader` (`organizationId` obligatorio en cada consulta; no hay RLS) y con `GET /model-gateway/cache-metrics/{project|task|call}?projectId=&taskId=&limit=` (solo ADMIN, organización de la sesión). Tras desplegar `0030` hay que volver a ejecutar `provision-runtime-role.sql` para el `SELECT` de `jev_runtime` sobre las vistas. La migración añade la huella completa del prefijo (`prefix_tools_sha256`, `prefix_segment_refs`) y el gateway la compara con la última llamada con éxito de la misma tarea: si un hash cambia sin cambio declarado de `version`, `id`, `kind` ni `tools`, emite `PROMPT_UNSTABLE_CONTENT` por `onAlert` sin bloquear la llamada.

- Harness de aceptación de la caché (PR 6/6): `npm run accept:cache -w @jev/api`. Por defecto es un dry-run sin red, base de datos ni gasto (plan, estimación en USD y CHF, variables que faltan). La ejecución pagada exige `JEV_LIVE_CACHE_ACCEPTANCE=I_AUTHORIZE_CACHE_PAID_CALLS` y `JEV_LIVE_CACHE_MAX_CHF` (> 0 y como máximo 0,10), estima el peor caso antes de llamar, para al alcanzar el tope y no reintenta ninguna llamada de pago. Detalle, variables, comando exacto y entrega de claves: [PLT-052-CACHE-ACCEPTANCE.md](PLT-052-CACHE-ACCEPTANCE.md). La PR no hizo ninguna llamada real; la ejecución pagada está pendiente.

Principios del diseño (REQ-CACHE-001..007 en la [SPEC](product-specs/SPEC.md)):

- Prefijo estable al inicio de la petición: instrucciones del sistema, reglas, skills y especificación. Contenido variable (tarea, ContextPack específico, historial) al final. El prefijo debe ser determinista byte a byte.
- El adaptador Anthropic nació con caché (`cache_control`) y con el interruptor `off` por defecto.
- Se expone la tasa de acierto de caché para medir el ahorro real.
- Un fallo de caché no bloquea la llamada: se ejecuta sin caché y se registra el motivo. Ese intento sin caché es el último contra el destino (no hay más reintentos si falla) y cuenta en el tope compartido de 8 intentos.

## Live verification

CI uses deterministic fake adapters and real PostgreSQL. Final PLT-009 acceptance still requires live DeepSeek and OpenAI/Codex calls after credentials are configured through the secure credential path. (Actualizado 2026-11-17: completada, ver evidencia en el estado de la aceptación más abajo.)

> **Estado de la aceptación (2026-11-17).** Aceptación con llamadas de pago reales confirmada por el operador el 2026-11-17 (estado DONE). Ejecución del 2026-10-13 con el harness de desarrollo `npm run accept:gateway -w @jev/api` sobre `main` local en `4da1e99` (`maxOutputTokens=16`, `maxRetries=0`, sin fallback, organización de desarrollo local): DeepSeek `deepseek-flash` (request `3d714fb4-3801-4dfe-be7c-305245c1a8e2`, 1 intento, tokens 34/16/50, coste estimado CHF 0.0000245) y OpenAI `gpt-4.1-nano` (request `f76632ed-cbc6-4bd0-876b-19c97ef95b46`, 1 intento, tokens 11/2/13, coste estimado CHF 0.0000019), ambos SUCCESS con llamada y coste persistidos en PostgreSQL. Los importes CHF son estimaciones con precios configurados, no facturas. Evidencia: [issue #12](https://github.com/novo34/jev-platform/issues/12) ([comentario del 2026-10-13](https://github.com/novo34/jev-platform/issues/12#issuecomment-6152023926); cerrado como completado por el operador el 2026-10-22); CI de integración del gateway: [run 38158880609](https://github.com/novo34/jev-platform/actions/runs/38158880609) (2026-10-11, merge de PR #9 en `6f4b822`, SUCCESS); CI posterior: [run 39810983854](https://github.com/novo34/jev-platform/actions/runs/39810983854) (2026-10-22, head de PR #22 `805c57b`, validate, staging-runtime-smoke, staging-compose y staging-image-build SUCCESS). Ejecución aportada por el operador, no re-ejecutada en esta revisión. Se conserva el historial: el 2026-10-12 solo constaban health checks de OpenAI y DeepSeek, sin llamada pagada con coste persistido, y el documento [PLT-009-LIVE-ACCEPTANCE.md](PLT-009-LIVE-ACCEPTANCE.md) declaraba `LIVE_PAID_CALL_ACCEPTANCE=PENDING`.
