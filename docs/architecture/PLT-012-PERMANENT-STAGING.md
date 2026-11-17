# PLT-012 — Motor de staging permanente

Este documento fija el diseño de PLT-012 (Permanent Staging Engine). Riesgo: **R3** para el motor (aislamiento, credenciales, arquitectura) y **R4** para cualquier ejecución real sobre el VPS, el DNS o una base de datos persistente, con aprobación humana explícita en cada paso. Que el CI pase demuestra el motor contra un Dokploy simulado, **no** que exista un staging real.

## Objetivo y criterios

Criterios del backlog de Foundation (`backlog/jev-master-tasks.yaml`, PLT-012):

* Cada proyecto activo puede tener staging permanente.
* La rama de staging se despliega online.
* La BD de staging está separada de producción.
* Migraciones, seeds, health checks y E2E online se ejecutan.
* El staging permanece tras completar la tarea.

Referencias: SPEC §16 REQ-STG-001..012 (`docs/product-specs/SPEC.md`), ROADMAP Fase 22 y el contrato FND-026 de Foundation: `staging/adapter.py` (`StagingProviderAdapter`: `deploy`, `verify_database`, `apply_migrations`, `seed_test_data`, `health_check`, `run_online_e2e`), `staging/provider_policy.py` y `staging/provider_service.py` (orden deploy → database → migrations → seed → health → e2e).

## Decisiones del operador (2026-11-17)

1. **Alcance por fases:** primero el motor, probado en CI con un Dokploy simulado. Después, como paso aparte y aprobado por el operador (R4), el staging real del primer proyecto (Espacore) en el servidor. PLT-012 se cierra con esa evidencia real.
2. **Proveedor:** API de Dokploy (`POST /api/compose.create`, `compose.saveEnvironment`, `domain.create` con `certificateType` letsencrypt, `compose.deploy`/`redeploy`, lectura de estado; autenticación `x-api-key`), detrás del contrato neutral de FND-026. La API exacta (cuerpos y respuestas) se verifica contra la instancia antes del paso real.
3. **Base de datos:** un contenedor PostgreSQL propio por proyecto, con volumen propio, dentro del Compose del staging del proyecto. Roles owner/runtime separados al estilo PLT-008. Nunca credenciales ni datos de producción.
4. **Ramas:** nueva operación de GitHub controlada que integra la rama de la tarea en `staging_branch` del repositorio, con las mismas guardas que PLT-010 (aprobaciones/estado de la tarea, SHA exacto, idempotencia, nunca a `main`/`master`/producción). El staging se redespliega desde `staging_branch` y permanece.

## Valores por defecto propuestos (pendientes de confirmar por el operador antes del paso real)

* Dominio `<slug-proyecto>.staging.nuvurent.com` con TLS de Let's Encrypt vía Dokploy.
* La API key de Dokploy se guarda cifrada en Platform (mismo patrón que las credenciales de proveedor de PLT-009) y solo la usa el worker, nunca la API HTTP.
* Migraciones automáticas en cada despliegue, con copia de seguridad previa del volumen de la BD de staging.
* Seeds solo sintéticos (REQ-STG-009).
* E2E online mínimo contra la URL pública (health + flujo básico).

## Arquitectura propuesta

### Paquete `packages/staging`

* **Adaptador Dokploy:** cliente HTTP con timeouts que implementa la interfaz neutral de FND-026. No registra secretos (la `x-api-key` se redacta de cualquier salida).
* **Plantilla de Compose por proyecto:** app + postgres, con límites de recursos. La red `dokploy-network` solo para el servicio web; la BD en red interna, sin puertos publicados.
* **Orquestador:** sigue el orden de FND-026 (deploy → database → migrations → seed → health → e2e).

### Deployments controlados

El orquestador produce deployments mediante el escritor controlado existente `jev_create_deployment`/`jev_set_deployment_status`, sin DML directo. Respeta los triggers de `0016`, que exigen un deployment staging `READY` para pasar a `AWAITING_HUMAN`.

### Worker

Job de cola `STAGING_DEPLOY` (patrón de `WORKSPACE_RUN`), sin activar por defecto.

### Mapeo de estados

| Foundation | Platform |
| --- | --- |
| UNKNOWN | BLOCKED (nunca READY) |
| DEPLOYING | RUNNING |
| READY | READY |
| FAILED | FAILED |
| DEGRADED | BLOCKED |

`READY` se mapea a `READY` porque es el estado de deployment staging que los triggers de `0016` exigen para pasar la tarea a `AWAITING_HUMAN`; un estado desconocido o degradado nunca puede ser `READY`. `VERIFYING`/`VERIFIED` quedan para la fase de verificación (PLT-015). El mapeo exacto se fija con pruebas en el paso 4; los vocabularios difieren y es un riesgo conocido.

### Operación GitHub de integración

Implementada (paso 2): acción `GITHUB_INTEGRATE_STAGING` `{taskId, headSha}`, `project:admin` y rol ADMIN vigente, expuesta por el endpoint genérico de comandos de `apps/api` (sesión, rol y CSRF como las demás). Usa la Merges API (`base`=`staging_branch`, `head`=SHA exacto) con token de instalación `contents: write` de un solo repositorio. Solo se permite con la tarea en `VERIFIED` (los triggers de `0016` exigen un deployment staging `READY` para pasar a `AWAITING_HUMAN`, así que la rama debe llegar a staging antes), con la rama de la tarea en GitHub exactamente en `headSha` y con la verificación técnica firmada del ciclo vigente ligada a ese SHA; no exige aprobación humana, que se concede tras revisar el staging. Rechaza `default_branch`, `main`, `master`, `production`, `prod`, la propia rama de la tarea y un `staging_branch` vacío. Idempotente por hash de petición en el ledger `github_operations`; 409/422 es `GITHUB_CONFLICT` sin reintento. La migración `0028` solo añade la acción a la lista del trigger del ledger (sin tablas, columnas, roles ni GRANTs).

## Implementación del adaptador

Implementada (paso 3) en `packages/staging` (`@jev/staging`), probada solo contra un Dokploy simulado (servidor HTTP local en `src/mock-dokploy.ts`), sin worker ni base de datos.

* **Cliente** (`client.ts`, `errors.ts`, `sanitize.ts`): `fetch` con timeout, `redirect: 'error'`, base `https` (http solo en loopback), `x-api-key` redactada de errores y eventos. `DokployError` con códigos `unauthorized`, `not_found`, `conflict`, `rate_limited`, `upstream`, `timeout`, `invalid_response`; las respuestas usadas se validan de forma estricta.
* **Mapeo aislado** (`mapping.ts`): único lugar que conoce nombres de endpoint, cuerpos y campos de Dokploy.
* **Política** (`policy.ts`): equivalente TypeScript de `provider_policy.py` (tipo de entorno, ramas no productivas `main`/`master`/`production`/`prod` y las protegidas, ramas distintas, `staging_url` https bajo `<slug>.staging.<dominio base>`, `database_ref` y `secret_refs` en allowlist). Una violación lanza `StagingPolicyError` antes de cualquier llamada a Dokploy.
* **Adaptador** (`adapter.ts`): contrato FND-026 (`deploy`, `verifyDatabase`, `applyMigrations`, `seedTestData`, `healthCheck`, `runOnlineE2E`). Nombre determinista `jev-stg-<slug>`; busca el compose por `appName` en el entorno de Dokploy y lo reutiliza; nunca borra. Orden de la creación inicial: `compose.create` (con el fichero generado), `compose.saveEnvironment`, `domain.create` (`letsencrypt`, https, servicio `app`), `compose.deploy`; en repeticiones solo `compose.update` si la plantilla cambia, `saveEnvironment` si cambian las variables, y `compose.redeploy`. Las contraseñas de BD ya guardadas se conservan (nunca se rotan al repetir). Un dominio existente con otro certificado, servicio o puerto falla con conflicto.
* **Variables** (`env.ts`): `DATABASE_URL` (rol runtime) y `DATABASE_OWNER_URL` (rol owner, solo para migraciones) apuntan al servicio `db` del propio Compose. Se rechazan nombres `PROD_*`/`*_PRODUCTION`, valores con marcadores de producción configurados, cualquier URL de datastore que no apunte a `db` y la sobrescritura de variables reservadas. Los valores de `secret_refs` (permitidos) salen de `secretValues`; los secretos solo viven en el entorno de Dokploy, nunca en el fichero Compose ni en los resultados.

## Implementación del orquestador

Implementada (paso 4). Sin migraciones ni permisos nuevos de BD: solo se usan `jev_create_environment`, `jev_create_deployment` y `jev_set_deployment_status` ya concedidos a `jev_runtime`, más el `SELECT` existente.

* **Orquestador** (`packages/staging/src/orchestrator.ts`): ejecuta `deploy`, `verifyDatabase`, `applyMigrations`, `seedTestData`, `healthCheck`, `runOnlineE2E` en ese orden y se detiene en la primera etapa que no pasa. Devuelve evidencia por etapa (`status`, `detail`, `metadata`, `durationMs`) saneada con `sanitizeText` (más los secretos concretos inyectados), con límites de tamaño. Las etapas no ejecutadas figuran como `not_run`. Respeta el `AbortSignal`: comprueba antes de cada etapa y abandona la etapa en curso (el adaptador no tiene señal propia: una llamada ya enviada a Dokploy puede terminar en segundo plano).
* **Decisión de estado** (`decideOutcome`, función pura): `READY` solo con las seis etapas `passed`; una etapa `failed` da `FAILED` (incluida una violación de política, determinista); una excepción, un resultado no válido, un resultado marcado `metadata.degraded === true`, una cancelación o evidencia incompleta dan `BLOCKED`. Etapas con `skipped: true` (sin comando de migración/seed) cuentan como `passed` y quedan visibles en la evidencia.
* **Registro de deployments** (`deployments.ts`): `PgDeploymentRegistry` busca el entorno `kind='staging'` del repositorio o lo crea con `createEnvironment` (nuevo wrapper en `packages/db/src/review-write.ts` sobre `jev_create_environment`, nombre `staging`; tolera la carrera con 23505). Crea el deployment `RUNNING` con `url` = `staging_url` y `revision` = SHA ya definitivos (`jev_set_deployment_status` solo cambia el estado) y lo cierra con `setDeploymentStatuses` a `READY`/`FAILED`/`BLOCKED`. Cada ejecución crea un deployment nuevo, de modo que el último por `insertion_seq` (regla de `0016`) refleja siempre la última ejecución: un fallo posterior invalida un `READY` anterior para `AWAITING_HUMAN`. Si falla el cierre del estado, el error se propaga (nada se supone sin estado registrado). Limitación: un job que muere a mitad deja su deployment `RUNNING` hasta la siguiente ejecución, que lo supera por orden de inserción.
* **Configuración del proyecto** (`project-config.ts`): `loadProjectStagingConfig` lee `repositories` (`full_name`, `default_branch`, `staging_url`, `staging_branch`, `staging_database_enabled`) y la rama de la tarea (`tasks.branch_name`, por defecto `feat/jev-<taskId>`), exige base de datos de staging habilitada, rama y URL, y deriva `databaseRef` = `<slug>_staging`. El resto (`stagingBaseDomain`, entorno de Dokploy, comandos de migración/seed, ruta de salud, rutas E2E, `secretRefs`/`secretValues`, imagen y puerto) es `StagingDeploymentSettings`, configuración del despliegue del job y no de la BD. La API key de Dokploy **no** se guarda en la BD en este paso: se inyecta construyendo el `DokployClient` en el worker (variable de entorno). Su almacenamiento cifrado (patrón PLT-009) y la configuración por proyecto de `StagingDeploymentSettings` se deciden en la activación (paso 6).
* **Job `STAGING_DEPLOY`** (`apps/worker/src/staging-job.ts`): payload estricto `{ projectId, repositoryId, taskId, revision }` (UUID y SHA de 40 hex). Dependencias inyectadas (`configProvider`, `adapterFactory`, `registry`, `redact`). `READY` y `FAILED` completan el job con la evidencia saneada en `jobs.result`; `BLOCKED` (incluida la cancelación) y los errores de infraestructura lanzan para que el runtime llame a `queue.fail` con un mensaje saneado. No está registrado en `server.ts`. Activación: construir `DokployClient` con la API key y la URL de Dokploy, `createDokployAdapterFactory(client)`, `PgDeploymentRegistry(pool)` y un `configProvider` basado en `loadProjectStagingConfig`, y fusionar `stagingHandlers(deps)` en `WorkerRuntimeOptions.handlers`. Requiere API key de Dokploy y dominio base configurados y la aprobación R4 del paso 6.

### Decisión: base de datos en el Compose del proyecto

Se incluye PostgreSQL en la plantilla de Compose (`compose-template.ts`) y no como servicio de base de datos de Dokploy (`postgres.create`). Motivos: coincide con la decisión 3 del operador; un único recurso idempotente por proyecto (compose, red interna y volumen con un solo nombre determinista, sin segunda búsqueda/estado que reconciliar); red `internal: true` sin puertos publicados y solo la app en `dokploy-network`; roles owner/runtime creados por un script de inicialización; límites de CPU/RAM por servicio. Contrapartida: las copias de seguridad del volumen quedan a nuestro cargo (pendiente antes del paso real).

### Decisión: migraciones y seeds

El adaptador no ejecuta SQL. Las migraciones y seeds son comandos del proyecto (`migrationCommand`, `seedCommand`) que la plantilla ejecuta como servicios de una sola vez (`migrate`, `seed`, con el rol owner y `STAGING_SEED_SYNTHETIC_ONLY=1`) y de los que depende la app (`service_completed_successfully`). Por eso un despliegue `done` demuestra que terminaron bien; `applyMigrations`/`seedTestData` lo comprueban y, si no hay comando configurado, devuelven `ok` con `metadata.skipped: true` (no se ha ejecutado nada). La copia previa del volumen y el estado de migraciones (`CURRENT`/`PENDING`) no están implementados. `healthCheck` es un GET a la URL pública (2xx, timeout, sin redirecciones) y `runOnlineE2E` es health más rutas configurables (estado 2xx y texto opcional).

### Integridad de la revisión desplegada

El deployment `READY` (que habilita `AWAITING_HUMAN` y la aprobación ligada a la revisión) debe describir el código realmente desplegado. Construir desde la rama permitiría que, al avanzar `staging_branch`, el registro y lo desplegado divergieran. Reglas:

1. **Build desde el SHA exacto.** `revision` (40 hex; el orquestador la normaliza a minúsculas y la inyecta en la petición, `requireRevision` en `policy.ts`) fija `build.context` de `app`, `migrate` y `seed` a `https://github.com/<repo>.git#<sha40>`. Ausente o inválida: el orquestador lanza `StagingPolicyError` antes de registrar ningún deployment, y `deploy` y la plantilla la rechazan igualmente (la plantilla rechaza también un contexto que no termine en `#<revision>`).
2. **`appImage` solo con digest.** Una imagen sin `@sha256:<64 hex>` se rechaza (`app_image_digest_required`, sin llamadas a Dokploy). Aun con digest, una imagen no prueba de qué commit procede: si la ruta de salud no informa la revisión, la etapa queda `degraded` y la ejecución en `BLOCKED` (nunca `READY`).
3. **Comprobación contra la integración (responsabilidad del job, vía elegida).** No se añade una llamada a GitHub al paquete. El job `STAGING_DEPLOY` exige que `payload.revision` sea igual al `sha` que `GITHUB_INTEGRATE_STAGING` devolvió y dejó en el ledger `github_operations` para esa tarea (último `SUCCESS`, `loadIntegratedRevision`, solo SELECT, sin migraciones ni permisos nuevos). Si no hay integración o no coincide, el job falla con `revision_not_integrated` antes de cargar configuración o registrar nada. Que `staging_branch` siga apuntando a ese SHA lo garantiza la integración; como el build está fijado al SHA, el código desplegado coincide con lo registrado aunque la rama avance después.
4. **`JEV_STAGING_REVISION=<sha>`** (no secreto) se añade a las variables de Dokploy y se escribe literal en el entorno de `app`, `migrate` y `seed`. No puede sobrescribirse con `extraEnv` ni `secretRefs`.
5. **Health/E2E.** Si la ruta de salud devuelve la revisión (cabecera `x-jev-staging-revision` o campo JSON `revision`/`JEV_STAGING_REVISION`), debe coincidir: una revisión distinta da `*_revision_mismatch` y la etapa `failed`, es decir deployment `FAILED` (definitivo: el código en ejecución no es el registrado). Si no la devuelve se registra `revisionCheck: "unverifiable"` en la evidencia sin bloquear (con `appImage`, `degraded` y por tanto `BLOCKED`). VERIFY-R4: confirmar con Espacore que su ruta de salud expone la revisión.

### Pendiente de verificar contra la instancia real (antes del paso R4)

Todo lo marcado `VERIFY-R4` en `mapping.ts` y `compose-template.ts`:

1. Búsqueda de composes existentes: `GET environment.one?environmentId=` y su campo `compose`/`composes` (si no existe, usar `project.all`).
2. Cuerpo exacto de `compose.create` (`sourceType: 'raw'`, `composeFile`), `compose.update` y `compose.saveEnvironment` (se asume `{composeId, env}` con líneas `KEY=VALUE`).
3. `domain.create`: si exige `domainType: 'compose'`; forma de la respuesta de `domain.byComposeId` y de `compose.one` (`composeStatus` con `idle|running|done|error`).
4. Si `compose.deploy` deja `composeStatus` en `running` de forma síncrona (si no, la lectura inmediata puede ver el estado anterior) y qué devuelve un despliegue fallido.
5. Origen del código: el Compose usa `build.context` con URL Git fijada al SHA exacto de la revisión (`https://github.com/<repo>.git#<sha40>`, Docker admite un commit como ref; nunca la rama); los repositorios privados necesitan credenciales (alternativa: `appImage` o origen GitHub de Dokploy con `composePath`). Ver «Integridad de la revisión desplegada».
6. Compatibilidad del Compose del host con `configs.content` (script de roles) y con `deploy.resources.limits`; nombre real del volumen y de la red tras el prefijo de Dokploy.
7. Alcance de la API key y códigos de error reales (401/403 y `retry-after`).
8. La conexión real a la BD y el estado de migraciones solo se prueban con la ruta de salud del proyecto; falta el comprobador de conexión.

## Riesgos y mitigaciones

* **Recursos del VPS:** disco limitado (skill 46 de Foundation). Límites de CPU/RAM por servicio y nunca `docker system prune -a --volumes`.
* **Clave de cifrado:** la clave que protege la API key no se puede regenerar; su pérdida obliga a reemitir credenciales. Se documenta su custodia antes del paso real.
* **Alcance de la API key de Dokploy:** puede ser más amplio que un proyecto; se usa solo desde el worker y se valida el alcance real contra la instancia.
* **Aislamiento entre proyectos:** un Compose, una red interna y un volumen por proyecto; sin credenciales compartidas.
* **Vocabularios de estado:** ver el mapeo; se prueba cada transición.
* **Autorización:** registrar la autorización de PLT-012 en el backlog de Foundation al cierre (patrón de tareas anteriores).

## Pruebas

* CI con Dokploy simulado (servidor HTTP falso).
* PostgreSQL efímero para el escritor de deployments y los triggers (`packages/staging/src/deployments.test.ts`: READY con `url` y revisión exactas, FAILED/BLOCKED sin acceso a `AWAITING_HUMAN`, un fallo posterior supera a un READY anterior).
* Operación GitHub con transporte simulado.
* Prueba real (R4) en el paso de Espacore.

## Plan de entrega

1. Diseño (este documento).
2. Operación GitHub de integración en `staging_branch`.
3. HECHO: adaptador Dokploy + plantilla de Compose (`packages/staging`).
4. HECHO: orquestador + job `STAGING_DEPLOY` + deployments controlados (ver «Implementación del orquestador»).
5. Pruebas de CI.
6. Paso real con Espacore (aprobación del operador, R4).
