# JEV Development Platform — SPEC

**Versión:** 1.0  
**Estado:** Especificación canónica  
**Rama:** `jev-foundation`  
**Fecha:** 2026-09-27

## 1. Convenciones

Los requisitos usan identificadores estables:

- REQ-ORG: organización y usuarios
- REQ-CLI: clientes
- REQ-PRJ: proyectos
- REQ-ORD: órdenes
- REQ-TSK: tareas
- REQ-RSK: riesgo
- REQ-SKL: skills
- REQ-AGT: agentes
- REQ-MDL: modelos
- REQ-GIT: GitHub
- REQ-WSP: workspaces
- REQ-VER: verificación
- REQ-TRC: trazabilidad
- REQ-APR: aprobaciones
- REQ-CST: costes
- REQ-RPT: reportes
- REQ-AUD: auditoría
- REQ-SEC: seguridad
- REQ-UI: interfaz
- REQ-NOT: notificaciones

"Deberá" indica requisito obligatorio.

## 2. Organización y acceso

### REQ-ORG-001
El sistema deberá soportar una organización con múltiples usuarios.

### REQ-ORG-002
El sistema deberá implementar roles, al menos: Admin, Project Manager, Developer, Auditor y Client.

### REQ-ORG-003
Cada acción sensible deberá comprobar autorización antes de ejecutarse.

### REQ-ORG-004
Un usuario Client solo podrá acceder a proyectos y datos explícitamente autorizados.

### REQ-ORG-005
Los agentes no heredarán automáticamente los permisos del usuario que creó una orden.

## 3. Clientes

### REQ-CLI-001
El sistema deberá permitir crear, editar, archivar y consultar clientes.

### REQ-CLI-002
Un cliente podrá tener múltiples proyectos.

### REQ-CLI-003
Un proyecto podrá ser interno y no requerir cliente.

## 4. Proyectos

### REQ-PRJ-001
El sistema deberá permitir crear proyectos.

### REQ-PRJ-002
Cada proyecto deberá tener nombre, estado, prioridad y responsables.

### REQ-PRJ-003
Cada proyecto podrá conectar uno o varios repositorios.

### REQ-PRJ-004
Cada proyecto deberá poder asociar PRD, SPEC y ROADMAP.

### REQ-PRJ-005
Cada proyecto deberá poder definir presupuesto y política de modelos.

### REQ-PRJ-006
El proyecto deberá mantener configuración de entorno separada de otros proyectos.

### REQ-PRJ-007
JEV no deberá ejecutar una orden si no puede determinar inequívocamente el proyecto objetivo.

## 5. Órdenes

### REQ-ORD-001
El usuario deberá poder crear una orden en lenguaje natural.

### REQ-ORD-002
La orden deberá registrar autor, proyecto, objetivo, prioridad, fecha y estado.

### REQ-ORD-003
JEV deberá generar criterios de aceptación estructurados antes de ejecutar trabajo.

### REQ-ORD-004
Una orden podrá generar una o varias tareas.

### REQ-ORD-005
La orden deberá permitir adjuntar restricciones explícitas.

### REQ-ORD-006
Una orden deberá poder ser pausada, cancelada o reabierta.

### REQ-ORD-007
Las órdenes críticas deberán mostrar un resumen de impacto antes de ejecución.

## 6. Tareas

### REQ-TSK-001
Cada tarea deberá tener ID único.

### REQ-TSK-002
Cada tarea deberá pertenecer a exactamente un proyecto.

### REQ-TSK-003
Los estados permitidos serán PLANNED, READY, RUNNING, BLOCKED, VERIFYING, FAILED, VERIFIED y DONE.

### REQ-TSK-004
No deberá ser posible saltar transiciones no autorizadas.

### REQ-TSK-005
Una tarea no podrá pasar a VERIFIED sin evidencia de verificación.

### REQ-TSK-006
Una tarea R4 no podrá pasar a DONE sin aprobación humana.

### REQ-TSK-007
Cada tarea deberá registrar historial de transiciones.

### REQ-TSK-008
Cada tarea deberá poder definir límites de acciones, reintentos y coste.

## 7. Riesgo

### REQ-RSK-001
Toda tarea deberá tener nivel R0-R4.

### REQ-RSK-002
El riesgo deberá calcularse antes de asignar agentes.

### REQ-RSK-003
Cambios de autenticación/autorización deberán ser como mínimo R3.

### REQ-RSK-004
Cambios de aislamiento multi-tenant deberán ser como mínimo R3.

### REQ-RSK-005
Cambios de esquema de base de datos deberán ser como mínimo R2.

### REQ-RSK-006
Operaciones destructivas de datos deberán ser R4.

### REQ-RSK-007
Despliegues a producción deberán ser R4.

### REQ-RSK-008
Cuando existan varios indicadores, deberá prevalecer el riesgo más alto.

## 8. Skills Engine

### REQ-SKL-001
Todas las skills disponibles deberán estar registradas en un manifest.

### REQ-SKL-002
Cada skill deberá tener ID estable independiente del nombre de carpeta.

### REQ-SKL-003
Cada skill deberá indicar prioridad y triggers.

### REQ-SKL-004
El resolver deberá cargar las skills obligatorias en toda tarea.

### REQ-SKL-005
El resolver deberá añadir skills específicas según los triggers.

### REQ-SKL-006
Las skills deberán validarse automáticamente en CI.

### REQ-SKL-007
Una skill inexistente referenciada por el manifest deberá bloquear CI.

### REQ-SKL-008
JEV deberá registrar qué skills se aplicaron a una ejecución.

## 9. Agentes

### REQ-AGT-001
Los agentes deberán definirse mediante contratos declarativos.

### REQ-AGT-002
Cada contrato deberá especificar rol, permisos, skills obligatorias y outputs.

### REQ-AGT-003
Architect no deberá tener permiso de implementación por defecto.

### REQ-AGT-004
Verifier no deberá modificar el código que está verificando.

### REQ-AGT-005
Un agente no podrá ampliar sus propios permisos.

### REQ-AGT-006
JEV deberá poder detener un agente.

### REQ-AGT-007
JEV deberá poder pausar y reanudar ejecuciones.

### REQ-AGT-008
Los agentes deberán respetar locks de recursos.

### REQ-AGT-009
Dos agentes no deberán escribir simultáneamente en un recurso bloqueado.

## 10. Model Router

### REQ-MDL-001
El rol del agente y el modelo deberán ser conceptos independientes.

### REQ-MDL-002
El router deberá admitir múltiples proveedores.

### REQ-MDL-003
El router deberá poder seleccionar modelo según riesgo.

### REQ-MDL-004
El router deberá poder considerar coste y presupuesto.

### REQ-MDL-005
El usuario autorizado deberá poder forzar un modelo para una tarea.

### REQ-MDL-006
El cambio de proveedor no deberá modificar los permisos del agente.

### REQ-MDL-007
Cada llamada deberá registrar proveedor/modelo y coste medible o estimado.

### REQ-MDL-008
Si un proveedor no está disponible, el router deberá poder seleccionar un fallback permitido.

## 11. GitHub Engine

### REQ-GIT-001
JEV deberá poder conectar repositorios GitHub autorizados.

### REQ-GIT-002
JEV deberá poder leer estructura y archivos.

### REQ-GIT-003
JEV deberá crear una rama por tarea de implementación.

### REQ-GIT-004
Los agentes no deberán escribir directamente a main/master.

### REQ-GIT-005
JEV deberá poder crear commits.

### REQ-GIT-006
JEV deberá poder crear Pull Requests.

### REQ-GIT-007
JEV deberá poder leer checks y GitHub Actions.

### REQ-GIT-008
Una integración deberá usar PR.

### REQ-GIT-009
El agente que implementa no deberá aprobar su propia verificación.

### REQ-GIT-010
El merge deberá bloquearse cuando el Verifier no haya aprobado.

### REQ-GIT-011
Un merge R4 deberá requerir aprobación humana.

### REQ-GIT-012
JEV deberá poder trabajar sobre repositorios existentes.

### REQ-GIT-013
JEV deberá poder crear repositorios nuevos cuando la integración disponga de permisos.

## 12. Workspaces

### REQ-WSP-001
Cada ejecución escribible deberá disponer de un workspace aislado.

### REQ-WSP-002
Dos tareas no deberán compartir el mismo workspace escribible.

### REQ-WSP-003
El workspace deberá clonar únicamente el repositorio y rama asignados.

### REQ-WSP-004
Las credenciales deberán ser temporales y limitadas.

### REQ-WSP-005
Credenciales de producción no deberán montarse en workspaces de desarrollo.

### REQ-WSP-006
El workspace deberá permitir instalación, build y tests.

### REQ-WSP-007
El workspace deberá destruirse al finalizar salvo retención explícita para debugging.

### REQ-WSP-008
Los comandos ejecutados deberán registrarse.

## 13. Límites y presupuestos

### REQ-CST-001
Cada run deberá tener max_actions.

### REQ-CST-002
Cada run deberá tener max_retries.

### REQ-CST-003
Cada run deberá tener max_cost.

### REQ-CST-004
JEV deberá bloquear la siguiente acción si supera un hard limit.

### REQ-CST-005
JEV deberá considerar coste estimado de la siguiente acción cuando esté disponible.

### REQ-CST-006
Los costes deberán agregarse por tarea, orden, proyecto, cliente y periodo.

### REQ-CST-007
El administrador deberá poder establecer alertas de presupuesto.

### REQ-CST-008
El dashboard deberá mostrar gasto real/estimado frente a presupuesto.

## 14. Verificación

### REQ-VER-001
La verificación deberá ser independiente de la implementación.

### REQ-VER-002
El Verifier deberá recibir los criterios de aceptación originales.

### REQ-VER-003
El Verifier deberá poder consultar diff y archivos relevantes.

### REQ-VER-004
El Verifier deberá comprobar CI.

### REQ-VER-005
Cuando aplique, deberá comprobar frontend y backend conjuntamente.

### REQ-VER-006
Cuando aplique, deberá comprobar persistencia real de datos.

### REQ-VER-007
Cuando aplique, deberá ejecutar E2E.

### REQ-VER-008
El resultado será VERIFIED, FAILED o BLOCKED.

### REQ-VER-009
FAILED deberá devolver trabajo al flujo de corrección.

### REQ-VER-010
La evidencia de verificación deberá quedar asociada a la tarea.

## 15. Trazabilidad

### REQ-TRC-001
Los requisitos deberán usar IDs estables REQ-<DOMAIN>-<NNN>.

### REQ-TRC-002
JEV deberá relacionar requisito con tarea.

### REQ-TRC-003
JEV deberá relacionar tarea con rama.

### REQ-TRC-004
JEV deberá relacionar tarea con PR.

### REQ-TRC-005
JEV deberá relacionar requisito con archivos implementados.

### REQ-TRC-006
JEV deberá relacionar requisito con tests.

### REQ-TRC-007
JEV deberá registrar resultado de verificación.

### REQ-TRC-008
Un requisito no deberá marcarse VERIFIED sin evidencia.

## 16. Locks y concurrencia

### REQ-SEC-001
JEV deberá mantener locks activos de recursos modificados.

### REQ-SEC-002
Un agente no propietario no podrá escribir en un recurso con lock activo.

### REQ-SEC-003
Los locks deberán tener owner y task_id.

### REQ-SEC-004
Los locks deberán liberarse explícitamente al completar o cancelar.

### REQ-SEC-005
JEV deberá detectar locks huérfanos o expirados.

## 17. Aprobaciones humanas

### REQ-APR-001
El sistema deberá tener una bandeja de aprobaciones.

### REQ-APR-002
Cada aprobación deberá mostrar acción propuesta, impacto, riesgo y evidencia.

### REQ-APR-003
El usuario podrá aprobar, rechazar o pedir cambios.

### REQ-APR-004
R4 deberá exigir aprobación humana para finalizar acciones críticas.

### REQ-APR-005
Las aprobaciones deberán quedar registradas en auditoría.

## 18. Dashboard y UI

### REQ-UI-001
El dashboard deberá mostrar proyectos, tareas activas, bloqueos, aprobaciones, fallos y costes.

### REQ-UI-002
La navegación deberá incluir Dashboard, Projects, Orders, Agents, Approvals, Quality, GitHub, Costs, Reports, Clients y Settings.

### REQ-UI-003
Cada proyecto deberá mostrar resumen operativo.

### REQ-UI-004
El usuario deberá poder filtrar tareas por estado, riesgo, agente, modelo y proyecto.

### REQ-UI-005
El usuario deberá poder abrir una tarea y consultar todo su historial.

### REQ-UI-006
Las acciones destructivas deberán requerir confirmación explícita.

### REQ-UI-007
El dashboard deberá diferenciar claramente bloqueado, fallido y pendiente de aprobación.

### REQ-UI-008
La interfaz deberá ser responsive.

## 19. Centro de mando

### REQ-ORD-020
JEV deberá aceptar órdenes administrativas de alto nivel.

### REQ-ORD-021
Una orden administrativa deberá resolverse contra proyectos concretos.

### REQ-ORD-022
Órdenes como "pausar proyecto" deberán afectar nuevas ejecuciones sin corromper tareas activas.

### REQ-ORD-023
Órdenes de presupuesto deberán actualizar los límites aplicables.

### REQ-ORD-024
Una orden que implique R4 deberá generar aprobación antes de ejecutar la acción crítica.

## 20. Reportes

### REQ-RPT-001
JEV deberá generar un reporte de proyecto.

### REQ-RPT-002
El reporte deberá incluir progreso, calidad, fallos y costes.

### REQ-RPT-003
JEV deberá generar reportes por periodo.

### REQ-RPT-004
JEV deberá poder mostrar costes por proveedor/modelo.

### REQ-RPT-005
JEV deberá poder mostrar requisitos no verificados.

### REQ-RPT-006
La exportación PDF/Excel podrá implementarse después del MVP, pero el modelo de datos deberá soportarla.

## 21. Auditoría

### REQ-AUD-001
Toda acción mutante deberá generar evento de auditoría.

### REQ-AUD-002
El evento deberá registrar actor, acción, objeto, timestamp y resultado.

### REQ-AUD-003
Las llamadas a IA deberán registrar modelo/proveedor.

### REQ-AUD-004
Las decisiones críticas deberán registrar rationale.

### REQ-AUD-005
Los eventos no deberán ser modificables por agentes de desarrollo.

### REQ-AUD-006
El sistema deberá permitir consultar auditoría por proyecto/tarea.

## 22. Notificaciones

### REQ-NOT-001
El usuario deberá recibir aviso cuando una tarea requiera aprobación.

### REQ-NOT-002
El usuario deberá recibir aviso ante fallo crítico.

### REQ-NOT-003
El usuario deberá poder configurar notificaciones no críticas.

### REQ-NOT-004
Las notificaciones deberán enlazar al contexto correspondiente.

## 23. Entidades principales

```
Organization
User
Client
Project
Repository
ProductDocument
Order
Requirement
Task
TaskRun
AgentDefinition
AgentRun
Skill
ModelProvider
Model
Workspace
ResourceLock
PullRequestLink
Verification
Approval
CostEvent
AuditEvent
Report
Notification
```

## 24. Arquitectura lógica

```
Web Dashboard
      |
JEV API
      |
+-------------------------------+
| Orchestrator                  |
| Risk Engine                   |
| Skills Engine                 |
| Agent Registry                |
| Model Router                  |
| Approval Engine               |
+-------------------------------+
      |
+-------------+-----------------+
| GitHub      | Workspace       |
| Engine      | Engine          |
+-------------+-----------------+
      |
Model Providers / GitHub / Containers

PostgreSQL = estado canónico empresarial
GitHub = fuente de verdad del código
Queue = ejecución asíncrona
```

## 25. Stack objetivo

- Frontend: Next.js + TypeScript
- API/control plane: Python FastAPI o equivalente
- Base de datos: PostgreSQL
- Queue: Redis
- Workers: Python
- Workspaces: Docker
- Git: GitHub App + GitHub API
- CI: GitHub Actions
- E2E: Playwright
- Observabilidad: logs estructurados + métricas
- Despliegue: contenedores

## 26. Gates de calidad mínimos

Antes de merge:

- manifest/contratos válidos;
- lint;
- typecheck cuando aplique;
- unit tests;
- integration tests cuando aplique;
- build;
- E2E cuando aplique;
- verificación;
- aprobación humana cuando aplique.

## 27. Criterio de aceptación del MVP

El MVP deberá demostrar end-to-end:

1. proyecto conectado a GitHub;
2. orden creada;
3. tarea derivada;
4. riesgo calculado;
5. skills resueltas;
6. agente/modelo seleccionados;
7. rama creada;
8. workspace creado;
9. cambio implementado;
10. pruebas ejecutadas;
11. PR creado;
12. verificación independiente;
13. estado reflejado en dashboard;
14. coste registrado;
15. requisito trazado;
16. aprobación aplicada si corresponde.
