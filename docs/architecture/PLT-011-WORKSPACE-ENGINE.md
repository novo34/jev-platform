# PLT-011 — Motor de workspaces Docker real

Este documento fija el diseño de PLT-011 (Real Docker Workspace Worker). Riesgo: **R3** (credenciales, aislamiento y ejecución de código). Que el CI pase demuestra el comportamiento en Docker del runner de GitHub, **no** que el ejecutor esté activo en JEV Staging.

## Objetivo y criterios

Criterios del backlog:

* Contenedor aislado por tarea, escribible.
* Clona el repositorio y la rama asignados.
* Instala dependencias y ejecuta comandos de una allowlist.
* CPU, RAM, red y tiempos impuestos.
* Secretos acotados y limpieza garantizada.

Referencias: SPEC REQ-WSP-001..010 (`docs/product-specs/SPEC.md` §14) y el contrato de Foundation `workspaces/engine-contract.yaml`.

## Decisiones del operador (2026-11-17)

* **Ubicación:** el ejecutor se implementa y se prueba con Docker real en el CI de GitHub. No se activa en el servidor de JEV Staging; su activación en un servidor o VM dedicado es una tarea posterior.
* **Red:** el ejecutor clona el repositorio fuera del contenedor de la tarea. El contenedor tiene red solo durante la instalación de dependencias (`npm ci`) y queda sin red (`--network none`) para test, build y lint.
* **Límites por defecto:** 1 CPU, 2 GB de RAM, 256 procesos, 15 min por comando, 60 min por tarea.
* **Retención:** ninguna en PLT-011. El workspace se destruye siempre al terminar (éxito, fallo, timeout o cancelación).

## Arquitectura

### Ejecutor separado

`packages/workspace` es el único componente con acceso a Docker. El worker le pide operaciones tipadas (crear, ejecutar comando de la allowlist, destruir) y nunca construye comandos de Docker ni de shell libres.

### Contenedor por tarea

* Imagen Node fijada por digest o tag inmutable.
* Usuario no root, `--cap-drop ALL`, `--security-opt no-new-privileges`.
* `--read-only`, con tmpfs o volumen solo para el directorio de trabajo.
* `--pids-limit`, `--cpus` y `--memory` (sin swap extra).
* Etiquetas `jev.task=<id>` y `jev.workspace=<id>`.
* Sin socket de Docker montado y sin secretos de producción.
* Un workspace escribible por tarea (REQ-WSP-002).

### Limpieza

Destrucción en `finally`. Al arrancar, el ejecutor barre contenedores y volúmenes huérfanos con la etiqueta `jev.workspace`.

### Comandos

Allowlist cerrada y exacta, sin argumentos libres: `npm ci`, `npm test`, `npm run build`, `npm run lint`, `git status`, `git diff`, `git log`. Se ejecutan sin shell (argv). Cada comando se registra con código de salida, duración y salida truncada y saneada (REQ-WSP-008).

### GitHub

* La API emite un token de instalación temporal limitado a un repositorio (`packages/control/src/github-app.ts`). El worker nunca recibe la clave de la App.
* El token se pasa por stdin o archivo temporal, nunca por argv ni logs, y se redacta de cualquier salida.
* La rama asignada se valida con las reglas existentes (`assertTaskBranch`) y nunca es `main` ni `master`. El push solo a la rama asignada lo garantiza JEV, porque el token de GitHub no limita ramas.
* Las credenciales de producción nunca entran (REQ-WSP-005).

### Robustez del worker

Una tarea en vuelo por worker, timeout por tarea y recuperación de jobs `RUNNING` cuyo worker dejó de latir.

### Estado

En `task_runs.metadata`. Sin tabla nueva ni escritor controlado nuevo, respetando PLT-008.

## Pruebas

* Unitarias con adaptador Docker simulado.
* Job de CI opt-in con Docker real que demuestra: aislamiento (sin root, sin capacidades, sin red tras instalar), límites, rechazo de comandos fuera de la allowlist, rechazo de `main` y limpieza (sin contenedores con la etiqueta tras terminar, incluso con fallo).

## Implementación del ejecutor

`@jev/workspace` (paso 3). API:

* `SpawnDockerCli` (`spawn('docker', args, { shell: false })`, timeout que mata el proceso, salida acotada) y `FakeDockerCli` para pruebas, ambos tras la interfaz `DockerCli`.
* `new WorkspaceExecutor({ docker, image?, gitImage?, limits? })`: `create(spec)` devuelve un `Workspace` con `install()`, `run(command)`, `records` y `destroy()`; `withWorkspace(spec, fn)` destruye siempre en `finally`; `sweepOrphans()` elimina contenedores y volúmenes con la etiqueta `jev.workspace` (solo al arrancar).
* `spec = { taskId, repoFullName, branch, token, signal? }`. Límites, imagen y allowlist son constantes del operador (`policy.ts`), nunca valores del job. La rama se valida con una réplica de `assertTaskBranch` (una prueba la compara con la de `@jev/control`).
* Clonado: contenedor auxiliar efímero con `alpine/git` (`node:22-alpine` no trae git), con red. El token entra solo por stdin; un `credential.helper` en línea lo lee de una variable del proceso del auxiliar. No hay token en argv, en el `env` de `docker run`, en archivos ni en la URL del remoto. El auxiliar corre como root con `--cap-drop ALL` y solo CHOWN/DAC_OVERRIDE/FOWNER para dejar el volumen en 1000:1000.
* `install()` ejecuta `npm ci` con red bridge, desconecta toda red y lo verifica con `docker inspect`; si falla, destruye y lanza `network_disconnect_failed`. `run()` exige instalación correcta. Un timeout de comando destruye el contenedor (el proceso del `exec` podría sobrevivir al cliente) y un `AbortSignal` o el plazo total de la tarea también.

Paso 4 (token, git y job):

* `GitHubOperations.cloneToken(projectId, repoFullName)` / `GitHubAppClient.cloneToken(scope)` emiten un token de instalación de un solo repositorio con `{ contents: "read" }`, reutilizando las validaciones de `token()` (caducidad, alcance, permisos exactos). El repositorio debe estar registrado en el proyecto activo y vinculado a una instalación de su organización. Devuelve `{ token, expiresAt }` y nunca se registra.
* `git status|diff|log` no corren en el contenedor de tarea (sin git): se ejecutan en un auxiliar efímero `alpine/git` con `--network none`, `--user 1000:1000`, `--cap-drop ALL`, `no-new-privileges`, `--read-only`, el volumen montado `:ro`, `git --no-pager -c safe.directory=/workspace`, y los mismos límites, timeouts, registro y saneado. `destroy()` también elimina ese auxiliar.
* Job `WORKSPACE_RUN` en `apps/worker/src/workspace-job.ts` (no registrado en `server.ts`; `workspaceHandlers(deps)` lo expone para la activación). Dependencias inyectadas: `WorkspaceExecutor` y `TokenProvider`; el worker no importa `@jev/control` ni tiene la clave de la App. El estado queda en `jobs.result` y no en `task_runs`, porque `jev_runtime` no tiene DML sobre `task_runs` y PLT-008 limita sus escritores. Un comando fallido devuelve `status: "FAILED"` con el detalle y el job termina `COMPLETED` (sin reintento); los errores de infraestructura lanzan y pasan por `queue.fail`. Detalles en [QUEUE_WORKER](../QUEUE_WORKER.md). Activación pendiente de un servidor dedicado.

Riesgos residuales:

* `npm ci` ejecuta scripts de instalación con red. Una dependencia maliciosa puede exfiltrar lo legible en el contenedor (el checkout), pero no hay token ni secretos dentro. No se usa `--ignore-scripts` por diseño.
* Imágenes fijadas por digest en `packages/workspace/src/policy.ts` (única fuente): `DEFAULT_IMAGE` (`node:22-alpine@sha256:1314fb30…8481a`) y `DEFAULT_GIT_IMAGE` (`alpine/git:v2.47.2@sha256:062a01ad…d9bd378c`). El job `workspace-docker` de `ci.yml` lee ambas referencias de `policy.ts`, las descarga con `docker pull`, imprime `RepoDigests`, ejecuta la prueba con Docker real (`JEV_DOCKER_TESTS=1`) y comprueba al final que no quedan contenedores ni volúmenes `jev.workspace`. Verificado en verde en el run 44081305078 sobre `a75ab13`. Una prueba unitaria exige `@sha256:` con 64 hex en ambas constantes.
* Actualizar una imagen: hacer `docker pull` del nuevo tag, copiar el digest de `RepoDigests` (o de la salida del job) a `policy.ts`, ejecutar `workspace-docker` y registrar la evidencia en `PROGRESO.md`. El digest solo cambia con una decisión explícita.
* El saneado cubre el token concreto y patrones conocidos; no detecta secretos arbitrarios impresos por el código de la tarea.

## Fuera de alcance

* Activación en servidor.
* Retención autorizada.
* Gestión completa de secretos (PLT-032).
* Push y PR reales del agente (PLT-014).

## Plan de entrega

1. Diseño (este documento).
2. Robustez del worker.
3. Ejecutor (`packages/workspace`).
4. Token y job de workspace.
5. Prueba Docker en CI.
