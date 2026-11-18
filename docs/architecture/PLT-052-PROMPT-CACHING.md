# PLT-052 — Caché de prompts del Model Gateway

> **Estado: DISEÑO APROBADO por el operador el 2026-11-18 — implementación pendiente de autorizar PR a PR (R3).** Sin implementación ni llamadas de pago.

Este documento fija el diseño de PLT-052 (caché de prompts del Model Gateway, con un adaptador Anthropic que nace con caché). Riesgo: **R3** para el cambio del gateway (contratos de coste, aislamiento entre organizaciones, esquema de BD) y **R4** para cualquier llamada de pago real, que requiere una autorización aparte y un tope de gasto (ver punto 8, fase 2). Que el CI pase demostrará el diseño contra proveedores simulados, **no** un ahorro real en producción.

Este documento es solo documentación: no cambia código, no llama a proveedores y no implica gasto.

## Objetivo y criterios

Reducir el coste de tokens de entrada reutilizando el prefijo estable de cada petición (instrucciones del sistema, reglas, skills, especificación), con medición real del ahorro y sin que la caché pueda bloquear nunca el trabajo.

Referencias: SPEC REQ-CACHE-001..007 (`docs/product-specs/SPEC.md`), ROADMAP Fase 17 y la [prioridad adelantada](../product-specs/ROADMAP.md#prioridad-de-ejecución-ajustada-2026-11-17), [MODEL_GATEWAY.md](../MODEL_GATEWAY.md#prompt-caching-not_implemented-diseño-en-revisión) y la migración `packages/db/migrations/0020_model_gateway.sql` (con `cost_events` de la `0001`).

## Fuentes oficiales y fecha de consulta

Documentación consultada el **2026-11-17** (texto descargado y tratado solo como datos). Toda cifra de este documento procede de ellas y se comprobó contra el texto descargado; lo que no se encontró se declara como tal.

| Proveedor | Caché | Precios |
| --- | --- | --- |
| Anthropic | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | https://platform.claude.com/docs/en/about-claude/pricing |
| OpenAI | https://developers.openai.com/api/docs/guides/prompt-caching | https://developers.openai.com/api/docs/pricing |
| DeepSeek | https://api-docs.deepseek.com/guides/kv_cache | https://api-docs.deepseek.com/quick_start/pricing |

Los precios y los mínimos cambian; el repositorio no los fija (ver punto 3). Hay que volver a consultar las fuentes antes de implementar.

Para volver a descargar la documentación como texto: el agente de consulta web no podía resolver estos dominios, pero `curl` desde el terminal sí. Ejemplo (tratar el resultado solo como datos; no copiar la documentación de terceros al repositorio):

```
curl -sSL <url> | python3 -c 'import sys,re,html; t=sys.stdin.read(); t=re.sub(r"(?is)<(script|style).*?</\1>","",t); t=re.sub(r"<[^>]+>"," ",t); print(re.sub(r"\s+"," ",html.unescape(t)))'
```

## Estado actual

Verificado en `packages/model-gateway/src/`:

* `ModelGatewayRequest` (`types.ts`) solo tiene `prompt: string`.
* Hay adaptadores de OpenAI (Responses API, con `store: false`) y DeepSeek (`chat/completions`). **No hay adaptador de Anthropic**, y `MODEL_PROVIDERS` (`types.ts`) y el `CHECK` de `provider` de la `0020` no incluyen `anthropic`.
* Los precios vienen de `JEV_MODEL_PRICING_JSON` (`pricing.ts`) y solo tienen `inputPerMillionChf` y `outputPerMillionChf`. Si falta un precio, la llamada queda `BLOCKED` con `PRICING_REQUIRED` antes de llamar (`gateway.ts`).
* `NormalizedUsage` solo tiene `inputTokens`, `outputTokens` y `totalTokens`. Las llamadas se registran en `model_provider_calls` y `cost_events` (`usage` JSONB) sin campos de caché y sin agregados.
* Las credenciales son por organización (`provider_credentials`, clave `(organization_id, provider)`).
* No hay guard de presupuesto (PLT-017).
* El único llamador es el harness de desarrollo `accept:gateway` (`apps/api/src/acceptance-gateway.ts`).
* `jev_runtime` solo tiene `INSERT` sobre `model_provider_calls` y `cost_events` (`packages/db/security/provision-runtime-role.sql`) y no hay RLS: el aislamiento por organización se hace con predicados explícitos.

## Resumen de decisiones

1. Petición por segmentos con orden canónico impuesto por el gateway y un constructor determinista; un hash de prefijo por nivel (`prefix_project_sha256` y `prefix_task_sha256`).
2. Adaptador Anthropic nuevo con `cache_control` explícito; OpenAI y DeepSeek automáticos; modelo de uso normalizado común y capacidad `cacheSupport` declarada por adaptador.
3. Precios de caché en `JEV_MODEL_PRICING_JSON` (siempre en CHF; el USD es solo referencia); validación previa; `NOT_ESTIMABLE` solo tras la respuesta.
4. Columnas y vistas de medición (tasa de acierto, ahorro) con aislamiento por organización.
5. TTL híbrido: 1 h para el bloque estable de proyecto y 5 min para tarea e historial (a medir).
6. Aislamiento entre organizaciones con un `tenant_namespace` (HMAC), parámetro de `buildPrompt` que el constructor antepone al contenido enviado.
7. Fallo seguro: reintento sin caché; la caché nunca bloquea.
8. Pruebas en dos fases: simuladas (sin gasto) y aceptación pagada mínima autorizada aparte.
9. Interruptor de apagado global y por proveedor, por defecto `off` hasta superar la aceptación de la fase 2.

## Diseño

### 1. Orden fijo y determinista del prompt (REQ-CACHE-001 y 002)

**Decisión.** La petición admite una forma por segmentos, compatible con `prompt` para no romper al llamador actual (`prompt` equivale a un único segmento `input` sin prefijo cacheable). El gateway, no el llamador, impone el orden canónico.

**Implementación** (`packages/model-gateway/src/types.ts` y nuevo `prompt-builder.ts`):

```ts
type SegmentKind = 'system' | 'rules' | 'skills' | 'spec'
  | 'project_context' | 'task_context' | 'history' | 'input';
type Stability = 'project' | 'task' | 'volatile'; // derivada del kind (tabla siguiente); el llamador no la envía
interface PromptSegment { kind: SegmentKind; id?: string; version?: string; content: string }
interface ToolDefinition { name: string; description?: string; input_schema: unknown }
// id obligatorio en 'rules' | 'skills' | 'spec'; opcional en el resto (por defecto `${kind}#${posición}`, p. ej. `history#3`).
// version opcional, por defecto "1". Se usan para trazabilidad y los hashes de prefijo; solo ordenan en los kind reordenables.
// ModelGatewayRequest: prompt?: string; segments?: PromptSegment[]  (exactamente uno de los dos); tools?: ToolDefinition[] (solo con segments)
// buildPrompt(segments, tools, tenant): `tenant` es un parámetro obligatorio, no un segmento.
```

**Orden canónico** (el de los bytes enviados): `tools` → `system` → `rules` → `skills` → `spec` → `project_context` → `task_context` → `history` → `input`. Es el orden `tools → system → messages` de Anthropic, que fija dónde puede ir cada breakpoint. `project_context` y `task_context` son opcionales.

**`tenant_namespace`** no es un segmento ni un `kind`: es el HMAC del tenant (punto 6), calculado por el gateway y pasado a `buildPrompt` como parámetro `tenant`. El constructor lo antepone, como primera línea con cabecera fija, al contenido del primer bloque no vacío tras `tools` (normalmente `system`), de modo que es el inicio del texto del prompt y entra en todos los hashes de prefijo. Un `tenant` ausente se rechaza.

**`tools`** no es un segmento: es el campo `tools` de la petición (definiciones de herramientas, p. ej. las de Anthropic). Ocupa la primera posición porque Anthropic cachea en la jerarquía tools → system → messages y cambiar una tool invalida todo lo posterior. Tratamiento: estabilidad `project`; el constructor las ordena por `name` (bytes UTF-8, sin locale) y serializa cada esquema en JSON canónico (claves ordenadas), sin tocar el contenido de las descripciones; `name` duplicado se rechaza. Sin tools, la posición queda vacía. No lleva `tenant_namespace` (son definiciones de la plataforma, idénticas para todos los tenants y sin datos de cliente; una prueba exige que no contengan datos de tenant). No lleva breakpoint propio: el del bloque de proyecto las cubre.

**Estabilidad por `kind` y hashes de prefijo.** La estabilidad la deriva el constructor del `kind`; el llamador no la elige:

| Posición / kind | Estabilidad | Entra en `prefix_project_sha256` | Entra en `prefix_task_sha256` |
| --- | --- | --- | --- |
| `tenant_namespace` (parámetro) | project | sí | sí |
| `tools` (campo) | project | sí | sí |
| `system`, `rules`, `skills`, `spec` | project | sí | sí |
| `project_context` | project | sí | sí |
| `task_context` | task | no | sí |
| `history` | volatile | no | no |
| `input` | volatile | no | no |

`prefix_project_sha256` = SHA-256 de los bytes exactos del bloque `tenant_namespace` + `tools` + `system` + `rules` + `skills` + `spec` + `project_context`. `prefix_task_sha256` = SHA-256 de los bytes del bloque de proyecto seguidos de `task_context` (si no hay `task_context`, ambos coinciden). `history` e `input` no tienen hash: cambian en cada llamada por diseño. Cada hash es su nivel de breakpoint de la caché (punto 2).

El constructor `buildPrompt(segments, tools, tenant)` garantiza el determinismo:

* `content` se conserva literalmente, byte a byte: el constructor no recorta espacios finales ni normaliza saltos de línea (dos espacios al final de una línea en Markdown y CRLF pueden tener significado). La normalización solo se aplica a la estructura que añade el constructor: separadores, cabeceras de segmento y serialización JSON canónica de metadatos y tools, con las claves ordenadas. El determinismo viene de un orden y un ensamblado deterministas, no de reescribir el contenido;
* orden entre `kind`: siempre el canónico, sin cambios;
* orden dentro de un `kind`: solo los conjuntos reordenables (`rules`, `skills` y `spec`) se ordenan por `id` y luego `version`, comparando por bytes UTF-8 y sin depender del locale. `id` es obligatorio en ellos y único dentro de su `kind` (un id duplicado o ausente se rechaza con error). `system`, `project_context`, `task_context`, `history` e `input` conservan el orden en que los envía el llamador. En particular `history` conserva estrictamente la secuencia cronológica y el gateway nunca la reordena: ordenar por bytes alteraría el orden de `msg-2` y `msg-10`;
* `id` y `version` en los `kind` no reordenables: `id` es opcional y, si falta, vale el nombre del `kind` más su posición (`history#3`); `version` es opcional y vale `"1"` por defecto. Se usan solo para trazabilidad y los hashes de prefijo, nunca para ordenar, y no se exige unicidad de `id` en ellos;
* el cambio de versión que justifica un cambio de hash de prefijo se detecta comparando el par `id`@`version` de cada segmento con el de la llamada anterior de la misma tarea;
* prohibición de `Date`, UUID aleatorios, timestamps o IDs de request en segmentos estables: si se detecta un patrón de fecha o UUID en un segmento de estabilidad `project` o `task` o en `tools`, se emite un aviso y se registra (no bloquea, ver punto 7);
* fechas e IDs de la tarea solo en `task_context` o `input`, al final;
* `prefix_project_sha256` y `prefix_task_sha256` (tabla anterior) calculados sobre los bytes exactos enviados y registrados en cada llamada. Si cualquiera cambia dentro de la misma tarea sin un cambio de versión declarado (o sin un cambio de `tools`), se emite una alerta de prefijo inestable.

En Anthropic la caché sigue la jerarquía **tools → system → messages**: cambiar las definiciones de tools invalida toda la caché; por eso `tools` va primero y ordenado por nombre con esquemas canónicos (ver arriba).

**Pruebas.** Orden y determinismo byte a byte (mismo contenido, distinto orden de entrada → mismos bytes); detección de fecha/UUID en segmentos estables y en `tools`; alerta al cambiar `prefix_project_sha256` o `prefix_task_sha256` dentro de una tarea; `tools` en orden por `name` y JSON canónico, `name` duplicado rechazado, mismas tools en distinto orden de entrada → mismos bytes; tabla kind → estabilidad → hash (qué segmentos entran en cada hash, `history` e `input` en ninguno); `tenant_namespace` como parámetro (ausente → rechazo, no aparece como segmento) y primer texto del prompt; compatibilidad de `prompt` con el llamador actual; orden de `rules`, `skills` y `spec` por `id` y `version` en bytes UTF-8 independiente del locale (mismo contenido, distinto orden de entrada → mismos bytes solo en estos conjuntos); varios mensajes de `history` con ids no cronológicos (`msg-10` antes que `msg-2`) que se conservan en el orden enviado, igual que `system`, `project_context`, `task_context` e `input`; `id` por defecto `history#3` y `version` `"1"` en los `kind` no reordenables, sin influir en el orden; rechazo de `id` duplicado dentro de un `kind` reordenable y de `id` ausente en `rules`, `skills` y `spec`; detección de cambio de versión por el par `id`@`version`; `content` con espacios finales significativos y CRLF que se conserva literalmente y prefijo idéntico byte a byte entre dos ejecuciones.

### 2. Todos los proveedores

**Capacidad declarada por adaptador** (REQ-CACHE-003), en `ProviderAdapter`:

```ts
cacheSupport: {
  mode: 'explicit' | 'automatic' | 'none';
  ttls: string[];            // p. ej. ['5m','1h'], ['30m','12h'], []
  minPrefixTokens: (model: string) => number | undefined;
  billsWrite: boolean;
}
```

**Anthropic** (adaptador nuevo sobre la Messages API; `adapters.ts` o `adapter-anthropic.ts`):

* `cache_control` explícito: `{ type: 'ephemeral' }` y `ttl` según el punto 5.
* **Un único modo: breakpoints explícitos por bloque.** El adaptador nunca usa el `cache_control` automático de nivel superior de la petición. Máximo 4 breakpoints; se usan hasta 3: (1) al final del bloque de proyecto (último bloque de `system`, que cubre `tools`, `tenant_namespace`, reglas, skills, spec y `project_context`), TTL de proyecto; (2) al final de `task_context`, TTL de tarea (se omite si no hay `task_context`); (3) en el último bloque del último mensaje del historial, TTL de tarea. El cuarto queda libre. Los de 1 h van siempre antes que los de 5 min, como exige la documentación («cache entries with longer TTL must appear before shorter TTLs»).
* Lookback de 20 bloques: la documentación indica que si un historial crece 20 o más bloques por encima de la última escritura, la lectura no acierta; el breakpoint de `task_context` cubre ese caso.
* Mínimo cacheable por modelo (tabla de la documentación): 512 tokens para Claude Opus 5.5, Sonnet 5.5 y Haiku 5.5 (y otros 5.x); 1.024 para Sonnet 5, Sonnet 4.6/4.5 y Opus 4.8; 2.048 para Opus 4.7; 4.096 para Opus 4.6/4.5 y Haiku 4.5. Por debajo del mínimo la API no devuelve error: simplemente no cachea y ambos contadores (`cache_creation_input_tokens` y `cache_read_input_tokens`) llegan a 0.
* **`BELOW_MINIMUM` se determina después de la respuesta**: con la caché activa y breakpoints enviados, si ambos contadores son 0 y `totalInputTokens` es menor que el mínimo del modelo, el estado es `BELOW_MINIMUM`; si es igual o mayor, es `MISS` con `cache_reason` explicativo. Antes de llamar solo puede haber una estimación del tamaño del prefijo, meramente orientativa (para un aviso en el registro): nunca decide ni bloquea, y se envía el `cache_control` igualmente.
* Motivo de usar solo breakpoints explícitos: la documentación indica que un `cache_control` automático de nivel superior con un TTL distinto del de un `cache_control` explícito en el último bloque devuelve 400. Al no usar nunca el automático, esa combinación no puede darse.

**OpenAI** (Responses API):

* Caché automática. Se registra `usage.input_tokens_details.cached_tokens` y `cache_write_tokens` (con `cache_write_tokens_details.ttl_30m_tokens` y `ttl_12h_tokens`) cuando el modelo los informe (GPT-5.6 y posteriores).
* En GPT-5.6+ se usan breakpoints explícitos: `prompt_cache_options: { mode: 'explicit', ttl }` y `prompt_cache_breakpoint: { mode: 'explicit' }` en un bloque `input_text` de un mensaje `developer` (las `instructions` de nivel superior no admiten breakpoint). Máximo 4 escrituras por petición; mínimo de 1.024 tokens.
* `prompt_cache_key` = el hash del tenant (punto 6). La documentación indica que en GPT-5.6+ es opcional y sirve para separar la contabilidad por cliente; en modelos anteriores ayuda al enrutado.
* **Ojo:** en OpenAI `input_tokens` INCLUYE los tokens cacheados y los escritos. Tokens ordinarios = `input − cached − cache_write` (fórmula de la propia documentación).

**DeepSeek** (`chat/completions`):

* Caché automática sin parámetros. Se registra `usage.prompt_cache_hit_tokens` como lectura y `prompt_cache_miss_tokens` como entrada ordinaria.
* No hay escritura facturada aparte ni control de TTL (la documentación indica que se limpia «en horas o días» y que es de mejor esfuerzo). Un acierto requiere que el prefijo ya esté persistido, así que el primer par de llamadas idénticas puede no acertar.

**Modelo de uso normalizado común** (sustituye a `NormalizedUsage`; los campos nuevos se rellenan a 0 cuando no aplican):

```ts
{ inputTokens, outputTokens, cacheWriteTokens, cacheWrite5mTokens,
  cacheWrite1hTokens, cacheReadTokens, totalInputTokens,
  cacheWrite30mTokens, cacheWrite12hTokens }  // los dos últimos: solo OpenAI 5.6+
```

`inputTokens` es siempre la entrada **ordinaria** (a tarifa de entrada) y `totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens`. Para los TTL de OpenAI se añaden `cacheWrite30mTokens` y `cacheWrite12hTokens` (0 en el resto de proveedores); `cacheWriteTokens` es siempre la suma de las escrituras por TTL del proveedor.

| Campo normalizado | Anthropic | OpenAI (5.6+) | DeepSeek |
| --- | --- | --- | --- |
| `inputTokens` (ordinario) | `input_tokens` | `input_tokens − cached_tokens − cache_write_tokens` | `prompt_cache_miss_tokens` |
| `cacheReadTokens` | `cache_read_input_tokens` | `input_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` |
| `cacheWriteTokens` | `cache_creation_input_tokens` | `input_tokens_details.cache_write_tokens` | 0 (no facturada aparte) |
| `cacheWrite5mTokens` / `1h` | `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` | — | — |
| `cacheWrite30mTokens` / `12h` | — | `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens` | — |
| `outputTokens` | `output_tokens` | `output_tokens` | `completion_tokens` |
| `totalInputTokens` | `input + read + creation` (fórmula de la documentación) | `input_tokens` | `hit + miss` |

En OpenAI anterior a 5.6 (p. ej. `gpt-4.1`) solo llega `cached_tokens`; `cache_write_tokens` se toma como 0. Una respuesta cuyos campos de caché sean inconsistentes (p. ej. `cached + write > input_tokens`) se rechaza como `PROVIDER_RESPONSE_INVALID`, igual que hoy con un `usage` inválido.

**Pruebas.** Mapeo de usage de los 3 proveedores con respuestas simuladas con la forma real de cada uno; fórmula de ordinarios de OpenAI; breakpoints de Anthropic (máximo 4, 1 h antes que 5 min, mínimo por modelo, `BELOW_MINIMUM`); `cacheSupport` declarado por adaptador.

### 3. Precios con escritura y lectura de caché (criterio 7 corregido)

**Decisión.** `JEV_MODEL_PRICING_JSON` se amplía (clave `provider:model` o `provider:*`, como hoy) con campos opcionales:

* `cacheReadPerMillionChf`;
* `cacheWrite5mPerMillionChf` y `cacheWrite1hPerMillionChf` (Anthropic);
* `cacheWrite30mPerMillionChf` y `cacheWrite12hPerMillionChf` (OpenAI 5.6+);
* `cacheWriteBilledAs: 'input'` para los modelos sin cargo de escritura aparte, declarado de forma explícita (nunca se asume). Aplica a **DeepSeek** (siempre: no hay escritura facturada aparte) y a los modelos de **OpenAI anteriores a 5.6** que solo informan `cached_tokens` y no publican tarifa de escritura. No aplica a Anthropic ni a OpenAI 5.6+, donde la escritura tiene tarifa propia y es obligatoria.

**Unidades y tipo de cambio.** Todas las tarifas de `JEV_MODEL_PRICING_JSON` están en **CHF por millón de tokens**; el gateway no convierte monedas ni lee ninguna variable de tipo de cambio. El USD de las tablas de este documento es **solo referencia** (los proveedores publican en USD). Para convertir se usa el tipo de cambio de referencia anotado aquí: **1 USD = 0,8402 CHF** (BCE, 2026-11-17: EUR/USD 1,0989 y EUR/CHF 0,9233; consultado el 2026-11-18). Es una nota con fecha, no una variable: el operador la actualiza en este documento y, al configurar el JSON, anota en su registro de despliegue el tipo y la fecha usados. Los topes en CHF (fase 2) se comparan con las tarifas ya en CHF.

`validRate` en `pricing.ts` acepta los campos nuevos con las mismas cotas (finitos, no negativos, tope CHF 1.000.000 por millón y por categoría).

**Validación antes de la llamada.** Según el proveedor, el modelo y la configuración de caché efectiva (punto 9), el gateway calcula las tarifas aplicables y, si falta alguna, la llamada queda `BLOCKED` con `PRICING_REQUIRED`, como hoy y antes de cualquier fetch:

* Anthropic con caché activa: escritura del TTL usado (`5m` y/o `1h`) y lectura.
* OpenAI y DeepSeek: **lectura siempre**, porque cachean de forma automática aunque JEV desactive la caché. Además, escritura del TTL usado en OpenAI 5.6+ si se piden breakpoints.
* Anthropic con caché desactivada: solo entrada y salida.

`NOT_ESTIMABLE` queda solo para respuestas inesperadas ya recibidas (p. ej. un campo de uso de caché sin precio previsto): se registra con motivo y se emite una alerta; nunca se sustituye por el precio de entrada (REQ-CACHE-007).

**DeepSeek, horas valle y punta.** Sus precios varían: la tarifa valle es la mitad de la punta (punta: 01:00–04:00 y 06:00–10:00 UTC, de lunes a viernes salvo festivos públicos chinos). Para estimar se usa la tarifa **punta** (conservadora); la estimación puede sobrestimar el coste real de las llamadas en valle. Queda documentado así.

**Precios de referencia (USD por millón de tokens, de la documentación del 2026-11-17).** Solo como referencia para el diseño y los ejemplos; los precios en CHF los configura el operador y el repositorio no inventa precios.

| Modelo | Entrada | Escritura 5 m | Escritura 1 h | Lectura | Salida | Fuente |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Sonnet 5.5 | 2 | 2,50 | 4 | 0,10 | 10 | Anthropic pricing |
| Claude Opus 5.5 | 4 | 5 | 8 | 0,20 | 20 | Anthropic pricing |
| Claude Haiku 5.5 (prompt ≤ 100.000 tokens) | 0,10 | 0,125 | 0,20 | 0,01 | 0,50 | Anthropic pricing |
| Claude Haiku 5.5 (prompt > 100.000 tokens) | 0,50 | 0,625 | 1 | 0,05 | 2,50 | Anthropic pricing |

| Modelo | Entrada | Escritura 30 m | Escritura 12 h | Lectura | Salida | Fuente |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-sol (Standard) | 2 | 2,50 | 5 | 0,10 | 10 | OpenAI pricing |
| gpt-6.1-sol (Standard) | 2 | 2,50 | 5 | 0,10 | 10 | OpenAI pricing |
| gpt-6.1-terra (Standard, contexto corto) — modelo elegido para la aceptación (DECIDIDA 2026-11-18) | 1 | 1,25 | 2,50 | 0,05 | 5 | OpenAI pricing (consultada con `curl` a `https://developers.openai.com/api/docs/pricing.md` el 2026-11-18) |

| Modelo (DeepSeek) | Lectura (hit) | Entrada (miss) | Salida |
| --- | --- | --- | --- |
| deepseek-flash, valle | 0,003 | 0,15 | 0,60 |
| deepseek-flash, punta | 0,006 | 0,30 | 1,20 |

Notas sobre la tabla:

* Haiku 5.5 tiene precio por longitud de prompt: un prompt de más de 100.000 tokens (incluidas lecturas y escrituras de caché) paga la segunda tarifa. **DECIDIDA 2026-11-18:** se configura solo la tarifa del tramo ≤ 100.000 tokens y el gateway rechaza (`BLOCKED`, motivo `PROMPT_TOO_LARGE_FOR_TIER`, antes de llamar) los prompts mayores con ese modelo, con una estimación previa conservadora del tamaño; el catálogo no se amplía con tramos. Si tras la respuesta `totalInputTokens` supera 100.000, el coste queda `NOT_ESTIMABLE` con motivo y alerta (la estimación previa falló). Sonnet 5.5 es el modelo de Anthropic por defecto (DECIDIDA 2026-11-18).
* Las lecturas valen 0,05× la entrada en Sonnet 5.5, Opus 5.5 (Anthropic) y `gpt-6.2-sol`, `gpt-6.1-sol` y `gpt-6.1-terra` (OpenAI); en Haiku 5.5, `gpt-6-luna` y otros modelos usan 0,1×. Las escrituras valen 1,25× (5 min) y 2× (1 h) la entrada en Anthropic, y 1,25× (30 min) y 2,5× (12 h) en OpenAI 5.6+. Estos precios aplican a la tarifa estándar; los modificadores (Batch, `inference_geo: us` ×1,1, fast mode) quedan fuera de alcance.
* **`gpt-4.1-nano` queda descartado (DECIDIDA 2026-11-18).** No se encontró su fila ni su precio de caché en la página de precios (aunque PLT-009 lo usó en su aceptación). Para la aceptación de PLT-052 se usa **`gpt-6.1-terra`** (DECIDIDA 2026-11-18), modelo intermedio de la línea 6.x, ni caro ni de gama mínima. Su tarifa Standard de contexto corto está publicada en la fuente oficial citada (consulta del 2026-11-18): entrada $1,00, salida $5,00, entrada cacheada $0,05, escritura 30 m $1,25 y escritura 12 h $2,50 por millón. Motivo: la prueba solo necesita los contadores de caché y el coste adicional frente a `gpt-6-luna` es de fracciones de céntimo. Hay que volver a consultar el precio oficial antes de implementar, y la prueba pagada se autoriza aparte. Como en Haiku 5.5, la página publica además una tarifa de contexto largo (entrada $2,00, cacheada $0,10); se configura la de contexto corto y la aceptación usa prefijos de ~1.100 tokens. Alternativa descartada: `gpt-6-luna` (entrada $0,10, salida $0,50, cacheada $0,01, escritura 30 m $0,125).

**Pruebas.** Falta de cada tarifa aplicable → `BLOCKED` con `PRICING_REQUIRED` y sin fetch; OpenAI/DeepSeek bloquean sin tarifa de lectura incluso con la caché desactivada; Anthropic con caché desactivada no exige tarifas de caché; `NOT_ESTIMABLE` solo tras la respuesta, con motivo y alerta; `cacheWriteBilledAs` explícito; cotas de `validRate`.

### 4. Medición y ahorro (REQ-CACHE-004 y 005)

**Migración nueva** (siguiente número libre, hoy `0029`; se describe, el SQL definitivo se escribe en la implementación):

* Amplía el `CHECK` de `provider` de `provider_credentials` y `model_provider_calls` con `anthropic`.
* Columnas nuevas en `model_provider_calls`: `cache_read_tokens`, `cache_write_tokens`, `cache_write_5m_tokens`, `cache_write_1h_tokens` (enteros no negativos, por defecto 0; los tokens 30 m/12 h de OpenAI van en `usage`); `cache_status` con `CHECK` en `HIT | PARTIAL | MISS | WRITE | DISABLED | BELOW_MINIMUM | ERROR | UNSUPPORTED`; `cache_reason`; **una columna por nivel de hash**, `prefix_project_sha256` y `prefix_task_sha256` (texto hexadecimal de 64 caracteres, nulos permitidos: un fallo de medición no bloquea; `prefix_task_sha256` es igual al de proyecto si no hay `task_context`); no existe una columna `prefix_sha256` única; `estimated_cost_without_cache_chf` y `estimated_cache_savings_chf` (`NUMERIC(14,6)`, esta última puede ser negativa en una escritura).
* `cost_events.usage` incluye los campos nuevos del modelo de uso normalizado (es JSONB: no requiere columnas).
* Grants: `jev_runtime` solo recibe `INSERT` hoy; los `GRANT` de `provision-runtime-role.sql` se ajustan para que las nuevas columnas queden cubiertas por el `INSERT` y, si el worker o la API leen las vistas, un `SELECT` limitado a las vistas (no a las tablas completas).

**Vistas o consultas por tarea, proyecto y proveedor/modelo**, siempre con `organization_id` como primera columna de agrupación y de filtro:

* tokens totales;
* tasa de acierto = `cacheRead / (cacheRead + cacheWrite + inputOrdinario)`;
* coste real (`estimated_cost_chf`);
* coste sin caché (`estimated_cost_without_cache_chf`);
* ahorro en CHF (`estimated_cache_savings_chf`) y en %.

**Aislamiento.** No hay RLS en este esquema; las consultas reciben el `organization_id` del actor autorizado y lo exigen en el `WHERE`. Una prueba con dos organizaciones debe demostrar que ninguna ve filas de la otra.

**Cálculo.** El coste sin caché valora todos los tokens de entrada (`totalInputTokens`) a la tarifa de entrada; el ahorro es la diferencia con el coste real, de modo que una llamada de escritura puede tener ahorro negativo (la escritura se amortiza con las lecturas posteriores).

**Ejemplo numérico** (Sonnet 5.5, precios de referencia en USD; en CHF se aplica la misma fórmula con las tarifas configuradas). Prefijo de 20.000 tokens, 1.500 tokens de entrada ordinaria, 800 de salida:

| Caso | Cálculo | Coste |
| --- | --- | --- |
| Sin caché | (21.500 × 2 + 800 × 10) / 1e6 | $0,051 |
| Escritura 5 min | (20.000 × 2,50 + 1.500 × 2 + 800 × 10) / 1e6 | $0,061 (ahorro −$0,010) |
| Lectura | (20.000 × 0,10 + 1.500 × 2 + 800 × 10) / 1e6 | $0,013 (ahorro $0,038, 74,5 %) |

Tasa de acierto de la lectura: 20.000 / (20.000 + 0 + 1.500) = 93,0 %.

**Pruebas.** Cálculo de ahorro (positivo en lectura, negativo en escritura); tasa de acierto; migración y grants con PostgreSQL real, como los tests actuales (`runtime-role.test.ts`); aislamiento entre organizaciones en las vistas; `cost_events.usage` con campos nuevos.

### 5. TTL: 5 minutos frente a 1 hora, con estimación de coste

Precios oficiales de Sonnet 5.5: entrada $2, escritura 5 min $2,50, escritura 1 h $4, lectura $0,10 por MTok. Prefijo estable supuesto de 20.000 tokens (system + reglas + skills + spec). Coste del prefijo por llamada: sin caché $0,040; escritura 5 min $0,050; escritura 1 h $0,080; lectura $0,002.

**Escenario A (dentro de una tarea):** 20 turnos con menos de 5 min entre ellos; cada acierto renueva la caché sin coste.

| Opción | Cálculo | Coste |
| --- | --- | --- |
| Sin caché | 20 × 0,04 | $0,800 |
| 5 min | 0,05 + 19 × 0,002 | $0,088 (−89 %) |
| 1 h | 0,08 + 19 × 0,002 | $0,118 (−85,3 %) |

Gana 5 min (por $0,030).

**Escenario B (entre tareas del mismo proyecto):** 6 tareas por hora, unos 10 min de separación; solo se cuenta la primera llamada de cada tarea.

| Opción | Cálculo | Coste |
| --- | --- | --- |
| Sin caché | 6 × 0,04 | $0,240 |
| 5 min | 6 escrituras: 6 × 0,05 | $0,300 |
| 1 h | 1 escritura + 5 lecturas: 0,08 + 5 × 0,002 | $0,090 |

Gana 1 h. Dato relevante que no estaba en el planteamiento: con 10 min de separación la caché de 5 min **cuesta más que no usar caché** ($0,30 frente a $0,24), porque cada primera llamada reescribe con recargo y nunca lee. Además, en régimen continuo la caché de 1 h se renueva con cada lectura, así que los $0,09 son el coste de la primera hora y las siguientes cuestan 6 × 0,002 = $0,012.

**Escenario híbrido (1 h proyecto + 5 min tarea/historial), mismos supuestos que A y B más uno nuevo.** El bloque de proyecto es el prefijo de 20.000 tokens de A y B. Nuevo supuesto: `task_context` y el historial estable suman 4.000 tokens, constantes (simplificación). Precios por llamada de ese tramo: sin caché $0,008; escritura 5 min $0,010; escritura 1 h $0,016; lectura $0,0004. Se comparan las cuatro opciones sobre los mismos 24.000 tokens estables:

| Escenario | Sin caché | Todo 5 min | Todo 1 h | **Híbrido** (proyecto 1 h + tarea 5 min) |
| --- | --- | --- | --- | --- |
| A (20 turnos en una tarea) | 20 × 0,048 = $0,960 | (0,050 + 19 × 0,002) + (0,010 + 19 × 0,0004) = $0,1056 | (0,080 + 19 × 0,002) + (0,016 + 19 × 0,0004) = $0,1416 | (0,080 + 19 × 0,002) + (0,010 + 19 × 0,0004) = **$0,1356** (−85,9 %) |
| B (6 tareas en 1 h, primera llamada de cada una) | 6 × 0,048 = $0,288 | 6 × (0,050 + 0,010) = $0,360 | (0,080 + 5 × 0,002) + 6 × 0,016 = $0,186 | (0,080 + 5 × 0,002) + 6 × 0,010 = **$0,150** (−47,9 %) |

En A el híbrido cuesta $0,030 más que usar 5 min en todo (el recargo de 1 h del bloque de proyecto) y $0,006 menos que 1 h en todo; en B es la mejor opción: $0,036 menos que 1 h en todo y $0,210 menos que 5 min en todo, que vuelve a costar más que no cachear. En B el contexto de tarea se reescribe en cada tarea (no se reutiliza entre tareas) y solo se cuenta la primera llamada, por lo que el recargo no llega a amortizarse; en la práctica las llamadas posteriores de la tarea lo leen (como en A).

**Umbral (corregido).** Con las cifras de Sonnet 5.5 la escritura de 1 h cuesta **0,75×** la entrada más que la de 5 min (2× − 1,25×; en el ejemplo: 0,080 − 0,050 = 0,030 = 0,75 × 0,040), no 0,6×. Cada reescritura de 5 min evitada ahorra **1,20×** la entrada (1,25× − 0,05×; en el ejemplo: 0,048 = 1,2 × 0,040), no 1,15×: el 1,15× corresponde a modelos con lectura al 0,1×, no a Sonnet 5.5 ni Opus 5.5 (0,05×). Por tanto la 1 h compensa si, de media, hay al menos 0,75 / 1,20 = **0,625** reutilizaciones por escritura que ocurren después de 5 min y antes de 60 sin aciertos intermedios; «al menos una» es una condición suficiente y algo conservadora. Para comparar con no usar caché, la documentación indica que 1 h ya ahorra tras dos lecturas y 5 min tras una.

**Decisión recomendada (híbrida):**

* **1 h** para el bloque estable de proyecto (system + reglas + skills + spec);
* **5 min** para `task_context` y el historial.

La documentación lo permite porque los breakpoints de 1 h van antes que los de 5 min.

* Configurable por variable: `JEV_PROMPT_CACHE_PROJECT_TTL` (`1h` por defecto) y `JEV_PROMPT_CACHE_TASK_TTL` (`5m`).
* Se revisa con la tasa de acierto real medida tras las primeras ejecuciones (punto 4).
* **La frecuencia real de las llamadas en JEV todavía no existe**, porque aún no hay agentes que las generen. Los escenarios A y B son supuestos y se medirán; la decisión es provisional.
* OpenAI 5.6+: 30 min por defecto. 12 h (escritura 2,5×) no se usa salvo que se justifique con mediciones, comparando su recargo con el coste de reescribir al caducar los 30 min.
* DeepSeek: sin control de TTL.

**Pruebas.** Un test de aritmética que reproduce los escenarios A y B, el escenario híbrido (las cifras de la tabla anterior, con los 4.000 tokens de tarea/historial) y el umbral con los precios de referencia; selección de TTL por variable; orden 1 h antes que 5 min.

### 6. Aislamiento entre organizaciones y clientes

* Anthropic y OpenAI aíslan la caché por organización del proveedor (Anthropic, además, por workspace en la Claude API). Para DeepSeek **no se encontró documentación del aislamiento** en las páginas consultadas.
* En JEV las credenciales son por organización. Pero si varias organizaciones de JEV usaran la misma cuenta de proveedor, la caché del proveedor sería compartida entre ellas, con riesgo de canal lateral por tiempos.

Medidas:

* Un `tenant_namespace`, estable por organización+proyecto: un HMAC-SHA256 con un secreto de JEV (nunca el ID en claro; el secreto sale de la configuración externa, como `JEV_SECRET_ENCRYPTION_KEY`, sin reutilizarla). No es un segmento: es el parámetro `tenant` de `buildPrompt` (punto 1), que el constructor antepone como primer texto del prompt tras las `tools` (que son iguales para todos y sin datos de cliente). Así los prefijos de distintos tenants nunca coinciden a partir de ahí. Es estable, de modo que no rompe la caché.
* `prompt_cache_key` de OpenAI = el mismo hash.
* Prohibido reutilizar un prefijo entre organizaciones: el constructor no admite un `tenant` ausente.
* Recomendación al operador: una credencial o workspace de Anthropic por cliente cuando sea posible.
* DeepSeek: aislamiento no documentado; el `tenant_namespace` lo mitiga, pero no se puede demostrar. **RIESGO ACEPTADO (DECIDIDA 2026-11-18):** el aislamiento en DeepSeek depende solo del `tenant_namespace`; DeepSeek no tiene `prompt_cache_key` y no se añade ninguna otra medida.

**Pruebas.** Dos organizaciones con contenido idéntico producen `tenant_namespace`, prefijos y `prefix_project_sha256` / `prefix_task_sha256` distintos; el mismo tenant produce siempre el mismo; el ID de la organización no aparece en claro en el prefijo; `prompt_cache_key` igual al hash.

### 7. Fallo seguro (REQ-CACHE-006)

* Si el proveedor rechaza la marca de caché (p. ej. un 400 por breakpoints o TTL), se reintenta **una vez sin caché** dentro del mismo intento lógico, respetando el tope de intentos (8 por cadena de fallback) y el circuit breaker existentes. El reintento sin caché cuenta en el presupuesto de intentos.
* Se registra `cache_status=ERROR` y `cache_reason`.
* Nunca se bloquea el trabajo por la caché. La única excepción son los precios ausentes del punto 3, que son una política de gasto y no un fallo de caché.
* Una caché por debajo del mínimo (`BELOW_MINIMUM`), o sin acierto (`MISS`), no es un error.
* Si el constructor de prompt detecta inestabilidad, avisa pero no bloquea.
* Un fallo de la medición (p. ej. no poder calcular `prefix_project_sha256`) tampoco bloquea la llamada.

**Pruebas.** 400 por caché → reintento sin caché y éxito, con `cache_status=ERROR`; un 400 ajeno a la caché no se reintenta como tal; el reintento respeta el tope de intentos y el circuit breaker; `BELOW_MINIMUM` y `MISS` no son errores; inestabilidad detectada → aviso sin bloqueo.

### 8. Pruebas

**Fase 1 (sin gasto)**, con proveedores simulados en `ProviderRegistry` que devuelven el usage real de cada proveedor (como los tests actuales de `model-gateway.test.ts`):

* orden canónico por `kind`; `rules`, `skills` y `spec` ordenados por `id` y `versión` (bytes UTF-8); `history` con `msg-10` antes que `msg-2` conservado en el orden enviado; ids y versión por defecto en `kind` no reordenables; determinismo byte a byte; rechazo de ids duplicados o ausentes en los reordenables; `content` literal (espacios finales y CRLF);
* prohibición de fechas o IDs en segmentos estables;
* mapeo de usage de los 3 proveedores;
* precios ausentes → `BLOCKED`;
* `NOT_ESTIMABLE` solo tras la respuesta;
* cálculo de ahorro;
* aislamiento (prefijos distintos entre organizaciones);
* breakpoints de Anthropic (máximo 4, 1 h antes que 5 min, mínimo por modelo);
* fallo seguro (400 → reintento sin caché);
* interruptor de apagado;
* migración y grants con PostgreSQL real, como los tests actuales.

**Fase 2 (aceptación pagada mínima)**, autorizada aparte por el operador con un tope (R4):

* Extender el harness `accept:gateway` con un modo de 2 llamadas por proveedor: escritura y luego lectura, con el mismo prefijo sintético (sin datos reales) de tamaño mínimo para el modelo, `maxOutputTokens` 16, `maxRetries` 0 y un tope de gasto estimado comprobado antes de llamar.
* La variable de autorización explícita es distinta de la actual (`JEV_LIVE_PROVIDER_ACCEPTANCE=I_AUTHORIZE_ONE_PAID_CALL`, una llamada): p. ej. `JEV_LIVE_CACHE_ACCEPTANCE=I_AUTHORIZE_CACHE_PAID_CALLS` junto con `JEV_LIVE_CACHE_MAX_CHF=<tope>`; el harness se niega a llamar si la estimación supera el tope.
* **Coste estimado** con modelos baratos (estimación con los precios de referencia en USD, no una factura): prefijos y salidas pequeños, 2 llamadas por proveedor.

| Proveedor/modelo | Supuestos | Estimación |
| --- | --- | --- |
| Haiku 5.5 | prefijo ≈ 600 tokens (mínimo 512), 50 de entrada, 16 de salida; escritura 5 min + lectura | ≈ $0,0001 |
| deepseek-flash (tarifa punta) | prefijo ≈ 650 tokens, 16 de salida; 2 llamadas más una tercera por si el acierto tarda | ≈ $0,0003 |
| OpenAI (`gpt-6.1-terra`, DECIDIDA 2026-11-18) | prefijo ≈ 1.100 tokens (mínimo 1.024), 50 de entrada, 16 de salida; escritura 30 min + lectura | ≈ $0,0017 |
| **Total** | | **≈ $0,002** |

**OpenAI entra en la prueba solo si el modelo elegido tiene configuradas sus tarifas de caché** (lectura y, en 5.6+, escritura del TTL usado). Sin ellas no se estima, no se puede validar el tope y OpenAI se excluye de la fase 2 (y la llamada ya quedaría `BLOCKED` con `PRICING_REQUIRED`); no se sustituye por la tarifa de entrada.

* Se propone un tope total de **CHF 0,10** que el operador autorizará: unas 50 veces la estimación (≈ $0,002 son ≈ CHF 0,002 al tipo de referencia del punto 3), para absorber errores de recuento de tokens o un modelo de OpenAI más caro sin permitir un gasto relevante. El tope se compara con la estimación calculada con los precios en CHF configurados.
* Aceptación de cada proveedor: la segunda llamada debe registrar `cacheReadTokens > 0` (Anthropic, OpenAI) con el coste y el ahorro coherentes. En DeepSeek la caché es de mejor esfuerzo y tarda segundos en construirse: si no hay acierto, se registra `MISS` y se reintenta una vez tras una pausa dentro del tope, sin considerarlo un fallo del gateway.

### 9. Desactivable

* `JEV_PROMPT_CACHE=on|off` global, **por defecto `off`**. Con `off` ningún adaptador marca caché, de modo que registrar `anthropic` no puede causar llamadas con `cache_control` hasta que el operador lo active tras la aceptación de la fase 2 (cambiar el valor por defecto a `on` sería una decisión posterior).
* `JEV_PROMPT_CACHE_PROVIDERS` para una lista por proveedor (p. ej. `anthropic,openai`).
* Futuro: ajuste por organización.
* Con `off`:
  * Anthropic no recibe `cache_control` (no hay caché automática en Anthropic: sin marca no se cachea);
  * OpenAI 5.6+ usa `prompt_cache_options.mode: 'explicit'` sin ningún breakpoint, que según la documentación no usa la caché ni crea escrituras;
  * en OpenAI anterior a 5.6 y en DeepSeek la caché automática **no se puede apagar** (no se encontró ningún parámetro para ello). Se sigue registrando el uso de caché y se dice así de claro en el registro y en el estado.
* El estado se registra en cada llamada (`cache_status=DISABLED`); en los proveedores donde no se puede apagar, el motivo (`cache_reason`) indica que la caché automática sigue activa. Por eso la validación de precios exige siempre la tarifa de lectura en OpenAI y DeepSeek (punto 3).

**Pruebas.** `off` global: ningún `cache_control` ni breakpoint en la petición; lista por proveedor; `cache_status=DISABLED` registrado; OpenAI/DeepSeek siguen registrando lecturas con `off`.

## Riesgos y preguntas abiertas para el operador

Decisiones tomadas por el operador el 2026-11-18 (previas a la aprobación del diseño, también del 2026-11-18):

1. **`gpt-4.1-nano` descartado — DECIDIDA 2026-11-18.** Se usa otro modelo de OpenAI ni caro ni malo, con precio de caché publicado. **Modelo de OpenAI para las pruebas de caché: `gpt-6.1-terra` — DECIDIDA 2026-11-18** (tarifa en `https://developers.openai.com/api/docs/pricing.md`, consulta del 2026-11-18). `gpt-6-luna` queda como alternativa descartada: la prueba solo necesita los contadores de caché y el coste adicional es de fracciones de céntimo. Pendientes: volver a consultar el precio oficial antes de implementar; la prueba pagada se autoriza aparte.
2. **DeepSeek sin aislamiento de caché documentado y sin `prompt_cache_key` — DECIDIDA 2026-11-18: riesgo aceptado.** El aislamiento depende solo del `tenant_namespace`.
3. **Modelo de Anthropic por defecto — DECIDIDA 2026-11-18:** Sonnet 5.5 por defecto; Haiku 5.5 con la tarifa del tramo ≤ 100.000 tokens de prompt y rechazo (`BLOCKED`) de prompts mayores con ese modelo; sin ampliar el catálogo.

Preguntas que siguen **abiertas** (sin decidir):

4. **Frecuencia real de llamadas desconocida** (aún no hay agentes): los escenarios de TTL (A, B e híbrido) son supuestos y la decisión híbrida es provisional hasta medir.
5. **Impacto en PLT-017** (guard de presupuesto): el guard deberá usar la estimación con la tarifa de caché; una escritura cuesta más que la entrada. Se recomienda que el guard reciba el coste estimado máximo previo a la llamada (peor caso: todo escrito a la tarifa de 1 h).
6. **Secreto del `tenant_namespace`:** ¿variable nueva (`JEV_TENANT_NAMESPACE_SECRET`) o derivación de la clave existente? Se propone una variable nueva, sin reutilizar la de cifrado de credenciales.
7. **Estimación con tarifa punta de DeepSeek:** sobrestima en horas valle; ¿se acepta?

## Plan de implementación por fases

Una PR pequeña por fase (6 en total), cada una con sus pruebas y autorización previa del operador (R3). **Ninguna PR intermedia puede romper una llamada ni habilitar `anthropic` sin la migración:** la migración (`CHECK` de `provider`, columnas), el interruptor `JEV_PROMPT_CACHE` (por defecto `off`) y el reintento sin caché llegan antes que el adaptador de Anthropic, y `anthropic` solo entra en `MODEL_PROVIDERS` en la PR que añade el adaptador.

1. **Tipos y constructor:** `PromptSegment` (`id` obligatorio en `rules`, `skills` y `spec`, y por defecto `kind#posición` en el resto; `version` por defecto `"1"`), `buildPrompt(segments, tools, tenant)` (orden canónico por `kind`; `id` y `version` solo ordenan `rules`, `skills` y `spec`; el resto, incluido `history`, conserva el orden del llamador; `content` literal), `tools` (orden por `name`, JSON canónico), tabla kind → estabilidad, `prefix_project_sha256` y `prefix_task_sha256`, el parámetro `tenant` (`tenant_namespace`) y detección de inestabilidad. Sin cambios de proveedor ni de BD; `prompt` sigue funcionando.
2. **Usage, precios y migración:** modelo de uso normalizado, mapeo de OpenAI y DeepSeek, precios de caché y validación previa, migración `0029` (ampliación del `CHECK` de `provider` con `anthropic`, columnas de caché con un hash por nivel) y grants. `anthropic` **aún no** se añade a `MODEL_PROVIDERS`: la migración se despliega antes que cualquier código que pueda usarlo. Cambio de comportamiento documentado: OpenAI y DeepSeek exigen ya tarifa de lectura (una llamada sin ella queda `BLOCKED` con `PRICING_REQUIRED`, como política de gasto); el único llamador es el harness de desarrollo y su configuración de ejemplo se actualiza en la misma PR.
3. **Interruptor de apagado y fallo seguro:** `JEV_PROMPT_CACHE` (por defecto `off`), lista por proveedor, `cache_status` `DISABLED` y `ERROR`, y reintento una vez sin caché respetando el tope de intentos y el circuit breaker. Se prueba con proveedores simulados; no hay aún `cache_control` que enviar.
4. **Adaptador de Anthropic:** `anthropic` en `MODEL_PROVIDERS` (la migración de la PR 2 ya está), adaptador Messages API con breakpoints explícitos por bloque y TTL, `cacheSupport`, mínimos por modelo, `BELOW_MINIMUM` tras la respuesta y rechazo `PROMPT_TOO_LARGE_FOR_TIER` en Haiku 5.5. Solo envía `cache_control` con el interruptor en `on`; con `off` funciona sin caché. Una prueba falla si `MODEL_PROVIDERS` contiene un proveedor que el `CHECK` de la migración no admite.
5. **Métricas y vistas:** ahorro, tasa de acierto, consultas por organización/proyecto/tarea/modelo.
6. **Harness de aceptación:** modo de 2 llamadas por proveedor con tope; ejecución real solo tras la autorización aparte del operador (OpenAI solo si el modelo elegido tiene tarifas de caché configuradas).

## Criterios de aceptación

| Requisito | Punto | Criterio |
| --- | --- | --- |
| REQ-CACHE-001 | 1, 2 | El prefijo estable va primero y el contenido variable al final, con el orden canónico impuesto por el gateway; `prompt` sigue funcionando. |
| REQ-CACHE-002 | 1, 6 | Mismo contenido → mismos bytes (`content` conservado literalmente, sin reescribirlo; orden canónico por `kind`; `rules`, `skills` y `spec` ordenados por `id` y `version`; `history` y demás `kind` no reordenables en el orden del llamador; ids duplicados o ausentes rechazados donde corresponde); fechas, UUID e IDs fuera de los segmentos estables (aviso si aparecen); `prefix_project_sha256` y `prefix_task_sha256` registrados; prefijos distintos entre organizaciones. |
| REQ-CACHE-003 | 2 | Cada adaptador declara `cacheSupport`; el adaptador Anthropic nace con `cache_control` (máximo 4 breakpoints, 1 h antes que 5 min, mínimo por modelo). |
| REQ-CACHE-004 | 2, 4 | Cada llamada registra entrada, salida, escritura (5 min/1 h) y lectura de caché, agregados por llamada, tarea y proyecto, con `cost_events.usage` ampliado. |
| REQ-CACHE-005 | 4 | Tasa de acierto y ahorro por proveedor/modelo, tarea y proyecto, con aislamiento por organización. |
| REQ-CACHE-006 | 7, 9 | Un rechazo de caché se reintenta una vez sin caché con `cache_status=ERROR`; `BELOW_MINIMUM`, `MISS` y `DISABLED` no bloquean; el interruptor apaga la marca. |
| REQ-CACHE-007 | 3 | Tarifas de escritura y lectura separadas, sin asumir la de entrada; falta de tarifa aplicable → `BLOCKED` con `PRICING_REQUIRED` antes de llamar; `NOT_ESTIMABLE` solo tras la respuesta, con motivo y alerta. |
| Punto 5 | 5 | TTL híbrido configurable (`JEV_PROMPT_CACHE_PROJECT_TTL`, `JEV_PROMPT_CACHE_TASK_TTL`) y revisión con mediciones reales. |
| Punto 8 | 8 | Fase 1 completa en CI sin gasto; fase 2 solo con autorización aparte, variable distinta y tope (propuesto CHF 0,10). |

La tarea PLT-052 solo se da por cerrada con la fase 1 verde, la fase 2 ejecutada con autorización del operador y la evidencia registrada, como se hizo con PLT-009.
