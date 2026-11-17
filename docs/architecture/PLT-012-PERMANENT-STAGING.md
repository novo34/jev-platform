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
| UNKNOWN | READY (sin despliegue previo) |
| DEPLOYING | RUNNING |
| READY | VERIFIED (tras health y E2E; VERIFYING mientras se ejecutan) |
| FAILED | FAILED |
| DEGRADED | BLOCKED (REJECTED si la verificación lo rechaza explícitamente) |

El mapeo exacto se fija con pruebas en el paso 4; los vocabularios difieren y es un riesgo conocido.

### Operación GitHub de integración

Nueva operación controlada que integra la rama de la tarea en `staging_branch`: exige las aprobaciones y el estado de la tarea, el SHA exacto y es idempotente. Rechaza `main`, `master` y la rama de producción. Reutiliza las guardas de PLT-010.

## Riesgos y mitigaciones

* **Recursos del VPS:** disco limitado (skill 46 de Foundation). Límites de CPU/RAM por servicio y nunca `docker system prune -a --volumes`.
* **Clave de cifrado:** la clave que protege la API key no se puede regenerar; su pérdida obliga a reemitir credenciales. Se documenta su custodia antes del paso real.
* **Alcance de la API key de Dokploy:** puede ser más amplio que un proyecto; se usa solo desde el worker y se valida el alcance real contra la instancia.
* **Aislamiento entre proyectos:** un Compose, una red interna y un volumen por proyecto; sin credenciales compartidas.
* **Vocabularios de estado:** ver el mapeo; se prueba cada transición.
* **Autorización:** registrar la autorización de PLT-012 en el backlog de Foundation al cierre (patrón de tareas anteriores).

## Pruebas

* CI con Dokploy simulado (servidor HTTP falso).
* PostgreSQL efímero para el escritor de deployments y los triggers.
* Operación GitHub con transporte simulado.
* Prueba real (R4) en el paso de Espacore.

## Plan de entrega

1. Diseño (este documento).
2. Operación GitHub de integración en `staging_branch`.
3. Adaptador Dokploy + plantilla de Compose.
4. Orquestador + job `STAGING_DEPLOY` + deployments controlados.
5. Pruebas de CI.
6. Paso real con Espacore (aprobación del operador, R4).
