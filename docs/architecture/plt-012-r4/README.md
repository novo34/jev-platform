# PLT-012: aceptación R4 (script y registros)

Conserva el script y la evidencia de la ejecución real R4 de PLT-012 (Permanent Staging Engine). El script se usó el **2026-11-17** para la aceptación R4. Contexto y hallazgos: [PLT-012-PERMANENT-STAGING.md](../PLT-012-PERMANENT-STAGING.md).

## Archivos

| Archivo | Qué es |
| --- | --- |
| `run-r4.mjs` | Script de la ejecución R4 manual. Prepara fixtures en la BD local, construye la configuración y ejecuta el `StagingOrchestrator` (6 etapas) con `DokployClient`. |
| `run-r4-dry-getpass.mjs` | Variante del dry-run con GET reales a Dokploy (solo lectura; ningún POST). |

Registros de ejecución: `exec1.log` (primera ejecución `--execute`: `deploy` pasó, `verifyDatabase` falló con `compose_missing` por el sufijo de `appName`; resultado `FAILED`) y `exec2.log` (segunda ejecución tras la corrección: las 6 etapas pasan; resultado `READY`) **no están versionados**: `.gitignore` ignora `*.log` y los archivos no se conservaron en el disco de esta sesión. Se generaron en la carpeta temporal original de la ejecución (donde también estaban los scripts) y no hay copia en el repositorio; el resumen de resultados está en [PLT-012-PERMANENT-STAGING.md](../PLT-012-PERMANENT-STAGING.md). Para versionar registros futuros, revisarlos sin secretos y añadir la excepción `!docs/architecture/plt-012-r4/*.log` en `.gitignore`.

Revisión de secretos: se revisaron los dos scripts (no los registros, que no están aquí); no contienen claves ni contraseñas reales. La clave de Dokploy en los scripts es el valor de relleno `proxy-injected`; la BD local usa el rol `jev_runtime` sin contraseña (trust).

## Cómo se ejecuta

```
node docs/architecture/plt-012-r4/run-r4.mjs --dry-run    # por defecto: valida y muestra el compose enmascarado; sin POST
node docs/architecture/plt-012-r4/run-r4.mjs --execute    # ejecución REAL contra Dokploy
```

`--dry-run` y `--execute` son excluyentes. El script usa `JEV_PLATFORM_DIR` (por defecto `/home/user/jev-platform`) y `R4_DB_HOST`, `R4_DB_PORT`, `R4_DB_NAME` (por defecto `127.0.0.1`, `5432`, `jev_r4`) como sustitutos de rutas y BD.

Requisitos:

- `main` compilado: `npm run build -w @jev/shared -w @jev/db -w @jev/staging`.
- Postgres local con la BD `jev_r4` migrada y el rol `jev_runtime`.
- Credencial de Dokploy guardada en el entorno de Claude Code; el proxy la inyecta como `x-api-key` para `dokploy.nuvurent.com`. Por eso el script lleva solo `proxy-injected`.
- `NODE_USE_ENV_PROXY=1` (el script se relanza con él si hay `HTTPS_PROXY`).

## Datos fijos

- Proyecto Dokploy «JEV Proyectos».
- Entorno staging: `iLssf876B5hWf_TLDmFCq`.
- Compose: `zjGERvNFVkqbZ8HOl0-so`.
- Repositorio: `novo34/jev-staging-demo`, revisión `7baa286` (SHA completo en el script).
- URL: `https://demo.staging.nuvurent.com`.

## Advertencia

`--execute` **crea o modifica recursos reales en Dokploy** (compose, dominio, despliegue). Requiere autorización explícita del operador. Los scripts originales estaban en una carpeta temporal; aquí quedan como evidencia, no como herramienta soportada.

## Pendiente

Servirá de base para registrar el job `STAGING_DEPLOY` en el worker (aún no registrado en `server.ts`).
