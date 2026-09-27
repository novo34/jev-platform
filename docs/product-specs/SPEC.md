# JEV Development Platform — SPEC

**Versión:** 2.0  
**Estado:** Canonical System Specification  
**Rama:** `jev-foundation`  
**Fecha:** 2026-09-27

---

## 1. Convenciones y boundary

Los requisitos usan `REQ-XXX-###`. “Deberá” indica obligatoriedad.

Foundation define contratos y reglas. Platform deberá implementar runtimes e integraciones reales.

Una capability Foundation no deberá marcarse como implementada en Platform por existir schema, policy, adapter de referencia o test Foundation.

### REQ-ORG-001
El sistema deberá soportar una organización con múltiples usuarios.

### REQ-ORG-002
El sistema deberá implementar, como mínimo, Admin, Project Manager, Developer, Auditor y Client.

### REQ-ORG-003
Cada acción sensible deberá comprobar autorización server-side antes de ejecutarse.

### REQ-ORG-004
Un usuario Client solo deberá acceder a proyectos explícitamente autorizados.

### REQ-ORG-005
Los agentes no deberán heredar automáticamente todos los permisos del humano que originó una orden.

### REQ-ORG-006
La Platform deberá distinguir capability NOT_IMPLEMENTED, PARTIAL, IMPLEMENTED y VERIFIED cuando informe estado de integración.

---

## 2. Clientes y proyectos

### REQ-CLI-001
El sistema deberá permitir crear, editar, archivar y consultar clientes.

### REQ-CLI-002
Un cliente podrá tener múltiples proyectos.

### REQ-CLI-003
Un proyecto podrá ser interno sin cliente.

### REQ-PRJ-001
El sistema deberá persistir proyectos en PostgreSQL.

### REQ-PRJ-002
Cada proyecto deberá tener nombre, estado, prioridad y responsables.

### REQ-PRJ-003
Cada proyecto deberá soportar múltiples repositorios.

### REQ-PRJ-004
Cada proyecto deberá asociar PRD, SPEC y ROADMAP.

### REQ-PRJ-005
Cada proyecto deberá poder definir budgets y política de modelos.

### REQ-PRJ-006
La configuración de environment deberá poder variar por proyecto y repositorio.

### REQ-PRJ-007
JEV no deberá ejecutar una orden si no puede resolver inequívocamente el proyecto objetivo.

### REQ-PRJ-008
Cada repositorio deberá declarar un rol: frontend, backend, infra u other.

### REQ-PRJ-009
Cada Task que modifique código deberá resolver explícitamente el repositorio objetivo.

### REQ-PRJ-010
JEV no deberá asumir que un proyecto multi-repo comparte ramas, URLs o deploy provider.

---

## 3. Environments

### REQ-ENV-001
Cada repository mapping deberá poder registrar default branch, staging branch y metadata de environment.

### REQ-ENV-002
La Platform deberá soportar staging URL por proyecto/repositorio según arquitectura del proyecto.

### REQ-ENV-003
La Platform deberá diferenciar environment development, staging y production.

### REQ-ENV-004
Los secretos de producción no deberán estar disponibles en development workspaces.

### REQ-ENV-005
La configuración de staging no deberá asumir equivalencia con producción.

---

## 4. Work Orders

### REQ-ORD-001
El usuario deberá poder crear una orden en lenguaje natural.

### REQ-ORD-002
El Work Order deberá persistir autor, proyecto, objetivo, prioridad, fecha y estado.

### REQ-ORD-003
JEV deberá producir criterios de aceptación estructurados antes de ejecutar implementación.

### REQ-ORD-004
Un Work Order podrá producir una o varias Tasks.

### REQ-ORD-005
El Work Order deberá persistir restricciones explícitas.

### REQ-ORD-006
El Work Order deberá poder pausarse, cancelarse o reabrirse según políticas.

### REQ-ORD-007
Las órdenes sensibles deberán mostrar impacto antes de ejecutar la acción crítica.

### REQ-ORD-008
El Work Order deberá persistir su work type.

### REQ-ORD-009
El Work Order deberá conservar referencias a attachments y sus roles.

### REQ-ORD-020
Command Center deberá aceptar órdenes administrativas de alto nivel.

### REQ-ORD-021
Una orden administrativa deberá resolverse contra targets concretos antes de ejecutarse.

### REQ-ORD-022
Pausar proyecto deberá impedir nuevas ejecuciones sin corromper runs activos.

### REQ-ORD-023
Las órdenes de budget deberán modificar únicamente policies autorizadas y persistidas.

### REQ-ORD-024
Las acciones sensibles derivadas de lenguaje natural deberán pasar autorización/confirmación requerida.

---

## 5. Tasks y lifecycle

### REQ-TSK-001
Cada Task deberá tener ID único y persistente.

### REQ-TSK-002
Cada Task deberá pertenecer a exactamente un proyecto.

### REQ-TSK-003
El lifecycle canónico deberá incluir PLANNED, READY, RUNNING, VERIFYING, VERIFIED, STAGING, AWAITING_HUMAN, APPROVED y DONE.

### REQ-TSK-004
Los estados alternativos deberán incluir BLOCKED, FAILED, CHANGES_REQUESTED y REJECTED.

### REQ-TSK-005
La Platform deberá rechazar transiciones ilegales.

### REQ-TSK-006
VERIFIED no deberá interpretarse como aprobación humana ni DONE.

### REQ-TSK-007
APPROVED no deberá interpretarse como promoción completada ni DONE.

### REQ-TSK-008
Cada transición deberá persistir actor, timestamp y causa/evidencia cuando aplique.

### REQ-TSK-009
DONE deberá requerir una Promotion de ESA MISMA Task con estado PROMOTED_TO_MAIN.

### REQ-TSK-010
Un booleano manual `production_promoted=true` no deberá satisfacer el gate de DONE.

### REQ-TSK-011
Cada Task deberá poder definir max_actions, max_retries y max_cost.

---

## 6. Riesgo

### REQ-RSK-001
Toda Task deberá tener riesgo R0-R4.

### REQ-RSK-002
El riesgo deberá calcularse antes de asignar agentes y permisos.

### REQ-RSK-003
Cambios de auth/authz deberán ser como mínimo R3.

### REQ-RSK-004
Cambios de aislamiento multi-tenant deberán ser como mínimo R3.

### REQ-RSK-005
Cambios de esquema de base de datos deberán ser como mínimo R2.

### REQ-RSK-006
Operaciones destructivas de datos deberán ser R4.

### REQ-RSK-007
Promoción a producción deberá tratarse como acción crítica gobernada aunque la Task original tenga menor riesgo.

### REQ-RSK-008
Si existen varios indicadores deberá prevalecer el riesgo más alto.

---

## 7. Skills Engine

### REQ-SKL-001
La Platform deberá consumir el manifest Foundation de skills compatible con la versión soportada.

### REQ-SKL-002
Cada skill deberá usar ID estable.

### REQ-SKL-003
La resolución deberá respetar prioridad y triggers.

### REQ-SKL-004
Toda Task deberá cargar skills obligatorias.

### REQ-SKL-005
El resolver deberá añadir skills específicas según el contexto.

### REQ-SKL-006
La compatibilidad con contracts Foundation deberá validarse en CI.

### REQ-SKL-007
Una referencia a skill inexistente deberá fallar validación.

### REQ-SKL-008
Cada run deberá registrar las skills efectivamente aplicadas.

---

## 8. Auth/RBAC y Control Plane

### REQ-CTL-001
La Platform deberá exponer un Control Layer único para acciones mutantes.

### REQ-CTL-002
API, UI, Command Center y Channel Adapters no deberán bypassar el Control Layer.

### REQ-CTL-003
El Control Layer deberá validar input, actor context, authorization, risk y policy.

### REQ-CTL-004
Toda acción mutante deberá generar audit event.

### REQ-CTL-005
El Control Layer deberá devolver errores tipados y estables.

### REQ-CTL-006
Command Center deberá exponer solo un subconjunto seguro de Control Actions.

---

## 9. Queue y workers

### REQ-QUE-001
Los trabajos largos deberán ejecutarse fuera del request thread.

### REQ-QUE-002
Los jobs deberán persistir estado.

### REQ-QUE-003
Los jobs deberán soportar retry controlado e idempotencia cuando aplique.

### REQ-QUE-004
El worker deberá propagar correlation, project, order y task IDs.

### REQ-QUE-005
La pérdida de un worker no deberá marcar una Task como DONE.

---

## 10. Agent contracts

### REQ-AGT-001
Architect, Developer, Verifier e Integrator deberán existir como roles runtime reales.

### REQ-AGT-002
Cada agente deberá ejecutar solo permisos declarados.

### REQ-AGT-003
Architect no deberá tener write de implementación por defecto.

### REQ-AGT-004
Verifier deberá ser independiente y read-only respecto al código que verifica.

### REQ-AGT-005
Un agente no deberá ampliar sus propios permisos.

### REQ-AGT-006
JEV deberá poder detener un agent run.

### REQ-AGT-007
JEV deberá poder pausar/reanudar ejecuciones válidas.

### REQ-AGT-008
Los agentes deberán respetar locks.

### REQ-AGT-009
Dos agentes no deberán escribir simultáneamente en recursos incompatibles.

### REQ-AGT-010
La identidad del agente deberá ser independiente del provider/model.

---

## 11. Model Gateway real

### REQ-MDL-001
La Platform deberá implementar un Model Gateway proveedor-neutral.

### REQ-MDL-002
Deberá soportar inicialmente DeepSeek, OpenAI/Codex, Qwen y GLM.

### REQ-MDL-003
El router deberá seleccionar provider/model según capability, risk, budget y availability.

### REQ-MDL-004
El gateway deberá normalizar usage/cost.

### REQ-MDL-005
Un usuario autorizado podrá forzar provider/model dentro de policy.

### REQ-MDL-006
Cambiar provider no deberá cambiar permisos del agente.

### REQ-MDL-007
Cada provider call deberá registrar provider/model, usage, coste y outcome.

### REQ-MDL-008
El gateway deberá soportar fallback permitido.

### REQ-MDL-009
Cada adapter deberá soportar timeout.

### REQ-MDL-010
Cada adapter deberá soportar retry policy.

### REQ-MDL-011
El gateway deberá usar typed errors.

### REQ-MDL-012
El gateway deberá implementar circuit breaker/health behavior.

### REQ-MDL-013
DeepSeek/OpenAI/Qwen/GLM no deberán marcarse implementados hasta funcionar contra sus APIs reales.

---

## 12. Budgets y costes

### REQ-CST-001
Cada run deberá soportar max_actions.

### REQ-CST-002
Cada run deberá soportar max_retries.

### REQ-CST-003
Cada run deberá soportar max_cost.

### REQ-CST-004
JEV deberá bloquear la siguiente acción cuando se alcance un hard limit.

### REQ-CST-005
Antes de una provider call pagada deberá ejecutarse un budget guard.

### REQ-CST-006
Los costes deberán agregarse por Task, Work Order, Project, Client, provider, model y periodo.

### REQ-CST-007
El administrador deberá configurar warnings y hard stops.

### REQ-CST-008
El dashboard deberá mostrar coste frente a budget.

### REQ-CST-009
Un hard stop deberá generar audit y notification.

---

## 13. GitHub App

### REQ-GIT-001
La Platform deberá integrar una GitHub App real.

### REQ-GIT-002
Deberá usar installation tokens temporales.

### REQ-GIT-003
Cada Task de código deberá usar branch dedicada.

### REQ-GIT-004
Ningún agente deberá escribir directamente a main/master.

### REQ-GIT-005
La Platform deberá crear commits reales.

### REQ-GIT-006
La Platform deberá crear Pull Requests reales.

### REQ-GIT-007
La Platform deberá leer checks y GitHub Actions.

### REQ-GIT-008
La integración de código deberá usar PR.

### REQ-GIT-009
El agente implementador no deberá verificar/aprobar su propio trabajo cuando se exige independencia.

### REQ-GIT-010
La Platform deberá bloquear promoción si faltan verification/human gates requeridos.

### REQ-GIT-011
Todo merge/promoción a producción deberá requerir aprobación humana vigente.

### REQ-GIT-012
JEV deberá trabajar sobre repositorios existentes autorizados.

### REQ-GIT-013
JEV podrá crear repositorios nuevos cuando la GitHub App disponga del permiso explícito.

### REQ-GIT-014
Las operaciones GitHub deberán quedar auditadas.

---

## 14. Workspace Engine real

### REQ-WSP-001
Cada Task escribible deberá disponer de workspace aislado real.

### REQ-WSP-002
Dos Tasks no deberán compartir el mismo workspace escribible.

### REQ-WSP-003
El workspace deberá clonar repo/branch asignados.

### REQ-WSP-004
Las credenciales deberán ser scoped y temporales.

### REQ-WSP-005
Producción credentials no deberán entrar en development workspace.

### REQ-WSP-006
El workspace deberá permitir install, build y tests.

### REQ-WSP-007
El workspace deberá destruirse después de finalizar/cancelar salvo retención autorizada.

### REQ-WSP-008
Los comandos deberán registrarse.

### REQ-WSP-009
El runtime deberá imponer CPU/RAM/network/timeouts.

### REQ-WSP-010
Temporary Workspace no deberá confundirse con Permanent Staging.

---

## 15. Verification Engine

### REQ-VER-001
La verificación deberá ser independiente de la implementación.

### REQ-VER-002
Verifier deberá recibir criterios de aceptación originales.

### REQ-VER-003
Verifier deberá poder inspeccionar diff y contexto relevante en read-only.

### REQ-VER-004
Verifier deberá recopilar CI/check evidence.

### REQ-VER-005
Cuando aplique deberá comprobar frontend y backend conjuntamente.

### REQ-VER-006
Cuando aplique deberá comprobar persistencia/DB real del environment de prueba.

### REQ-VER-007
Cuando aplique deberá ejecutar browser/E2E.

### REQ-VER-008
Verification deberá producir VERIFIED, FAILED o BLOCKED y evidencia estructurada.

### REQ-VER-009
FAILED deberá retornar la Task a corrección; no deberá avanzar a staging.

### REQ-VER-010
La evidencia deberá quedar ligada a la Task/revision.

### REQ-VER-011
Collectors reales deberán cubrir, según aplique, CI, unit, integration, browser/E2E, backend/API y DB.

---

## 16. Permanent Staging

### REQ-STG-001
Cada proyecto activo que lo requiera deberá poder tener Permanent Staging Environment.

### REQ-STG-002
Staging deberá permanecer disponible después de completar una Task.

### REQ-STG-003
Staging deberá usar una branch de staging explícita.

### REQ-STG-004
La Platform deberá exponer staging URL cuando exista UI/web.

### REQ-STG-005
Backend staging deberá ser independiente de producción.

### REQ-STG-006
Staging DB deberá ser separada de production DB.

### REQ-STG-007
Producción no deberá usarse como DB de test.

### REQ-STG-008
La Platform deberá aplicar/validar migrations de staging.

### REQ-STG-009
La Platform deberá soportar test data/seed seguro.

### REQ-STG-010
Readiness deberá incluir health checks aplicables.

### REQ-STG-011
Readiness deberá incluir browser/API/E2E aplicables.

### REQ-STG-012
Una Task no podrá pasar a AWAITING_HUMAN sin readiness evidence vigente cuando staging sea requerido.

---

## 17. Human Approval

### REQ-APR-001
La Platform deberá ofrecer una bandeja de approvals.

### REQ-APR-002
Approval deberá estar ligada a Task, staging evidence, staging URL, revision/commit, PR y actor.

### REQ-APR-003
Las decisiones deberán ser APPROVED, CHANGES_REQUESTED o REJECTED.

### REQ-APR-004
Todo merge/promoción a production deberá requerir approval humana.

### REQ-APR-005
Approval deberá persistirse y auditarse.

### REQ-APR-006
Si cambia la revision/commit o la staging evidence relevante, la approval anterior deberá quedar stale/inválida.

### REQ-APR-007
CHANGES_REQUESTED deberá devolver la Task a trabajo correctivo.

### REQ-APR-008
REJECTED deberá impedir promoción.

---

## 18. Selective Promotion

### REQ-PRM-001
La Platform no deberá promocionar staging completo por aprobar una única Task.

### REQ-PRM-002
Cada Promotion deberá estar ligada a Task.

### REQ-PRM-003
Cada Promotion deberá registrar source PR y approved commit.

### REQ-PRM-004
Cada Promotion deberá registrar migration IDs aplicables.

### REQ-PRM-005
Cada Promotion deberá referenciar la approval vigente.

### REQ-PRM-006
Cada Promotion deberá generar/usar production PR específico.

### REQ-PRM-007
La Promotion deberá tener estados estructurados, incluyendo PROMOTED_TO_MAIN.

### REQ-PRM-008
DONE solo deberá permitirse cuando la Promotion de esa Task esté PROMOTED_TO_MAIN.

### REQ-PRM-009
El fallo de promotion/deploy deberá impedir DONE y permitir rollback.

---

## 19. Multiagent y conflictos

### REQ-MUL-001
La Platform deberá soportar DAG de Tasks/dependencias para ejecución multiagente.

### REQ-MUL-002
Handoffs deberán ser persistentes y estructurados.

### REQ-MUL-003
Locks deberán identificar resource, owner y Task.

### REQ-MUL-004
Parallel work deberá respetar dependencies y locks.

### REQ-MUL-005
Los conflictos deberán detectarse explícitamente.

### REQ-MUL-006
La Platform deberá soportar conflict resolution sin sobrescritura silenciosa.

### REQ-MUL-007
Integrator deberá coordinar integración de trabajo validado.

---

## 20. Trazabilidad y Quality

### REQ-TRC-001
Los requisitos deberán usar IDs estables REQ-<DOMAIN>-<NNN>.

### REQ-TRC-002
JEV deberá relacionar Requirement con Task.

### REQ-TRC-003
JEV deberá relacionar Task con repository/branch.

### REQ-TRC-004
JEV deberá relacionar Task con PR.

### REQ-TRC-005
JEV deberá relacionar Requirement con implementation files.

### REQ-TRC-006
JEV deberá relacionar Requirement con tests/evidence.

### REQ-TRC-007
JEV deberá registrar verification result.

### REQ-TRC-008
Un Requirement no deberá marcarse VERIFIED sin evidencia.

### REQ-QLT-001
Quality Center deberá ingerir trazabilidad real.

### REQ-QLT-002
Deberá mostrar missing, unverified, failed y verified requirements.

### REQ-QLT-003
Deberá mostrar CI, verification, staging readiness y promotion state.

### REQ-QLT-004
La UI de Quality no deberá inferir estados que no existan en el backend canónico.

---

## 21. Audit y Notifications

### REQ-AUD-001
Toda acción mutante deberá generar audit event.

### REQ-AUD-002
Audit deberá ser append-only.

### REQ-AUD-003
Audit deberá registrar actor, action, target, timestamp y result.

### REQ-AUD-004
Provider calls deberán registrar provider/model/usage/cost.

### REQ-AUD-005
Development agents no deberán modificar ni borrar audit history.

### REQ-AUD-006
Audit deberá ser consultable por Project/Task/action.

### REQ-NOT-001
La Platform deberá generar notification ante approval requerida.

### REQ-NOT-002
La Platform deberá generar notification ante fallo crítico.

### REQ-NOT-003
Warnings y budget hard stops deberán poder generar notifications.

### REQ-NOT-004
Notifications deberán enlazar a Project/Task/staging review correspondiente.

### REQ-NOT-005
Attention Center deberá agregar approvals, blocked, failures, stale evidence, budget alerts y conflictos.

---

## 22. Dashboard, Project Control Center y Reports

### REQ-UI-001
Dashboard deberá mostrar Projects, Orders, running/blocked Tasks, approvals, staging, costs y Attention Center.

### REQ-UI-002
La navegación deberá incluir Dashboard, Projects, Orders, Agents, Approvals, Quality, GitHub, Costs, Reports, Clients y Settings.

### REQ-UI-003
Cada Project deberá exponer un Project Control Center.

### REQ-UI-004
El usuario deberá filtrar Tasks por estado, risk, agent, model y project.

### REQ-UI-005
La vista Task deberá mostrar timeline, evidence, PR, staging, approval y promotion.

### REQ-UI-006
Acciones destructivas/sensibles deberán requerir confirmación según policy.

### REQ-UI-007
La UI deberá diferenciar blocked, failed, awaiting human, approved y promoted.

### REQ-UI-008
La interfaz deberá ser responsive.

### REQ-RPT-001
JEV deberá generar project reports.

### REQ-RPT-002
El reporte deberá incluir progreso, quality, failures, staging/promotion y costs.

### REQ-RPT-003
Los reportes deberán soportar periodos.

### REQ-RPT-004
Deberán mostrar costes por provider/model.

### REQ-RPT-005
Deberán mostrar requirements no verificados.

### REQ-RPT-006
La arquitectura de reporting deberá permitir futuras exportaciones PDF/Excel/CSV.

---

## 23. Command Center

### REQ-CMD-001
Command Center deberá convertir lenguaje natural en intent estructurado.

### REQ-CMD-002
El intent deberá validarse antes de autorización.

### REQ-CMD-003
La acción deberá pasar authorization antes de execution.

### REQ-CMD-004
Commands ambiguos/sensibles deberán requerir confirmación cuando policy lo exija.

### REQ-CMD-005
Command Center deberá invocar Control Layer; no servicios internos directamente.

### REQ-CMD-006
Command Center deberá exponer solo el subconjunto seguro de Control Actions definido para él.

### REQ-CMD-007
Toda ejecución deberá quedar auditada.

---

## 24. Multimodal Intake

### REQ-MM-001
La Platform deberá aceptar text.

### REQ-MM-002
La Platform deberá aceptar image.

### REQ-MM-003
La Platform deberá aceptar screenshot.

### REQ-MM-004
La Platform deberá aceptar file.

### REQ-MM-005
La Platform deberá aceptar link.

### REQ-MM-006
Attachment roles deberán incluir CURRENT_BASE, EDIT_TARGET, STYLE_REFERENCE, DESIRED_RESULT y REQUIREMENT_DOCUMENT.

### REQ-MM-007
Work types deberán incluir GENERAL, IMAGE_REPLACEMENT, IMAGE_GENERATION, IMAGE_EDIT y UI_REFERENCE_REDESIGN.

### REQ-MM-008
JEV deberá conservar la relación original/target/reference sin ambigüedad.

### REQ-MM-009
Los visual Work Orders deberán persistir target section/component cuando aplique.

### REQ-MM-010
Todo cambio visual deberá pasar por staging y revisión humana antes de producción.

---

## 25. Image workflows

### REQ-IMG-001
IMAGE_REPLACEMENT deberá permitir asociar asset original y replacement.

### REQ-IMG-002
IMAGE_GENERATION deberá soportar provider de generación real en Platform.

### REQ-IMG-003
IMAGE_EDIT deberá preservar el asset de entrada y registrar el generado.

### REQ-IMG-004
UI_REFERENCE_REDESIGN deberá diferenciar current screenshot de style/reference screenshot.

### REQ-IMG-005
Los assets generados deberán quedar ligados a Work Order/Task y branch de implementación.

### REQ-IMG-006
El resultado deberá revisarse en Permanent Staging.

---

## 26. Channels

### REQ-CHN-001
La arquitectura deberá soportar Web, Telegram y WhatsApp.

### REQ-CHN-002
Channel Adapters deberán limitarse a ingreso/egreso.

### REQ-CHN-003
Channel Adapter no deberá ejecutar GitHub, agents, Docker, model providers o deploy directamente.

### REQ-CHN-004
El flujo deberá ser Channel → Multimodal Intake → Work Order/Command → Control Layer.

### REQ-CHN-005
Telegram real deberá implementarse en Platform.

### REQ-CHN-006
WhatsApp real deberá implementarse en Platform.

### REQ-CHN-007
Los channels deberán respetar auth, confirmation, audit y staging gates.

---

## 27. Secrets, observability y security

### REQ-SEC-001
La Platform deberá usar secrets management fuera del repository.

### REQ-SEC-002
Workers deberán recibir únicamente secrets necesarios y scoped.

### REQ-SEC-003
Production secrets no deberán entrar en development workspaces.

### REQ-SEC-004
La Platform deberá probar authz bypass.

### REQ-SEC-005
La Platform deberá probar tenant leakage.

### REQ-SEC-006
La Platform deberá probar secret leakage.

### REQ-SEC-007
La Platform deberá probar command injection.

### REQ-SEC-008
Hallazgos críticos deberán bloquear release.

### REQ-OBS-001
API, workers y agents deberán emitir structured logs.

### REQ-OBS-002
Correlation/request/task IDs deberán propagarse.

### REQ-OBS-003
La Platform deberá exponer métricas de latency, errors, jobs y costs.

### REQ-OBS-004
Los incidentes críticos deberán generar señal operativa/notification.

---

## 28. Backups y rollback

### REQ-BAK-001
La Platform deberá implementar backup de PostgreSQL.

### REQ-BAK-002
La Platform deberá disponer de restore procedure probado.

### REQ-BAK-003
Los deployments fallidos deberán poder rollback.

### REQ-BAK-004
Rollback deberá generar audit event.

### REQ-BAK-005
Antes de activar JEV self-development deberá existir rollback probado.

---

## 29. Contract Drift

### REQ-DRF-001
CI deberá comprobar lifecycle consistente entre runtime, schemas, policies y docs.

### REQ-DRF-002
CI deberá comprobar risk levels consistentes.

### REQ-DRF-003
CI deberá comprobar Control Actions consistentes con contratos expuestos.

### REQ-DRF-004
CI deberá comprobar Command Center actions como subconjunto seguro permitido.

### REQ-DRF-005
CI deberá comprobar Work Order states/types.

### REQ-DRF-006
CI deberá comprobar Notification categories.

### REQ-DRF-007
CI deberá comprobar approval rules.

### REQ-DRF-008
Contract drift crítico deberá bloquear release.

---

## 30. Pilotos y self-development

### REQ-PIL-001
Primero deberá ejecutarse un controlled pilot repository.

### REQ-PIL-002
El piloto deberá completar Order → Task → workspace → provider → implementation → tests → PR → verification → staging → human approval → selective promotion → production → DONE.

### REQ-PIL-003
El piloto deberá mostrar costs, audit y traceability.

### REQ-PIL-004
Espacore solo deberá activarse después del controlled pilot.

### REQ-PIL-005
Nuvurent deberá activarse después de Espacore.

### REQ-PIL-006
JEV self-development solo deberá activarse después de Nuvurent, security hardening y backup/rollback.

### REQ-PIL-007
JEV self-development deberá operar bajo highest-risk policy, Verifier independiente y aprobación humana obligatoria.

---

## 31. Entidades canónicas Platform

PostgreSQL deberá contemplar, como mínimo:

- Organization
- User
- Client
- Project
- Repository
- Environment
- WorkOrder
- Requirement
- Task
- TaskRun
- AgentRun
- ModelCall/CostEvent
- Workspace
- ResourceLock
- PullRequestLink
- Verification
- StagingDeployment
- StagingEvidence
- Approval
- Promotion
- Deployment
- AuditEvent
- Notification

---

## 32. MVP Definition

### REQ-MVP-001
El MVP no deberá declararse completo sin un circuit end-to-end real.

### REQ-MVP-002
El circuit deberá incluir real workspace y real AI provider.

### REQ-MVP-003
Deberá incluir PR y independent verification.

### REQ-MVP-004
Deberá incluir Permanent Staging y readiness evidence.

### REQ-MVP-005
Deberá incluir human review vigente.

### REQ-MVP-006
Deberá incluir selective promotion a production.

### REQ-MVP-007
DONE deberá ocurrir solo después de PROMOTED_TO_MAIN.

### REQ-MVP-008
Cost y audit deberán ser visibles y persistentes.
