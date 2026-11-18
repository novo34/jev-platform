# PROGRESO — JEV Platform

## Identificación

- Platform: `novo34/jev-platform`. Foundation: `novo34/base-skills_klever`.
- Rama de trabajo: `claude/wonderful-franklin-jo4edb`, reiniciada desde `origin/main` (`25b2add`) para PLT-052 PR 2/6 (usage normalizado, precios de caché y migración 0029); el head vigente se consulta en su PR. La PR 1/6 ([PR #41](https://github.com/novo34/jev-platform/pull/41)) está fusionada en `25b2add`, igual que la PR #40 (`claude/elegant-turing-c9wz23`). Base integrada: `main`.
- Última actualización: 2026-11-18. Entorno: Claude Code en la nube (Linux), verificación remota de GitHub.
- Documentación aplicable: [PRD](docs/product-specs/PRD.md), [SPEC](docs/product-specs/SPEC.md),
  [ROADMAP](docs/product-specs/ROADMAP.md) y el [Development Control Gate de Foundation][gate].

## Estado canónico del proyecto

El siguiente bloque proyecta la observación del [backlog de Foundation][backlog].
`platform_sha` identifica la base integrada verificada. El SHA de una PR se comprueba
en GitHub y se contrasta con sus checks y revisiones, ya que cambia con cada commit.

```json
{
  "foundation_sha": "5509b2c41c8e2447cb11137bcf8630acb75a9fec",
  "platform_sha": "25b2add869eb6fab72bcda9faf96ca176c34147f",
  "last_completed": {
    "task": "PLT-012",
    "status": "DONE",
    "pr": "https://github.com/novo34/jev-platform/pull/38",
    "ci": "https://github.com/novo34/jev-platform/actions/runs/44156914917",
    "review": "https://github.com/novo34/jev-platform/pull/38#issuecomment-6958190841"
  },
  "next_task": {
    "task": "PLT-052",
    "status": "TODO"
  },
  "requires_operator_authorization": true,
  "next_action": "PR 1/6 de PLT-052 fusionada (PR #41, 25b2add). PR 2/6 (usage, precios y migración 0029) hecha en esta rama, pendiente de PR, revisión y fusión. Esperar la autorización del operador (R3) para la PR 3/6 (interruptor JEV_PROMPT_CACHE y reintento sin caché); la implementación se autoriza PR a PR."
}
```

La fase es implementación controlada de Platform. PLT-009 y PLT-010 figuran como
`DONE`. PLT-050 y PLT-051 están DONE en Foundation (PLT-051 en el PR #26, `828af46`). PLT-051 está fusionado en Platform ([PR #30](https://github.com/novo34/jev-platform/pull/30)) y aceptado en JEV Staging el 17 de noviembre de 2026. PLT-011 está DONE en Foundation (PR #27, `f145a85`). PLT-012 está DONE en Foundation ([PR #29](https://github.com/novo34/base-skills_klever/pull/29), `5509b2c`) y fusionada en Platform ([PR #38](https://github.com/novo34/jev-platform/pull/38), `baa23e9`). NEXT_TASK pasa a PLT-052 (caché de prompts del Model Gateway), con diseño aprobado por el operador el 2026-11-18. La PR 1/6 de PLT-052 (constructor determinista del prompt, `packages/model-gateway/src/prompt-builder.ts`, sin conectar al gateway) está fusionada ([PR #41](https://github.com/novo34/jev-platform/pull/41), `25b2add`). La PR 2/6 (usage normalizado, precios de caché y migración 0029) está hecha en esta rama, pendiente de PR y fusión; la PR 3/6 requiere autorización (R3). Fase actual: PLT-012 cerrada; PLT-052 en implementación PR a PR. Staging aceptó la integración
GitHub App el 23 de octubre de 2026 en `0882b4c661a2bd6a92bcf895cb1417981fcd565e`.
La remediación de [PR #24][audit-pr] se verificó en staging mediante un merge
autorizado con informe independiente firmado. El alcance de esta aceptación
fue el entorno de pruebas y el repositorio de aceptación.

## Objetivo actual

Conservar un punto de reanudación verificable en Platform y distinguir el cierre histórico
de PLT-010 de la aceptación operativa de su remediación de seguridad.

## Última sesión de desarrollo

Sesión de PLT-052 del 2026-11-18. El diseño de la caché de prompts se aprobó y
fusionó en la [PR #40](https://github.com/novo34/jev-platform/pull/40) (`7705b78`).
La corrección del criterio 7 está en la [PR #30 de Foundation](https://github.com/novo34/base-skills_klever/pull/30)
(abierta). La PR 1/6 (constructor determinista del prompt) se fusionó en la
[PR #41](https://github.com/novo34/jev-platform/pull/41) (`25b2add`). Esta sesión
implementa la PR 2/6 en la rama `claude/wonderful-franklin-jo4edb` (reiniciada desde
`origin/main`): modelo de uso normalizado y mapeo de OpenAI, DeepSeek y Anthropic
(este último solo como función pura, sin adaptador), precios de caché con validación
previa, `PROMPT_TOO_LARGE_FOR_TIER`, `NOT_ESTIMABLE` posterior a la respuesta y la
migración `0029`. PLT-052 sigue sin cerrarse: faltan las PR 3/6 a 6/6.

## Funcionalidades completadas

| Criterio canónico de PLT-010 | Estado y evidencia |
| --- | --- |
| Instalación GitHub App | DONE. Setup/OAuth real en staging y vinculación de repositorio e identidad verificada. [Runbook](docs/GITHUB_APP.md#real-functional-acceptance-evidence--2026-10-23-utc). |
| Tokens temporales | DONE. Emisión real HTTP 201 y operaciones con permisos limitados a un repositorio. Las pruebas nativas verifican expiración, alcance y permisos. [Transporte](packages/control/tests/github-app.node-test.mjs). |
| Ramas, commits, PR, checks y merge con guardas | DONE. La App fusionó la [PR de prueba][fixture] tras la aprobación humana del SHA exacto. Se registraron rechazos antes de la aprobación y para otro SHA. [Control](packages/control/src/github-operations.ts). |
| Escrituras directas a main/master | DONE. El ensayo real rechazó `branch: main`. Transporte y regresión PostgreSQL cubren `main`, `master` y ramas protegidas. [Regresión](packages/control/src/github-operations.test.ts). |

Los cambios principales de PLT-010 están en
[instalación e identidades](packages/control/src/github-installation.ts),
[transporte GitHub](packages/control/src/github-app.ts),
[API](apps/api/src/), [migraciones 0021–0024](packages/db/migrations/) y
[pruebas de navegador](scripts/github-installation.browser-test.mjs).

## Pruebas y evidencias

- PLT-052, PR 2/6 (usage, precios y migración 0029). Ejecutado en local con PostgreSQL local de pruebas (`DATABASE_URL` a la base `jev_test`): `npm run check` con código de salida 0 (typecheck, 568 pruebas de vitest pasadas y 2 omitidas en los workspaces, build y 6 pruebas de navegador); en `@jev/model-gateway` 103 pruebas (nuevas: `usage.test.ts`, bloque de precios de caché en `pricing.test.ts`, mapeo por HTTP en `adapters.test.ts` y contabilidad de caché en `model-gateway.test.ts`); en `@jev/db` 17 pruebas, con `model-gateway-cache-migration.test.ts` (CHECK de proveedor con `anthropic`, CHECK de caché y grants con la línea real de `provision-runtime-role.sql`) y `persistence.test.ts` con `0029`; `CI=true JEV_DB_SMOKE=1 npm run smoke:restricted-runtime` PASS (10 writers, 29 migraciones, inventario de CHECK ampliado en `scripts/verify-db-topology.mjs`); `python3 -B scripts/test-check-progress.py` y `python3 -B scripts/check-progress.py --base 25b2add869eb6fab72bcda9faf96ca176c34147f` (resultado en el commit de la PR). El estado del CI de GitHub y la revisión de Greptile se consultan en la PR para el head vigente, porque el SHA propio no puede escribirse en el mismo commit.
- PLT-052, PR 2/6, limitaciones conocidas: ningún adaptador marca caché y `anthropic` no está en `MODEL_PROVIDERS` (solo en los CHECK de la migración); `cache_status` solo toma `HIT`, `PARTIAL` o `WRITE` (el resto depende de las PR 3 y 4); `prefix_project_sha256` y `prefix_task_sha256` quedan en `NULL` hasta integrar el constructor en el gateway; el aislamiento por organización de las vistas es de la PR 5; el formato de la respuesta de OpenAI con TTL de escritura (`cache_write_tokens_details`) se aceptó en dos ubicaciones por no poder verificarse sin red a proveedores; la estimación previa de tamaño del prompt (2 bytes por token) es heurística. Cambio intencional: OpenAI y DeepSeek exigen `cacheReadPerMillionChf` (solo afecta al harness de desarrollo; docs de PLT-009 actualizadas).
- PLT-052, PR 2/6, higiene: sin llamadas de pago ni red a proveedores, sin secretos, sin cambios de `GRANT` (el `INSERT` de tabla de `jev_runtime` cubre las columnas nuevas), migración aditiva y reversible a mano, sin `__pycache__` (validadores con `-B`).
- PLT-052, PR 1/6: fusionada en `25b2add` ([PR #41](https://github.com/novo34/jev-platform/pull/41)). Se conserva su evidencia a continuación.
- PLT-052, PR 1/6 ([PR #41](https://github.com/novo34/jev-platform/pull/41)). Ejecutado en local sobre la rama, con PostgreSQL local de pruebas (`DATABASE_URL` a la base `jev_test`): `npm run check` con código de salida 0; `packages/model-gateway/src/prompt-builder.test.ts` con 20 pruebas pasadas (`npx vitest run`); `python3 -B scripts/test-check-progress.py` con 4 pruebas OK; `python3 scripts/check-progress.py --base 7705b7810973a78182309225a551ae2e9b749d70` válido. CI de GitHub: el job `validate` falló en `b86bb51` solo por PROGRESO.md (no cumplía AGENTS.md); este registro lo completa. El estado vigente del CI se consulta en la PR #41 para el head actual, porque el SHA propio no puede escribirse en el mismo commit.
- PLT-052, PR 1/6, revisión de Greptile de la PR #41. Se revisaron `b86bb51` y `f2f4856`, ambos con 4/5. Hilos cerrados con corrección: huecos de arrays y kinds heredados en el constructor (`174e118`) y `segmentRefs` ambiguos con `@` (`2733f2c`). El hallazgo sobre PROGRESO.md (`f2f4856`) se atiende en este commit. Enlace al resultado y SHA revisado: consultar la PR #41.
- PLT-052, PR 1/6, limitaciones conocidas: no está conectado a ModelGateway ni a los adaptadores; `detectPrefixInstability` es una función pura y el llamador guarda la huella; la detección de fecha y UUID es heurística; el formato de las cabeceras se define en esta PR porque el diseño no lo fija; el tenant debe ser un HMAC hexadecimal de 64 caracteres.
- PLT-052, PR 1/6, higiene: sin migraciones, sin llamadas de pago, sin secretos, sin lectura del entorno y sin `__pycache__` (los validadores se ejecutaron con `-B`).

- PLT-051, aceptación en JEV Staging (2026-11-17). El operador comprobó el despliegue de `f2f54c0` (main, que incluye `2d29785`) con Dokploy en Done. El correo de recuperación llegó desde `no-reply@notificaciones.nuvurent.com` (dominio verificado en Resend, sin seguimiento de enlaces, variables `JEV_STAGING_RESET_*` en Dokploy). El enlace permitió cambiar la contraseña y entrar con la nueva. Al reenviar el formulario con el mismo enlace, la web mostró «El enlace ya no es válido. Solicita otro desde el formulario de acceso.». Una sesión iniciada antes del cambio en otra pestaña pidió volver a entrar al recargar. Para la caducidad, con un enlace nuevo sin abrir, un UPDATE de `public.password_reset_tokens` en el contenedor postgres de staging adelantó `expires_at` solo de los tokens vigentes del usuario `00000000-0000-4000-8000-000000000002` (`UPDATE 1`), y al usar el enlace la web mostró el mismo mensaje de enlace no válido. No se copiaron enlaces ni credenciales a logs ni a la conversación. Observación de UX no bloqueante: la web no valida el enlace al abrirlo, muestra siempre el formulario y el rechazo llega al enviar (`apps/web/src/main.tsx:441-471`, `apps/api/src/password-recovery.ts:130-134`); no existe endpoint de comprobación sin consumo.
- PLT-051, [PR #30](https://github.com/novo34/jev-platform/pull/30). El [CI de `df7810d`](https://github.com/novo34/jev-platform/actions/runs/43897717852) falló en `validate`: la prueba de migraciones no listaba `0027`. Al reproducirlo con PostgreSQL 16 local aparecieron tres fallos más del gate de producción: el rol de CI no recibía EXECUTE sobre `jev_issue_password_reset` y `jev_consume_password_reset`, el inventario de CHECK no incluía `password_reset_tokens_token_hash_check` y el smoke esperaba ocho writers controlados. La corrección concede ambos writers en `packages/db/security/provision-runtime-role.sql`, fija el predicado exacto de la CHECK, actualiza el recuento a diez y aplica `0027` en la prueba ACL. En local pasaron `npm run check`, `smoke:restricted-runtime` (10 writers, 27 migraciones) y el smoke de desarrollo. La PR se fusionó con squash en `2d29785` desde el head `162df9c`, con [CI del head](https://github.com/novo34/jev-platform/actions/runs/43948435717) y [CI de main](https://github.com/novo34/jev-platform/actions/runs/43949674151) aprobados. La última revisión de CodeRabbit, sobre `162df9c`, no dejó hallazgos. La revisión automática de Codex no se completó por falta de cupo.
- PLT-051, CodeRabbit sobre `df7810d`. Se contrastaron cinco hallazgos con el código. Dos Major (permisos del rol de CI y recuento de writers) se corrigieron en `e5ccafc`; CodeRabbit marcó como resuelto el de la migración `0027`. Un Major confirmado: `limiter()` usaba un contador global, de modo que un cliente anónimo podía agotar la recuperación de todas las cuentas. Por decisión del operador, se sustituye por cubos por cuenta (organización y correo normalizado, 3 por minuto) y por token (5 por minuto). Los enlaces desconocidos o caducados se rechazan antes de scrypt, con un techo global secundario de 120 hashes por minuto que solo alcanza quien tiene un enlace vigente. No se limita por IP para no depender de la confianza en `X-Forwarded-For`. Los dos hallazgos Trivial se incorporaron como pruebas: límite de un minuto determinista y carrera entre `login` y restablecimiento. Las pruebas nuevas fallaron contra el limitador anterior y contra un `login` sin bloqueo, y pasaron con la corrección. En local pasaron `npm run check` y `smoke:restricted-runtime`.
- PLT-051, CodeRabbit sobre `23e7087`. Un hallazgo Minor confirmado: la prueba de inundación podía fallar con una base de datos lenta, porque las entregas pendientes llenaban el límite de concurrencia y la solicitud de la cuenta objetivo se descartaba. La prueba espera ahora a que el pool quede inactivo, y el límite de entregas pendientes pasa de 8 a 32 como protección secundaria. No se reprodujo el fallo de temporización en local; la prueba pasó tres veces seguidas, igual que `npm run check` y `smoke:restricted-runtime`. Los hilos de revisión anteriores quedaron respondidos y resueltos.
- PLT-051, CodeRabbit sobre `3a0def5`. Hallazgo confirmado: con las entregas pendientes en el tope, una solicitud legítima se descartaba igualmente pero consumía uno de los tres intentos por cuenta, así que tres reintentos durante la saturación bloqueaban la cuenta el resto del minuto. Ahora se comprueba primero el hueco y el intento solo se consume si la emisión arranca. `PasswordRecoveryOptions.maxPendingDeliveries` permite fijar el tope en pruebas. La prueba nueva retiene la única entrega con un bloqueo asesor, verifica tres solicitudes descartadas y comprueba que la cuarta, ya sin saturación, envía el correo. Falló por aserción con el orden anterior y pasó con la corrección. En local pasaron tres ejecuciones seguidas, `npm run check` y `smoke:restricted-runtime`.

- [PLT-050, PR #28](https://github.com/novo34/jev-platform/pull/28). CodeRabbit y los cuatro jobs del [CI final](https://github.com/novo34/jev-platform/actions/runs/43877821397) pasaron en `936e5bd7df907539705f8dbf6f9d638db27f5f49`; se resolvieron seis observaciones. El [CI de main](https://github.com/novo34/jev-platform/actions/runs/43879815373) pasó en `faceb121968a8557ba66c2a6d37ede25ead851c7`.
- Dokploy mostró Done para ese commit. El operador confirmó el 16 de noviembre de 2026 que la sesión siguió abierta al recargar y al volver del OAuth real de GitHub, y que logout seguido de recarga dejó visible el login. PostgreSQL de CI cubrió expiración, revocación, clientes Bearer y CSRF.

- PLT-050. El [CI de la primera revisión de PR #28](https://github.com/novo34/jev-platform/actions/runs/43872739376) pasó en `a25fb2428d44a1f59ac51797dc16d196fb3d203e`. Incluyó autenticación, caducidad, revocación y CSRF en PostgreSQL y recarga, retorno simulado de GitHub y cierre de sesión en Chromium. Los resultados de la revisión final y de staging constan arriba.

- Remediación de PLT-010 (2026-11-16). Tarea `9f62af00-2562-47b1-9237-6447e11447e7`,
  ciclo `4cb5efe7-4d07-49b4-a91d-700ca4c0738d`. Se verificó localmente la firma
  Ed25519 de `qa-v1` y PostgreSQL confirmó `VERIFIED` con el informe registrado.
- [PR de aceptación #4](https://github.com/novo34/SaSS_Workee/pull/4), head
  `a07e8fe5bf95f817035747ae32f59e0cd1e72082`. La revisión independiente dio PASS
  con dos hallazgos bajos o informativos. El artefacto nuevo contiene caracteres
  de reemplazo y su contenido se revisó manualmente. El [CI previo](https://github.com/novo34/SaSS_Workee/actions/runs/43855365316)
  pasó y el validador del workflow comprobó el artefacto histórico.
- JEV fusionó la PR tras aprobación exacta. GitHub confirmó al bot de staging y
  el commit `4b3085eca309fd66185a2c01d1284bce0c63e098` en main, con
  [CI posterior aprobado](https://github.com/novo34/SaSS_Workee/actions/runs/43865745283).
- El [CI de Platform](https://github.com/novo34/jev-platform/actions/runs/42411411797)
  cubre firmas inválidas y caducadas. En staging real se comprobó el flujo con
  informe válido. Las filas individuales de migración y el ledger de merge no
  se consultaron directamente.

- La revisión de CodeRabbit de PR #25 motivó regresiones automatizadas de
  estructura, credenciales, rutas Unicode y ascendencia de la base de la PR.
  [CodeRabbit revisó][continuity-rabbit] el SHA
  `59e07be15842b134ea748c816c22b202127a39a0` y señaló dos observaciones
  documentales, sobre el registro de evidencia y el alcance de CI. Ambas se
  atienden en esta actualización. La nueva revisión está pendiente al publicar
  el cambio. Consultar la PR para verificar el resultado del head vigente.

- Auditoría continua de Platform: desde el 17 de noviembre de 2026 la revisión
  automática de PR la hace Greptile, configurado en
  [.greptile/config.json](.greptile/config.json) con revisión al abrir y en cada
  push, sin aprobación automática ni reescritura de la descripción, y comentarios
  en español. La revisión de borradores se activa en el panel de Greptile.
  CodeRabbit dejó de usarse; sus revisiones anteriores siguen enlazadas como
  evidencia histórica. Comprobar el resultado de cada revisión en su PR y SHA.

- El [CI del head de PR #23][ci] y el [CI posterior a la integración][main-ci]
  terminaron con los cuatro jobs aprobados. Incluyen typecheck, build, regresión,
  PostgreSQL 16, rol restringido, navegador y verificación de staging desechable.
- La [revisión técnica independiente registrada][review] no reportó P0/P1/P2 en
  el candidato final. El resumen automatizado de Codex del último head seguía
  en `Running` al consultarlo el 7 de noviembre. El bot sí publicó un
  [recibo sin hallazgos importantes en un SHA anterior][bot-review].
- El [ensayo real][fixture] validó instalación, operaciones e idempotencia contra
  GitHub. PostgreSQL con GitHub simulado cubre los casos adversariales de OAuth,
  CSRF, aislamiento, revocación concurrente y aprobaciones obsoletas. El CI de
  ese repositorio de prueba se limitó a sintaxis PHP y al artefacto de aceptación.
- Continuidad: el validador pasó en modo local y con el checkout canónico de
  Foundation. Se probaron rechazos por sección/evidencia/acción inválida,
  credencial simulada, SHA incorrecto, salto de tarea, omisión de autorización
  y cambio material sin checkpoint.

## Pull requests y commits

- [Platform PR #23][pr] fusionada el 23 de octubre de 2026 con head
  `0f0c960a48f9dd5e0943ec6b95ef1e62c23853f0` y squash
  `f86aa98107527edb27dc837882f0a9fed82ed654`.
- [Foundation PR #23][foundation-pr] reconcilió el cierre en
  `209cf728d4aea9a71af52d948a33a4db309112ac`.
- [Platform PR #24][audit-pr], remediación fusionada con head
  `bf2cbad16c204856f1b1afe2cb3c1b1308994c58` y squash
  `a3449c46f23444c85a96e6e03bab2e5effc16a30`. Pasaron los cuatro jobs
  de [CI][audit-ci] y las revisiones de [Codex][audit-codex] y
  [CodeRabbit][audit-rabbit] finalizaron sin hallazgos pendientes.
  La validación de staging de octubre corresponde al alcance anterior.
- [Platform PR #25][continuity-pr], continuidad. Sus checks y revisión son la evidencia
  del SHA publicado para este cambio de mantenimiento.

## Problemas detectados

La [auditoría posterior al cierre][audit-report] reprodujo en la base integrada
un P1 de autenticidad de la verificación técnica para merge y un P2 de permisos
de escritura sobre identidad verificada y ledger de operaciones. Detectó también
el estado obsoleto del runbook. El resumen del bot de Codex para el head final de
PR #23 no contiene un recibo final. La revisión técnica independiente tiene
registro separado.

PLT-012 R4: la primera ejecución real (2026-11-17) terminó `FAILED`: el compose `jev-stg-demo` sirvió la revisión `7baa286`, pero `/health` daba 503 con `database: "error"`. Sus causas se corrigieron y la repetición terminó `READY` (ver «Problemas resueltos»).

## Problemas resueltos

PLT-012 cerrada. El motor llegó en las PRs #35, #36 y #38. La ejecución R4 repetida con el motor corregido terminó `READY` contra Dokploy v0.31.2: proyecto «JEV Proyectos / staging», compose `jev-stg-demo` (aplicación `jev-staging-demo`) en la revisión `7baa286`, publicada en https://demo.staging.nuvurent.com, con las seis etapas completas y `/health` en 200. El repositorio de prueba es público: `novo34/jev-staging-demo`. Evidencia: [PR #38](https://github.com/novo34/jev-platform/pull/38), [CI](https://github.com/novo34/jev-platform/actions/runs/44156914917) y [revisión](https://github.com/novo34/jev-platform/pull/38#issuecomment-6958190841). Limitaciones declaradas: el registro de despliegues está en la BD de control local, no en la de staging; el job `STAGING_DEPLOY` no está registrado en el worker (`server.ts`) y queda para una tarea posterior, por decisión del operador (opción 1). Recursos que permanecen en Dokploy: el compose `jev-stg-demo` y su volumen.

PLT-012 R4, hallazgos de la primera ejecución (`FAILED`), ya corregidos: (1) Dokploy guarda `appName` con un sufijo aleatorio (`jev-stg-demo-dotuoz`); el adaptador reconoce el compose por `name` y `appName` esperado más sufijo (commit `02610cb`, esta PR). (2) El rol runtime no se creaba: el init de `configs.content` usaba `:"DBNAME"` sin definir y solo corre con el volumen vacío. Corrección (commit `fix(PLT-012): aprovisionar el rol runtime en cada despliegue`): servicio one-shot idempotente `db-roles` antes de `migrate`, `seed` y `app`, healthcheck de `db` por TCP, sin init ni `configs.content`; `verifyDatabase` lo exige. Pruebas en `packages/staging/src/compose-template.test.ts` (incluido el SQL contra PostgreSQL real). Ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md#hallazgo-r4-rol-runtime-sin-crear-health-503).

PLT-010 filtró campos sensibles de las respuestas de GitHub, solicitó
`statuses: read` para observar estados y serializó la autorización para
proteger las mutaciones concurrentes. El README remite a este checkpoint.
[PR #24][audit-pr] añadió una atestación Ed25519 ligada al ciclo de
verificación y a la PR/SHA, endurece ACL y registros con las migraciones
0025/0026 y corrige el runbook.

## Trabajo pendiente

PLT-051 implementa solicitud y formulario, tokens de un solo uso, revocación transaccional y envío configurable con Resend. Está fusionado en `main` en `2d29785`. El operador configuró el dominio `notificaciones.nuvurent.com` en Resend, sin seguimiento de enlaces, y las variables `JEV_STAGING_RESET_*` en Dokploy. La aceptación en staging está comprobada (17 de noviembre de 2026). El cierre en Foundation está completado. Como mejora opcional de UX, validar el enlace de recuperación al abrirlo.

PLT-011 está cerrada. Quedan como tareas posteriores la activación de `WORKSPACE_RUN` en un servidor dedicado y, como mejora, fijar por digest las imágenes base de `deploy/staging/Dockerfile.*`.

PLT-012 está cerrada. Foundation fijó en su [PR #28](https://github.com/novo34/base-skills_klever/pull/28) el nuevo orden: PLT-052 → PLT-040 → PLT-041 → PLT-017 → PLT-042/PLT-014. Quedan como tareas posteriores registrar `STAGING_DEPLOY` en el worker (cableando `StagingJobDeps.integratedRevision` con `loadIntegratedRevision`), decidir el almacenamiento cifrado de la API key de Dokploy y, después, el caso de Espacore. PLT-052: la PR 1/6 (constructor determinista del prompt) está fusionada en `25b2add` ([PR #41](https://github.com/novo34/jev-platform/pull/41)). La PR 2/6 (usage, precios y migración 0029) está hecha en esta rama, pendiente de PR y fusión. La PR 3/6 (interruptor y fallo seguro) requiere autorización del operador (R3).

Foundation integró la prioridad en su [PR #24](https://github.com/novo34/base-skills_klever/pull/24). PLT-050 precede a PLT-051 y PLT-011. El candidato usa una cookie de sesión HttpOnly, validación de sesión existente y protección CSRF para escrituras. La aceptación en staging está comprobada. El [cierre de Foundation #25](https://github.com/novo34/base-skills_klever/pull/25) incluye caducidad forzada de una sesión de prueba en staging y retorno al formulario.

## Bloqueos y dependencias

El [CI de Foundation](https://github.com/novo34/base-skills_klever/actions/runs/43896184283) confirmó PLT-051 como NEXT_TASK. La recuperación por
correo requiere un proveedor de envío configurado para la prueba en staging.
El validador comprueba el formato de `last_completed.pr`, `last_completed.ci` y
`last_completed.review`. Los demás enlaces, incluidos los destinos Markdown
locales, se comprueban por separado. La reconciliación con Foundation y la vigencia
de la evidencia de GitHub se comprueban al preparar el handoff y al reanudarlo.

## Decisiones y autorizaciones

El modo `single_operator` se autorizó para el ensayo del 23 de octubre con
verificación técnica independiente, aprobación humana exacta y protección
de rama. Su alcance está en el [runbook](docs/GITHUB_APP.md#merge-policy).
El backlog sigue siendo la autoridad. El cambio de continuidad reutiliza
NEXT_TASK, CI y los registros de decisiones y evidencias existentes. Se tramita
como mantenimiento de repositorio porque PR #23 ya se fusionó y su integración
quedó cerrada en Foundation. PR #24 conserva el cambio del runbook
junto con las correcciones que documenta. La base de #25 incluye la integración
autorizada de #24.

El 17 de noviembre de 2026 el operador decidió dejar CodeRabbit y usar Greptile como revisor automático. Greptile se limitó en GitHub a los repositorios de JEV y se desactivó el uso de datos para entrenamiento. El operador autorizó fusionar la PR #30.

El 17 de noviembre de 2026 el operador autorizó iniciar PLT-011 y fusionar la PR #33.

El 17 de noviembre de 2026 el operador autorizó fusionar la PR #34 y la PR #27 de Foundation, e iniciar PLT-012.

El 17 de noviembre de 2026 el operador decidió, en la fase de investigación previa al desarrollo, adelantar en el roadmap la caché de prompts del Model Gateway y la Fase 10 (Context Runtime con Context Packs acotados) por el coste de tokens, y documentar las mejoras detectadas ([ROADMAP](docs/product-specs/ROADMAP.md#prioridad-de-ejecución-ajustada-2026-11-17), [mejoras](docs/architecture/MEJORAS-PRE-DESARROLLO-2026-11.md)). Orden: PLT-052 (caché de prompts y adaptador Anthropic) → PLT-040 y PLT-041 (Fase 10) → PLT-017 (guard de presupuesto mínimo) → PLT-042 (Fase 12) y PLT-014 (Fase 20). Reflejado en Foundation (novo34/base-skills_klever#28, merge b50843d); la tarea en curso PLT-012 ya está cerrada (Foundation #29). NEXT_TASK manda. PLT-009: Aceptación con llamadas de pago reales confirmada por el operador el 2026-11-17 (estado DONE). Ejecución del 2026-10-13 con el harness de desarrollo `npm run accept:gateway -w @jev/api` sobre `main` local en `4da1e99` (`maxOutputTokens=16`, `maxRetries=0`, sin fallback, organización de desarrollo local): DeepSeek `deepseek-flash` (request `3d714fb4-3801-4dfe-be7c-305245c1a8e2`, 1 intento, tokens 34/16/50, coste estimado CHF 0.0000245) y OpenAI `gpt-4.1-nano` (request `f76632ed-cbc6-4bd0-876b-19c97ef95b46`, 1 intento, tokens 11/2/13, coste estimado CHF 0.0000019), ambos SUCCESS con llamada y coste persistidos en PostgreSQL. Los importes CHF son estimaciones con precios configurados, no facturas. Evidencia: [issue #12](https://github.com/novo34/jev-platform/issues/12) ([comentario del 2026-10-13](https://github.com/novo34/jev-platform/issues/12#issuecomment-6152023926); cerrado como completado por el operador el 2026-10-22); CI de integración del gateway: [run 38158880609](https://github.com/novo34/jev-platform/actions/runs/38158880609) (2026-10-11, merge de PR #9 en `6f4b822`, SUCCESS); CI posterior: [run 39810983854](https://github.com/novo34/jev-platform/actions/runs/39810983854) (2026-10-22, head de PR #22 `805c57b`, validate, staging-runtime-smoke, staging-compose y staging-image-build SUCCESS). Ejecución aportada por el operador, no re-ejecutada en esta revisión.

El 17 de noviembre de 2026 el operador decidió para PLT-011 (ver [diseño](docs/architecture/PLT-011-WORKSPACE-ENGINE.md)): (1) el ejecutor se prueba con Docker real en el CI de GitHub y no se activa en JEV Staging; su activación en un servidor o VM dedicado es posterior; (2) el ejecutor clona fuera del contenedor, que tiene red solo durante `npm ci` y después `--network none`; (3) límites por defecto de 1 CPU, 2 GB de RAM, 256 procesos, 15 min por comando y 60 min por tarea; (4) sin retención: el workspace se destruye siempre al terminar.

El 17 de noviembre de 2026 el operador decidió para PLT-012 (ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md)): (1) alcance por fases: primero el motor probado en CI con un Dokploy simulado y después, como paso aparte aprobado (R4), el staging real del primer caso (proyecto de prueba mínimo `novo34/jev-staging-demo`, decisión posterior del operador; Espacore queda para después), con cuya evidencia se cierra PLT-012; (2) proveedor: API de Dokploy detrás del contrato neutral de FND-026, con la API exacta verificada contra la instancia antes del paso real; (3) un contenedor PostgreSQL propio por proyecto con volumen propio y roles owner/runtime separados, sin credenciales ni datos de producción; (4) nueva operación GitHub controlada que integra la rama de la tarea en `staging_branch` con las guardas de PLT-010. Los valores por defecto (dominio, API key cifrada, migraciones con copia previa, seeds sintéticos, E2E mínimo) quedan pendientes de confirmar antes del paso real.

El 17 de noviembre de 2026 el operador autorizó cerrar PLT-012 en Platform y decidió que el job `STAGING_DEPLOY` quede sin registrar en el worker hasta una tarea posterior (opción 1). El 18 de noviembre de 2026 el operador aprobó el diseño de PLT-052 ([documento](docs/architecture/PLT-052-PROMPT-CACHING.md)); la implementación se autoriza PR a PR (R3). La PR 1/6 está fusionada en la PR #41 (`25b2add`) y la PR 2/6 (usage, precios y migración 0029) la autorizó el operador el 2026-11-18; la PR 3/6 está pendiente de autorización (R3). Siguen abiertas la frecuencia real de llamadas, el impacto en PLT-017, el secreto del `tenant_namespace` y la tarifa punta de DeepSeek. El criterio 7 se corrigió en Foundation (rama `claude/wonderful-franklin-jo4edb`, commit `2849c5f`); su [PR #30](https://github.com/novo34/base-skills_klever/pull/30) está abierta, pendiente de CI y fusión.

## Higiene del repositorio

El alcance de continuidad abarca el validador, su única llamada desde el CI,
instrucciones y documentación. No añade dependencias al producto. La búsqueda
de equivalentes incluyó Platform y las skills canónicas 29, 57, 58, 91 y 92.
El validador reutiliza NEXT_TASK y aplica un escaneo limitado a patrones comunes
de credenciales. Se conserva la revisión histórica de higiene de PLT-010 en el
[runbook](docs/GITHUB_APP.md#technical-checks-and-hygiene). Las referencias
dinámicas requieren inspección de sus consumidores antes de proponer borrados.
`.claude/agents/` define dos agentes de Claude Code: `lector-proyecto` (solo lectura) y `escritor-codigo`; no forman parte del producto.

## Siguiente paso exacto

PLT-052 (caché de prompts del Model Gateway con un adaptador Anthropic con caché desde el primer día), diseño aprobado el 2026-11-18; PR 1/6 fusionada en `25b2add` ([PR #41](https://github.com/novo34/jev-platform/pull/41)); PR 2/6 hecha en la rama `claude/wonderful-franklin-jo4edb`:

1. HECHO: PR 1/6 fusionada (PR #41, `25b2add`).
2. Abrir la PR de la PR 2/6 (usage, precios y migración 0029), esperar CI y revisión de Greptile del head vigente y fusionarla con la autorización del operador. Después, esperar la autorización del operador (R3) para la PR 3/6 (interruptor `JEV_PROMPT_CACHE` por defecto `off`, `cache_status` `DISABLED` y `ERROR`, reintento sin caché); la implementación es PR a PR y cada PR lleva sus pruebas. Antes de configurar precios reales hay que anotar el tipo de cambio y la fecha usados. Las preguntas abiertas (frecuencia real de llamadas, impacto en PLT-017, secreto del `tenant_namespace` y tarifa punta de DeepSeek) no se deciden sin el operador.
3. La PR de Foundation con la corrección del criterio 7 ([PR #30](https://github.com/novo34/base-skills_klever/pull/30)) está abierta, pendiente de CI y fusión.
4. Después de PLT-052, el orden decidido por el operador el 2026-11-17 es PLT-040 y PLT-041 (Fase 10, Context Runtime), PLT-017 (guard de presupuesto mínimo) y solo entonces PLT-042 (Fase 12) y PLT-014 (Fase 20). Está reflejado en Foundation (novo34/base-skills_klever#28). Antes de iniciar cada una, confirmar NEXT_TASK y la autorización del operador.

Historial de PLT-012 (cerrada; diseño en [docs/architecture/PLT-012-PERMANENT-STAGING.md](docs/architecture/PLT-012-PERMANENT-STAGING.md)):

1. HECHO: diseño y decisiones del operador del 2026-11-17.
2. HECHO: operación GitHub `GITHUB_INTEGRATE_STAGING` (migración 0028, solo amplía la lista del trigger del ledger).
3. HECHO: adaptador Dokploy + plantilla de Compose en `packages/staging` (`@jev/staging`), probado con un Dokploy simulado; la API se verificó en solo lectura contra Dokploy v0.31.2 (queda `VERIFY-R4` solo lo no verificado) (ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md#implementación-del-adaptador)).
4. HECHO (commit `feat(PLT-012): orquestador de staging, deployments controlados y job STAGING_DEPLOY`): orquestador en `packages/staging` (evidencia saneada por etapa, `READY` solo con las seis etapas), `PgDeploymentRegistry` sobre `jev_create_environment`/`jev_create_deployment`/`jev_set_deployment_status` (wrapper `createEnvironment` en `@jev/db`, sin migraciones ni permisos nuevos) y job `STAGING_DEPLOY` en `apps/worker/src/staging-job.ts`, no registrado en `server.ts`. La API key de Dokploy se inyecta y no va en la BD; su almacenamiento cifrado se decide en la activación (ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md#implementación-del-orquestador)).
4b. HECHO (commit `fix(PLT-012): desplegar staging desde el SHA exacto registrado`): el Compose construye desde `https://github.com/<repo>.git#<sha40>` (no la rama), `appImage` exige digest, `JEV_STAGING_REVISION` en el Compose, el health/E2E comprueba la revisión (distinta: `FAILED`; no informada: «no verificable», VERIFY-R4) y el job exige que `revision` coincida con el `sha` de `GITHUB_INTEGRATE_STAGING` en el ledger (solo SELECT). Ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md#integridad-de-la-revisión-desplegada). Al activar el job, `StagingJobDeps.integratedRevision` debe cablearse con `loadIntegratedRevision(pool, ids)`.
4c. HECHO (commit `fix(PLT-012): atender la revisión de Greptile (revisión integrada, propiedad, E2E degradado y reserva)`): 4 hallazgos de Greptile sobre `2150435` (https://github.com/novo34/jev-platform/pull/35#issuecomment-6951991817), todos reales. (P1) un 204 de la Merges API registraba `headSha` aunque no fuera la punta de `staging_branch`: ahora registra la punta actual (`headSha` aparte). (P1) el Compose se reutilizaba solo por `appName`: ahora lleva `JEV_STAGING_OWNER=<proyecto>:<repositorio>` y se rechaza con `staging_resource_owned_by_other_project` antes de escribir (también si otro compose del entorno sirve el host); `ProjectRegistryService.register` rechaza un `staging_url` repetido (`STAGING_URL_IN_USE`, sin migración). (P1) `runOnlineE2E` descartaba `degraded`: ahora lo conserva con evidencia por ruta y da `BLOCKED`. (P2) dos ejecuciones sobre el mismo staging podían pisarse: `PgDeploymentRegistry` toma un `pg_try_advisory_lock` de sesión hasta `finish` y la segunda termina `BLOCKED` `staging_busy` sin tocar Dokploy. Sin migraciones ni permisos nuevos. Ver [diseño](docs/architecture/PLT-012-PERMANENT-STAGING.md#revisión-de-greptile-de-la-pr-35-sobre-2150435). Segunda ronda de Greptile sobre `03a4473` (2 hallazgos, ambos reales), corregida en `fix(PLT-012): reutilizar la conexión reservada y ordenar los bloqueos de registro`: (P1) `PgDeploymentRegistry.begin` pedía otra conexión al pool además de la del bloqueo (con `max: 1` se colgaba): ahora la conexión reservada sirve a `ensureStagingEnvironment`, `createDeployment` y `setDeploymentStatuses` (los escritores de `@jev/db` aceptan `Queryable`, `Pool` o `PoolClient`, mismo SQL) y se libera en `finish`; prueba con pool `max: 1`. (P2) `register` bloqueaba los hosts en el orden recibido y A/B con B/A daba `40P01`: ahora se deduplican y ordenan antes de bloquear; prueba con registros concurrentes. Sin migraciones ni permisos nuevos. Pendiente: revisión de Greptile del nuevo commit.
5. HECHO: pruebas de CI (Dokploy simulado, PostgreSQL efímero, GitHub simulado) y PR #38 fusionada con Greptile revisado.
6. HECHO: paso real R4 con `novo34/jev-staging-demo` en `READY` (revisión `7baa286`, https://demo.staging.nuvurent.com, seis etapas, `/health` 200). La primera ejecución `FAILED` se corrigió (sufijo de `appName` y rol runtime con `db-roles`). Espacore queda para después.

Historial de PLT-011 (cerrada):

1. HECHO (`e3ebb6b`): robustez del worker (una tarea en vuelo, timeout y recuperación de jobs `RUNNING` sin latido).
2. HECHO (`2595b3b`): ejecutor `packages/workspace` (contenedor aislado, allowlist, límites y limpieza).
3. HECHO (commit `feat(PLT-011): token de clonado, git aislado y job de workspace`): `GitHubOperations.cloneToken` (solo lectura, un repositorio), `git status/diff/log` en un auxiliar `alpine/git` sin red con el volumen `:ro`, y el handler `WORKSPACE_RUN` (`apps/worker/src/workspace-job.ts`, estado en `jobs.result`, no registrado en `server.ts`).
4. HECHO: paso 5 añadido (commit `ci(PLT-011): prueba del ejecutor con Docker real`): job `workspace-docker` en `.github/workflows/ci.yml` que ejecuta `packages/workspace/src/docker.integration.test.ts` con `JEV_DOCKER_TESTS=1` (aislamiento, límites, allowlist, git sin red, `main` rechazado y limpieza), imprime los digests de `node:22-alpine` y `alpine/git` y falla si quedan recursos `jev.workspace`. Pendiente: su ejecución en el CI de GitHub (no hay Docker en el entorno de desarrollo) y fijar las imágenes por digest con lo impreso.
5. HECHO (commit `fix(PLT-011): atender la revisión de Greptile (parada, reinicio, plazo y limpieza)`): 4 hallazgos de Greptile sobre `fd2ce68`, todos reales. (P1) `stop()` esperaba una sola vez y `server.ts` cerraba el pool bajo `runOnce`: ahora hay una segunda espera acotada tras abortar y los temporizadores no generan rechazos sin capturar. (P1) un reinicio con el mismo `WORKER_ID` renovaba el latido y los jobs `RUNNING` previos nunca se recuperaban: `start()` llama a `QueueService.releaseWorkerJobs` (`worker_restarted`). (P1) `taskTimeoutMs` solo se aplicaba en `exec()`: el ejecutor arma su propio temporizador desde `create()`, limita cada llamada a Docker al tiempo restante y destruye el workspace inactivo (`task_deadline_exceeded`, antes `task_timeout`). (P2) `withWorkspace` ignoraba el fallo de `destroy()`: ahora lanza `cleanup_failed` y el logger por defecto avisa. Sin migraciones ni permisos nuevos.
   Revisión de Greptile de la PR #34: https://github.com/novo34/jev-platform/pull/34#issuecomment-6945577631. Primera revisión sobre `fd2ce68` con 4 hallazgos, corregidos en `abe44e7`; la revisión de `abe44e7` dejó 2 hallazgos: (P1) `destroy(true)` reutilizaba un barrido pendiente lanzado por el plazo antes de que existiera el contenedor, y ahora espera a ese barrido y ejecuta otro completo (prueba en `packages/workspace/src/workspace.test.ts`); (P2) esta viñeta no enlazaba la revisión (corregido aquí). Corregidos en el commit `fix(PLT-011): repetir el barrido tras una creación abortada y enlazar la revisión`. No quedan hallazgos pendientes conocidos.
   Evidencia de Docker real (PLT-011): `workspace-docker` en verde con Docker real en https://github.com/novo34/jev-platform/actions/runs/44081305078 sobre `a75ab13`; Greptile 5/5 sin hallazgos en `a75ab13`; las imágenes `node:22-alpine` y `alpine/git:v2.47.2` quedan fijadas por digest en `packages/workspace/src/policy.ts` (commit `chore(PLT-011): fijar las imágenes del ejecutor por digest`), y el job las lee de ahí.

## Instrucciones para continuar en otra sesión

1. Leer este archivo y `AGENTS.md`. En ambos repositorios, inspeccionar
   `git status --short --branch`, worktrees y cambios locales. Actualizar los
   refs de GitHub con `git fetch` sin descartar cambios. Consultar el estado
   de la PR, su head, checks, comentarios, revisiones y evidencia de aceptación.
2. En Foundation, usar un checkout limpio de `origin/main` y ejecutar
   `python3 -B scripts/validate_development_control.py` y
   `python3 -B scripts/next_task.py --check`. Resolver divergencias con el backlog,
   las decisiones registradas y la evidencia exacta de GitHub antes de actuar.
3. En Platform, ejecutar
   `python3 scripts/check-progress.py --foundation ../foundation`, ajustando la
   ruta. El modo con Foundation requiere PyYAML, igual que el resolver canónico.
   El validador siempre comprueba que `platform_sha` sea antecesor de `HEAD`.
   En CI de PR, `--base` también exige que el SHA esté en el historial de la
   rama base. Al reanudar desde una rama de trabajo, verificar la integración
   con `git merge-base --is-ancestor <platform_sha> origin/main` tras
   actualizar los refs. Consultar GitHub para contrastar la evidencia con el
   SHA real de la PR.
4. En cada hito material y al finalizar la sesión, actualizar el checkpoint
   con pruebas ejecutadas, alcance de higiene, problemas, autorizaciones y
   siguiente acción. Conservar decisiones históricas en su fuente y enlazar la
   evidencia. Para CI o revisión aún en curso, registrar el estado pendiente y
   usar la PR para consultar el resultado del head. CI exige actualizar el
   checkpoint en la misma PR cuando cambian las rutas de `MILESTONE_PATHS` en
   `scripts/check-progress.py`. Una edición aislada de `docs/GITHUB_APP.md`
   queda fuera de ese control automático. CI valida el archivo sin escribirlo.

[gate]: https://github.com/novo34/base-skills_klever/blob/main/docs/JEV_MASTER_BACKLOG.md
[backlog]: https://github.com/novo34/base-skills_klever/blob/5509b2c41c8e2447cb11137bcf8630acb75a9fec/backlog/jev-master-tasks.yaml
[pr]: https://github.com/novo34/jev-platform/pull/23
[ci]: https://github.com/novo34/jev-platform/actions/runs/40024024437
[main-ci]: https://github.com/novo34/jev-platform/actions/runs/40024566808
[review]: https://github.com/novo34/jev-platform/pull/23#issuecomment-6374750357
[bot-review]: https://github.com/novo34/jev-platform/pull/23#issuecomment-6351008161
[foundation-pr]: https://github.com/novo34/base-skills_klever/pull/23
[fixture]: https://github.com/novo34/SaSS_Workee/pull/3
[audit-pr]: https://github.com/novo34/jev-platform/pull/24
[audit-ci]: https://github.com/novo34/jev-platform/actions/runs/42373205872
[audit-codex]: https://github.com/novo34/jev-platform/pull/24#issuecomment-6706268377
[audit-rabbit]: https://github.com/novo34/jev-platform/pull/24#issuecomment-6706558516
[audit-report]: https://github.com/novo34/jev-platform/blob/a3449c46f23444c85a96e6e03bab2e5effc16a30/docs/PLT010_AUDIT_REMEDIATION.md
[continuity-pr]: https://github.com/novo34/jev-platform/pull/25
[continuity-rabbit]: https://github.com/novo34/jev-platform/pull/25#pullrequestreview-5814774408
