# PROGRESO — JEV Platform

## Identificación

- Platform: `novo34/jev-platform`. Foundation: `novo34/base-skills_klever`.
- Rama de trabajo: `docs/progreso-continuidad`. Base integrada: `main`.
- Última actualización: 2026-11-07 12:25 CET. Entorno: Codex Work, Linux, clones limpios de GitHub.
- Documentación aplicable: [PRD](docs/product-specs/PRD.md), [SPEC](docs/product-specs/SPEC.md),
  [ROADMAP](docs/product-specs/ROADMAP.md) y el [Development Control Gate de Foundation][gate].

## Estado canónico del proyecto

El siguiente bloque proyecta la observación del [backlog de Foundation][backlog].
`platform_sha` identifica la base integrada verificada. El SHA de una PR se comprueba
en GitHub y se contrasta con sus checks y revisiones, ya que cambia con cada commit.

```json
{
  "foundation_sha": "209cf728d4aea9a71af52d948a33a4db309112ac",
  "platform_sha": "f86aa98107527edb27dc837882f0a9fed82ed654",
  "last_completed": {
    "task": "PLT-010",
    "status": "DONE",
    "pr": "https://github.com/novo34/jev-platform/pull/23",
    "ci": "https://github.com/novo34/jev-platform/actions/runs/40024024437",
    "review": "https://github.com/novo34/jev-platform/pull/23#issuecomment-6374750357"
  },
  "next_task": {"task": "PLT-011", "status": "TODO"},
  "requires_operator_authorization": true,
  "next_action": "Obtener revisión y CI para la PR de continuidad. Volver a resolver NEXT_TASK y esperar autorización explícita para PLT-011."
}
```

La fase es implementación controlada de Platform. PLT-009 y PLT-010 figuran como
`DONE`. No hay tarea Platform activa autorizada. Staging aceptó la integración
GitHub App el 23 de octubre de 2026 en `0882b4c661a2bd6a92bcf895cb1417981fcd565e`.
El estado actual del despliegue queda pendiente de lectura. La evidencia de
cierre corresponde a staging. El estado operativo de producción queda por verificar
si un encargo futuro lo requiere.

## Objetivo actual

Conservar un punto de reanudación verificable en Platform y corregir la documentación
que todavía presentaba PLT-010 como pendiente.

## Última sesión de desarrollo

La auditoría de continuidad encontró nueve commits publicados en la PR #23 y
confirmó la integración y reconciliación posteriores. El checkout de la sesión
anterior no estaba disponible en este entorno. Se comparó el árbol integrado
con el último head publicado y no hubo diferencias. Esta sesión añade documentación,
instrucciones y un control al CI existente. El resultado de esta PR se consulta
en sus propios checks y en la revisión anclada al SHA.

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
- [PR de continuidad][continuity-pr]. Sus checks y revisión son la evidencia
  del SHA publicado para este cambio de mantenimiento.

## Problemas detectados

El README y el runbook de GitHub App conservaban advertencias previas a la
aceptación e integración. El resumen del bot de Codex para el head final de
PR #23 no contiene un recibo final. La revisión técnica independiente tiene
registro separado.

## Problemas resueltos

PLT-010 filtró campos sensibles de las respuestas de GitHub, solicitó
`statuses: read` para observar estados y serializó la autorización para
proteger las mutaciones concurrentes. El README y el runbook enlazan ahora
al cierre canónico y a la evidencia.

## Trabajo pendiente

Completar CI y revisión independiente de la PR de continuidad. Si esa revisión
detecta hallazgos, corregirlos en la misma rama y verificar de nuevo el SHA.
La preparación de PLT-011 queda a la espera de autorización explícita.

## Bloqueos y dependencias

El Development Control Gate identifica PLT-011 como siguiente elegible. Su
inicio depende de la autorización del operador. El CI de Platform comprueba
el formato y las referencias declaradas de este documento con el checkout
local. La reconciliación con Foundation y la vigencia de la evidencia de
GitHub se comprueban al preparar el handoff y al reanudarlo.

## Decisiones y autorizaciones

El modo `single_operator` se autorizó para el ensayo del 23 de octubre con
verificación técnica independiente, aprobación humana exacta y protección
de rama. Su alcance está en el [runbook](docs/GITHUB_APP.md#merge-policy).
El backlog sigue siendo la autoridad. El cambio de continuidad reutiliza
NEXT_TASK, CI y los registros de decisiones y evidencias existentes. Se tramita
como mantenimiento de repositorio porque PR #23 ya se fusionó y su integración
quedó cerrada en Foundation.

## Higiene del repositorio

El alcance de continuidad abarca el validador, su única llamada desde el CI,
instrucciones y documentación. No añade dependencias al producto. La búsqueda
de equivalentes incluyó Platform y las skills canónicas 29, 57, 58, 91 y 92.
El validador reutiliza NEXT_TASK y aplica un escaneo limitado a patrones comunes
de credenciales. Se conserva la revisión histórica de higiene de PLT-010 en el
[runbook](docs/GITHUB_APP.md#technical-checks-and-hygiene). Las referencias
dinámicas requieren inspección de sus consumidores antes de proponer borrados.

## Siguiente paso exacto

1. Acción autorizada: revisar el SHA publicado de `docs/progreso-continuidad`.
   Inspeccionar `PROGRESO.md`, `AGENTS.md`, `scripts/check-progress.py` y
   `.github/workflows/ci.yml`. Ejecutar el validador con Foundation, revisar el
   diff y comprobar el CI y la revisión independiente de ese SHA.
2. PLT-011 es el siguiente candidato y requiere autorización. Una vez autorizada,
   inspeccionar su entrada canónica, la [cola y el worker](docs/QUEUE_WORKER.md),
   `apps/worker` y el contrato de workspaces en Foundation. El alcance de prueba
   incluye creación y limpieza del contenedor, límites y aislamiento, comandos
   permitidos y regresión completa. La evidencia exacta se acuerda con el
   contrato canónico de esa tarea.
3. Conservar el cierre de PLT-010. Mantener bloqueados el inicio de PLT-011
   sin autorización, el merge, los despliegues y las nuevas instalaciones reales
   fuera de las aprobaciones aplicables.

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
   El modo sin Foundation valida estructura, SHA integrado, referencias y
   patrones comunes de credenciales. Los resultados de GitHub requieren lectura
   aparte. Comparar la evidencia publicada con el SHA real de la PR.
4. En cada hito material y al finalizar la sesión, actualizar el checkpoint
   con pruebas ejecutadas, alcance de higiene, problemas, autorizaciones y
   siguiente acción. Conservar decisiones históricas en su fuente y enlazar la
   evidencia. Para CI o revisión aún en curso, registrar el estado pendiente y
   usar la PR para consultar el resultado del head. CI exige la actualización
   en la misma PR para cambios materiales y valida el archivo sin escribirlo.

[gate]: https://github.com/novo34/base-skills_klever/blob/main/docs/JEV_MASTER_BACKLOG.md
[backlog]: https://github.com/novo34/base-skills_klever/blob/209cf728d4aea9a71af52d948a33a4db309112ac/backlog/jev-master-tasks.yaml
[pr]: https://github.com/novo34/jev-platform/pull/23
[ci]: https://github.com/novo34/jev-platform/actions/runs/40024024437
[main-ci]: https://github.com/novo34/jev-platform/actions/runs/40024566808
[review]: https://github.com/novo34/jev-platform/pull/23#issuecomment-6374750357
[bot-review]: https://github.com/novo34/jev-platform/pull/23#issuecomment-6351008161
[foundation-pr]: https://github.com/novo34/base-skills_klever/pull/23
[fixture]: https://github.com/novo34/SaSS_Workee/pull/3
[continuity-pr]: https://github.com/novo34/jev-platform/pulls?q=is%3Apr+head%3Adocs%2Fprogreso-continuidad
