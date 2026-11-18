# PLT-052 aceptación pagada de la caché de prompts (fase 2)

Harness de desarrollo de la PR 6/6: `apps/api/src/acceptance-gateway.ts` sigue siendo la aceptación de una llamada de PLT-009; este es su hermano para la caché (`apps/api/src/acceptance-cache.ts`, núcleo en `cache-acceptance.ts`). Diseño: [PLT-052-PROMPT-CACHING.md](architecture/PLT-052-PROMPT-CACHING.md), punto 8. Reglas de gasto heredadas de [PLT-009-PAID-CALL-HARNESS.md](PLT-009-PAID-CALL-HARNESS.md).

La PR 6/6 no ejecuta ninguna llamada real. La ejecución pagada (una sola, tope total CHF 0,10, sin reintentos de pago) la autorizó el operador. Se ejecutó el 2026-11-18 con OpenAI y con Anthropic y ambas dieron PASS (ver [OpenAI](#resultado-de-la-prueba-real-con-openai-2026-11-18) y [Anthropic](#resultado-de-la-prueba-real-con-anthropic-2026-11-18)); DeepSeek NO se ha verificado con tráfico real.

## Modo por defecto: dry-run

```
npm run accept:cache -w @jev/api
```

Sin `JEV_LIVE_CACHE_ACCEPTANCE` exacta no hay red, ni base de datos, ni gasto: imprime el plan, las llamadas previstas, la estimación de peor caso en USD y CHF (tipo de referencia 1 USD = 0,8402 CHF, 2026-11-17), el tope, las variables que faltan y los problemas. Se puede ejecutar con solo `JEV_MODEL_PRICING_JSON` y `JEV_LIVE_CACHE_MAX_CHF` para ver la estimación. Las credenciales de proveedor solo se comprueban en la ejecución pagada.

## Comando exacto de la prueba pagada

Solo tras la fusión y con las claves ya guardadas en la base local por el camino seguro de credenciales (abajo):

```
NODE_ENV=development JEV_LIVE_CACHE_ACCEPTANCE=I_AUTHORIZE_CACHE_PAID_CALLS JEV_LIVE_CACHE_MAX_CHF=0.10 npm run accept:cache -w @jev/api
```

junto con el resto de variables, definidas en el entorno de la sesión y nunca en el repositorio.

| Variable | Obligatoria | Significado |
| --- | --- | --- |
| `JEV_LIVE_CACHE_ACCEPTANCE` | para pagar | Exactamente `I_AUTHORIZE_CACHE_PAID_CALLS`. Cualquier otro valor (incluido el de PLT-009) = dry-run. |
| `JEV_LIVE_CACHE_MAX_CHF` | sí | Decimal plano (`0.10`), mayor que 0 y como máximo `0.10`; mayor = rechazo. Sin notación exponencial, signo ni espacios. |
| `JEV_MODEL_PRICING_JSON` | sí | Tarifas CHF por millón: entrada, salida y lectura de caché de los tres; Anthropic además `cacheWrite5mPerMillionChf` y `cacheWrite1hPerMillionChf`; OpenAI además `cacheWrite30mPerMillionChf` (o `cacheWriteBilledAs: "input"` solo en modelos anteriores a 5.6). |
| `NODE_ENV` | sí | `development`. |
| `DATABASE_URL` | sí | Base PostgreSQL local aislada (loopback, sin query ni fragmento), como en PLT-009. |
| `JEV_SECRET_ENCRYPTION_KEY` | sí | Clave original que cifra las credenciales guardadas. |
| `JEV_TENANT_NAMESPACE_SECRET` | sí | Secreto del `tenant_namespace` (HMAC); distinto de la clave de cifrado. |
| `JEV_ACCEPT_ORGANIZATION_ID`, `JEV_ACCEPT_PROJECT_ID`, `JEV_ACCEPT_TASK_ID` | sí | Tenant A: jerarquía existente (la tarea sin pedido). |
| `JEV_ACCEPT_OTHER_PROJECT_ID`, `JEV_ACCEPT_OTHER_TASK_ID` | sí | Tenant B: otro proyecto y su tarea (sin pedido), en la misma organización salvo `JEV_ACCEPT_OTHER_ORGANIZATION_ID` (entonces esa organización también necesita las credenciales). B debe diferir de A en organización o proyecto (el espacio de caché sale de ese par) y la tarea debe ser distinta; si no, la configuración se rechaza antes de pagar y en dry-run. |
| `JEV_ACCEPT_CACHE_PROVIDERS` | no | Lista (por defecto `anthropic,openai,deepseek`). |
| `JEV_ACCEPT_CACHE_ANTHROPIC_MODEL`, `_OPENAI_MODEL`, `_DEEPSEEK_MODEL` | no | Por defecto `claude-sonnet-5-5`, `gpt-6.1-terra` y `deepseek-flash`. Para una prueba más barata con Anthropic, `claude-haiku-5-5` con la tarifa del tramo hasta 100.000 tokens. |
| `JEV_ACCEPT_CACHE_MAX_OUTPUT_TOKENS` | no | 1 a 256, por defecto 16. |
| `JEV_ACCEPT_CACHE_PAUSE_MS` | no | Pausa entre llamadas (no es un reintento), 0 a 60000, por defecto 5000. |

El harness fuerza la caché activa (TTL híbrido: 1 h para el bloque de proyecto, 5 min para tarea) e ignora `JEV_PROMPT_CACHE`.

## Qué hace

Por cada proveedor, con un prompt sintético segmentado de unos 6,5 kB (estimado en 1.500 a 3.300 tokens; el mínimo exigido es 1.100) y de usuario trivial (`Reply with OK.`), `maxOutputTokens` 16 y `maxRetries` 0, a través de `ModelGateway.execute`:

1. A-1: tenant A. Espera escritura (obligatoria en Anthropic con 1 h y 5 min atribuidos por TTL; informativa en OpenAI).
2. A-2: tenant A, mismo prefijo. Espera lectura (> 0 y ahorro positivo).
3. B-1: tenant B. Espera NO lectura (aislamiento).

Antes de llamar estima el peor caso (todo el prompt a la tarifa más alta de entrada o escritura, incluida la de 1 h, más la salida completa) con las tarifas configuradas. Si supera el tope, o no queda ningún proveedor con todas sus tarifas y credencial, aborta sin llamar. Entre llamadas acumula el coste real y se detiene al alcanzar el tope, o antes de una llamada cuyo peor caso ya no cabe. Informe final (resumen legible y JSON): por llamada proveedor, modelo, tokens (ordinarios, lectura, escritura 5 min, 1 h, 30 min, 12 h, salida), `cache_status` persistido con su origen (`database`, `derived` o `unavailable`; si la lectura de PostgreSQL falla no se infiere de los tokens y las comprobaciones que dependen de ella quedan `INCONCLUSIVE`), coste real en CHF y ahorro; y comprobaciones `PASS`/`FAIL`/`INCONCLUSIVE`/`NOT_RUN`: escritura en la primera llamada, lectura en la segunda, aislamiento, mapeo de usage, atribución por TTL, forma y nulabilidad de `input_tokens_details` de OpenAI, formato real del error de Anthropic si ocurre, ahorro y ausencia de reintentos.

## Qué NO hace

- No reintenta ninguna llamada de pago. Un guardián de `fetch` deja pasar una sola petición de red por llamada lógica y rechaza la segunda antes de la red, incluido el reintento sin caché de la política del gateway: un rechazo de caché es un fallo del escenario de ese proveedor y este se detiene. Un fallo cuenta con el peor caso en el acumulado.
- DeepSeek es de mejor esfuerzo: sin lectura en A-2 queda `INCONCLUSIVE` (el diseño prevé un reintento tras una pausa, pero la regla de no reintentar pagos prevalece); `INCONCLUSIVE` o un proveedor saltado hacen el resultado `INCOMPLETE`, no `FAIL`.
- Un proveedor sin credencial o sin todas sus tarifas se salta con aviso y los demás siguen.
- No imprime claves, cabeceras de autorización ni contenido del prompt; del tráfico solo guarda tipos de campos (forma) y, para Anthropic, el sobre del error con el mensaje saneado.
- No crea datos, no migra, no toca credenciales, no acepta prompts arbitrarios ni fallbacks, no usa producción y no sustituye el guard de presupuesto de PLT-017: hay que fijar además un tope real en la cuenta de cada proveedor.

Código de salida: 1 si hay un `FAIL` o un error de configuración; 0 si no (con `INCOMPLETE` se revisa el informe).

## Cómo se entregan las claves

Solo por el formulario seguro del entorno del operador, guardadas cifradas en la base local con el camino de credenciales por organización (`ProviderCredentialStore`, ver [MODEL_GATEWAY.md](MODEL_GATEWAY.md)). Nunca por chat, nunca en el repositorio, en tickets, en logs ni en archivos `.env` versionados. Tras la prueba, revocar o rotar las claves del entorno local. Solo se registran en PROGRESO.md el resultado saneado, el proveedor y modelo, los tokens y el coste CHF.

## Ejecución en local por el operador (realizada para Anthropic el 2026-11-18)

La ejecución con Anthropic se hizo así el 2026-11-18 (ver su resultado más abajo). Requisitos generales, para repetirla solo si el operador lo decide:

Requisitos:

- Node y las dependencias del repositorio instaladas (`npm ci`).
- PostgreSQL local aislado (loopback) con las migraciones aplicadas, y `DATABASE_URL` apuntando a él.
- Las claves de cada proveedor guardadas con `ProviderCredentialStore` en la organización de prueba, con `JEV_SECRET_ENCRYPTION_KEY`.
- Datos de prueba A y B distintos: organización, proyecto y tarea de A, y otro proyecto y otra tarea de B (ver la tabla de variables).

Comando exacto (el de arriba, con `JEV_MODEL_PRICING_JSON` y el resto de variables ya definidas en el entorno de la sesión):

```
NODE_ENV=development JEV_LIVE_CACHE_ACCEPTANCE=I_AUTHORIZE_CACHE_PAID_CALLS JEV_LIVE_CACHE_MAX_CHF=0.10 JEV_ACCEPT_CACHE_MAX_OUTPUT_TOKENS=128 npm run accept:cache -w @jev/api
```

- `NODE_USE_ENV_PROXY=1` solo hace falta en el entorno cloud, donde el `fetch` de Node debe salir por un proxy; sin esa variable no lo usa y la petición falla con 401 (primer intento del 2026-11-18, conservado como contexto; la ejecución con la variable pasó). En un equipo local con conexión directa no se define.
- Tope CHF 0,10 (`JEV_LIVE_CACHE_MAX_CHF`; mayor se rechaza). Fija además un tope en la cuenta de cada proveedor.
- Se recomienda `JEV_ACCEPT_CACHE_MAX_OUTPUT_TOKENS=128`: con 16 un modelo con razonamiento puede agotar la salida y dar una respuesta sin texto ya pagada.
- No se reintenta. Si una ejecución falla, no se repite el pago sin que el operador lo decida; se revisa el informe.
- Interpretación por comprobación: `PASS` cumple lo esperado; `INCONCLUSIVE` no hay datos suficientes (por ejemplo DeepSeek sin lectura, o `cache_status` no disponible) y deja el resultado `INCOMPLETE`, no es un fallo; `FAIL` incumple lo esperado (por ejemplo lectura cruzada entre tenants) y el código de salida es 1; `NOT_RUN` no se ejecutó.
- No pegues claves en chats ni en issues. Pega solo el informe saneado (proveedor, modelo, tokens y coste CHF), y rota las claves al terminar.

## Pruebas (sin red ni claves)

`apps/api/src/cache-acceptance.test.ts` (guardas, dry-run con `fetch` envenenado, adaptadores simulados con escritura y lectura (`PASS`), lectura cruzada (`FAIL`), parada por tope, no reintento) y `cache-acceptance.gateway.test.ts` (`ModelGateway` y adaptadores reales con PostgreSQL y una red simulada). PLT-052 no se marca DONE (decisión del operador).

## Resultado de la prueba real con OpenAI (2026-11-18)

Resultado global PASS, una única ejecución con OpenAI `gpt-6.1-terra`, lanzada desde el hilo principal del coordinador con autorización directa del operador, `NODE_USE_ENV_PROXY=1`, tope CHF 0,10, sin reintentos de pago, `max_tokens` 128 y harness en `f05bc50` (código de `f21b767`). Las 7 comprobaciones dan PASS: write_first_call, read_second_call, tenant_isolation, usage_mapping, openai_usage_details_shape, read_saves_cost y no_paid_retry. Una llamada de red por llamada lógica; 0 reintentos bloqueados. La autorización de esa ejecución está consumida.

| Llamada | Ordinarios | Lectura | Escritura 30m | Salida | cache_status | Coste CHF | Ahorro CHF | requestId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 (cliente A) | 3 | 0 | 1341 | 5 | WRITE (database) | 0,001432 | -0,000282 | `c646edec-e7d0-44ae-a31e-1346a8c4b3ba` |
| A-2 (A, mismo prefijo) | 3 | 1341 | 0 | 5 | PARTIAL (database) | 0,000080 | +0,001070 | `fe33f195-3992-4131-9206-4743b304a86f` |
| B-1 (otro cliente) | 3 | 0 | 1346 | 5 | WRITE (database) | 0,001437 | -0,000283 | `c0e1a76f-16bf-4588-9682-3981cd720e75` |

- Aislamiento entre clientes confirmado: B no leyó la caché de A.
- Coste acumulado según el harness con las tarifas configuradas: CHF 0,002949 frente al tope de 0,10 (NO es factura; no se comprobó en el panel de OpenAI). Peor caso previo: CHF 0,022326 (USD 0,026572 a 0,8402).
- Forma real del `usage` (solo tipos): `input_tokens`, `input_tokens_details` {`cached_tokens`, `cache_write_tokens`, `cache_write_tokens_details` {`ttl_30m_tokens`, `ttl_12h_tokens`}}, `output_tokens`, `output_tokens_details` {`reasoning_tokens`}, `total_tokens`; todos números (no se observó null ni ausente). `cache_write_tokens_details` va anidado dentro de `input_tokens_details`, una de las dos ubicaciones que acepta `mapOpenAIUsage`.
- El único aviso en stderr fue el experimental UNDICI-EHPA de Node (inocuo).
- El informe completo (JSON y texto) quedó solo en el scratchpad de la sesión, sin claves ni prompt; no se versiona.

Al registrar esta ejecución Anthropic y DeepSeek seguían sin verificar; Anthropic se verificó después (sección siguiente). Sigue sin verificar: DeepSeek; el caso null frente a ausente en `input_tokens_details` de OpenAI; el coste real en el panel de OpenAI.

## Resultado de la prueba real con Anthropic (2026-11-18)

Resultado global PASS, una única ejecución con Anthropic `claude-sonnet-5-5` el 2026-11-18 a las 20:50 (hora local del operador), hecha por el operador en su ordenador (Windows, base PostgreSQL local desechable, con el script `run-cache-test-anthropic.ps1` de la sesión), tope CHF 0,10, sin reintentos de pago, `max_tokens` 128 y TTL híbrido (1 h proyecto, 5 min tarea). Comprobaciones PASS: write_first_call, read_second_call, tenant_isolation, usage_mapping, ttl_attribution, read_saves_cost y no_paid_retry. NOT_RUN: anthropic_error_format («no HTTP error occurred»). Una llamada de red por llamada lógica; 0 reintentos bloqueados. La autorización de esa ejecución está consumida.

| Llamada | Ordinarios | Lectura | Escritura 5m | Escritura 1h | Salida | cache_status | Coste CHF | Ahorro CHF | requestId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 (cliente A) | 51 | 0 | 328 | 2327 | 5 | WRITE (database) | 0,008637 | -0,004048 | `0783d1a8-354e-4fa9-9f57-4b7e75a6377f` |
| A-2 (A, mismo prefijo) | 51 | 2655 | 0 | 0 | 5 | PARTIAL (database) | 0,000351 | +0,004238 | `a5c3b0b0-650a-4b45-bf50-9f005335e95e` |
| B-1 (otro cliente) | 51 | 0 | 328 | 2329 | 5 | WRITE (database) | 0,008644 | -0,004051 | `d4c32e95-4ea3-4823-9828-74ec1ac3cfc8` |

- Aislamiento entre clientes confirmado: B no leyó la caché de A.
- Coste acumulado según el harness con las tarifas configuradas de Sonnet 5.5 (verificadas el 2026-11-18): CHF 0,017632 frente al tope de 0,10. NO es factura y no se comprobó en la consola de Anthropic. Peor caso previo: CHF 0,036367 (USD 0,043284 a 0,8402).
- Forma real del `usage` (solo tipos): `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation` {`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`}, `output_tokens`, `output_tokens_details` {`thinking_tokens`}, `service_tier`, `inference_geo`, `speed`; todos números salvo los tres últimos, que son strings.
- Confirmado con la API real: `cache_control` explícito aceptado, TTL híbrido 1h/5m atribuido correctamente por TTL, aislamiento por tenant, mapeo de `usage` y ahorro positivo en la lectura.

Estado: la caché está verificada con tráfico real en OpenAI y en Anthropic. Sigue SIN verificar con tráfico real: DeepSeek; el formato real de los errores de caché de Anthropic y la heurística `isCacheAttributableError` (anthropic_error_format NOT_RUN: no hubo error HTTP); el coste real en los paneles de OpenAI y Anthropic; el caso null/ausente en `input_tokens_details` de OpenAI. PLT-052 sigue sin marcarse DONE (decisión del operador).
