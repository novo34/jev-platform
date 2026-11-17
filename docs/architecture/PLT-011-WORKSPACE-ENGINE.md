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
