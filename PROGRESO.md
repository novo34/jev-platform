# PROGRESO — JEV Platform

## Identificación

- Platform: `novo34/jev-platform`. Foundation: `novo34/base-skills_klever`.
- Rama de trabajo: `claude/elegant-turing-c9wz23`. Base integrada: `main`.
- Última actualización: 2026-11-17. Entorno: Claude Code en la nube (Linux), verificación remota de GitHub.
- Documentación aplicable: [PRD](docs/product-specs/PRD.md), [SPEC](docs/product-specs/SPEC.md),
  [ROADMAP](docs/product-specs/ROADMAP.md) y el [Development Control Gate de Foundation][gate].

## Estado canónico del proyecto

El siguiente bloque proyecta la observación del [backlog de Foundation][backlog].
`platform_sha` identifica la base integrada verificada. El SHA de una PR se comprueba
en GitHub y se contrasta con sus checks y revisiones, ya que cambia con cada commit.

```json
{
  "foundation_sha": "828af46aace249e9a3c83a835215be5fcb2bd446",
  "platform_sha": "e7302aeaba761c033104c7692ed510746476ef89",
  "last_completed": {
    "task": "PLT-051",
    "status": "DONE",
    "pr": "https://github.com/novo34/jev-platform/pull/30",
    "ci": "https://github.com/novo34/jev-platform/actions/runs/43949674151",
    "review": "https://github.com/novo34/jev-platform/pull/30#issuecomment-6920931740"
  },
  "next_task": {
    "task": "PLT-011",
    "status": "TODO"
  },
  "requires_operator_authorization": true,
  "next_action": "Implementar PLT-011 según docs/architecture/PLT-011-WORKSPACE-ENGINE.md, empezando por la robustez del worker."
}
```

La fase es implementación controlada de Platform. PLT-009 y PLT-010 figuran como
`DONE`. PLT-050 y PLT-051 están DONE en Foundation (PLT-051 en el PR #26, `828af46`). PLT-051 está fusionado en Platform ([PR #30](https://github.com/novo34/jev-platform/pull/30)) y aceptado en JEV Staging el 17 de noviembre de 2026. El operador autorizó el 2026-11-17 iniciar PLT-011 (Real Docker Workspace Worker); NEXT_TASK la seleccionó en Foundation `828af46`. Fase actual: diseño aprobado por el operador; implementación en curso. Staging aceptó la integración
GitHub App el 23 de octubre de 2026 en `0882b4c661a2bd6a92bcf895cb1417981fcd565e`.
La remediación de [PR #24][audit-pr] se verificó en staging mediante un merge
autorizado con informe independiente firmado. El alcance de esta aceptación
fue el entorno de pruebas y el repositorio de aceptación.

## Objetivo actual

Conservar un punto de reanudación verificable en Platform y distinguir el cierre histórico
de PLT-010 de la aceptación operativa de su remediación de seguridad.

## Última sesión de desarrollo

JEV Staging ejecutó `ba18d4f8e54375eaea9533a8ea385d74c2ef0649`.
Dokploy mostró el migrador con código de salida 0 y la API healthy. La sesión
se recuperó mediante un restablecimiento manual. La pérdida de sesión al recargar
y la recuperación por correo quedaron identificadas como trabajo pendiente.

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

## Problemas resueltos

PLT-010 filtró campos sensibles de las respuestas de GitHub, solicitó
`statuses: read` para observar estados y serializó la autorización para
proteger las mutaciones concurrentes. El README remite a este checkpoint.
[PR #24][audit-pr] añadió una atestación Ed25519 ligada al ciclo de
verificación y a la PR/SHA, endurece ACL y registros con las migraciones
0025/0026 y corrige el runbook.

## Trabajo pendiente

PLT-051 implementa solicitud y formulario, tokens de un solo uso, revocación transaccional y envío configurable con Resend. Está fusionado en `main` en `2d29785`. El operador configuró el dominio `notificaciones.nuvurent.com` en Resend, sin seguimiento de enlaces, y las variables `JEV_STAGING_RESET_*` en Dokploy. La aceptación en staging está comprobada (17 de noviembre de 2026). El cierre en Foundation está completado. Queda la autorización de PLT-011 y, como mejora opcional de UX, validar el enlace de recuperación al abrirlo.

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

El 17 de noviembre de 2026 el operador decidió para PLT-011 (ver [diseño](docs/architecture/PLT-011-WORKSPACE-ENGINE.md)): (1) el ejecutor se prueba con Docker real en el CI de GitHub y no se activa en JEV Staging; su activación en un servidor o VM dedicado es posterior; (2) el ejecutor clona fuera del contenedor, que tiene red solo durante `npm ci` y después `--network none`; (3) límites por defecto de 1 CPU, 2 GB de RAM, 256 procesos, 15 min por comando y 60 min por tarea; (4) sin retención: el workspace se destruye siempre al terminar.

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

1. Robustez del worker: una tarea en vuelo, timeout por tarea y recuperación de jobs `RUNNING` sin latido.
2. Ejecutor `packages/workspace`: contenedor aislado, allowlist, límites y limpieza.
3. Token de instalación acotado y job de workspace.
4. Prueba Docker real en el CI (aislamiento, límites, allowlist, rechazo de `main`, limpieza).

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
[backlog]: https://github.com/novo34/base-skills_klever/blob/828af46aace249e9a3c83a835215be5fcb2bd446/backlog/jev-master-tasks.yaml
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
