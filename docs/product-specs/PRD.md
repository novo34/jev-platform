# JEV Development Platform — PRD

**Versión:** 3.0  
**Estado:** Canonical Product Requirements  
**Rama:** `jev-foundation`  
**Fecha:** 2026-10-05  
**Fuente Foundation:** `novo34/base-skills_klever@jev-v8-adaptive-foundation` — gate `FND-070` validado

---

## 1. Visión

JEV será la plataforma de control de una empresa de desarrollo de software asistida por IA.

El usuario dará órdenes, administrará proyectos, revisará excepciones y aprobará cambios sensibles. JEV coordinará repositorios, agentes, modelos, workspaces, verificación, staging, promoción a producción, costes, auditoría y reportes.

**Principio central:** los modelos no gobiernan JEV. JEV gobierna los modelos.

Los modelos son trabajadores reemplazables. El estado empresarial, los permisos, el lifecycle, las aprobaciones, los budgets, la evidencia y las decisiones pertenecen al Control Layer de JEV.

---

## 2. Límite Foundation / Platform

`base-skills_klever` define **qué debe permitir, prohibir, registrar y verificar JEV** mediante contratos, schemas, policies y reference behavior.

`jev-platform` implementará **cómo funciona realmente** mediante PostgreSQL, APIs, workers, GitHub App, Docker/VM, proveedores de IA, staging online, UI y servicios externos.

La existencia de un contrato o reference runtime en Foundation **no significa** que exista integración real en Platform.

Estados de implementación Platform:

- **NOT_IMPLEMENTED**
- **PARTIAL**
- **IMPLEMENTED**
- **VERIFIED**

Una capacidad solo podrá considerarse VERIFIED cuando exista implementación real y evidencia correspondiente.

---

## 3. Problema que resuelve

JEV debe evitar que el desarrollo con IA dependa de conversaciones aisladas o de afirmaciones no verificadas.

Debe resolver, entre otros:

- falsos “terminado”;
- cambios sin trazabilidad;
- colisiones entre agentes;
- falta de staging permanente;
- aprobaciones sin evidencia;
- promoción accidental de cambios no aprobados;
- gasto de IA sin control;
- acoplamiento a un proveedor;
- ausencia de visión empresarial;
- falta de separación entre decisión humana, verificación técnica y despliegue real;
- ejecución con contexto excesivo o insuficiente;
- planes rígidos que quedan obsoletos cuando aparecen hechos nuevos;
- proliferación innecesaria de agentes/skills;
- aprendizaje no evaluado que degrada comportamiento;
- código muerto, duplicación, artefactos temporales y deuda de limpieza acumulada.

---

## 4. Objetivos del producto

JEV deberá permitir:

1. administrar organizaciones, usuarios, clientes y proyectos;
2. registrar proyectos con uno o varios repositorios;
3. asignar roles de repositorio: frontend, backend, infra u other;
4. mantener environments por proyecto/repositorio;
5. recibir órdenes en lenguaje natural y multimodal;
6. persistir Work Orders, Tasks, Requirements y estados;
7. clasificar riesgo R0-R4;
8. resolver skills Foundation;
9. seleccionar agentes;
10. seleccionar proveedores/modelos;
11. aplicar budgets antes de acciones pagadas;
12. operar GitHub mediante GitHub App real;
13. ejecutar trabajo en workspaces Docker/VM reales;
14. verificar independientemente;
15. integrar la Task verificada en staging permanente;
16. generar evidencia de readiness de staging;
17. solicitar revisión humana;
18. promocionar selectivamente solo el cambio aprobado;
19. confirmar promoción real a producción antes de DONE;
20. registrar auditoría append-only;
21. mostrar Attention Center, Quality Center, costes y reportes;
22. aceptar órdenes desde Web y preparar adapters para Telegram/WhatsApp;
23. soportar workflows visuales e imágenes;
24. operar pilotos controlados antes del self-development;
25. refinar intención y ambigüedad antes de ejecutar;
26. generar Acceptance Contracts y Execution Blueprints versionados;
27. compilar workflows proporcionalmente a riesgo, alcance y capacidades;
28. construir Context Packs acotados con retrieval iterativo;
29. permitir replanning versionado sin perder trazabilidad;
30. componer capacidades sobre pocos roles de autoridad;
31. mantener Requirement Graph y documentación viva;
32. evaluar salud de skills y aprendizaje basado en evidencia;
33. comparar mejoras contra baseline mediante replay/counterfactual evaluation;
34. auto-mejorarse únicamente mediante aprobación humana, canary aislado y rollback;
35. impedir acumulación silenciosa de código muerto, duplicación y basura de pruebas.

---

## 5. Usuarios y control humano

Roles iniciales:

- Admin / Owner
- Project Manager
- Developer humano
- Auditor / QA
- Client

Las autorizaciones deberán comprobarse server-side.

Los agentes nunca heredarán automáticamente todos los permisos del humano que emitió una orden.

Toda promoción a producción requerirá aprobación humana vigente y ligada a la evidencia exacta que fue revisada.

---

## 6. Modelo empresarial

```
Organization
 ├── Users
 ├── Clients
 │    └── Projects
 │         ├── Repositories
 │         │    └── Environments
 │         ├── Work Orders
 │         ├── Requirements
 │         ├── Tasks / Runs
 │         ├── Staging
 │         ├── Approvals
 │         ├── Promotions
 │         ├── Quality
 │         ├── Costs
 │         └── Reports
 └── Global Settings
```

Un proyecto puede ser interno.

---

## 7. Project Registry y multi-repo

Cada proyecto deberá persistir en PostgreSQL.

Un proyecto podrá contener múltiples repositorios con roles explícitos:

- frontend
- backend
- infra
- other

Cada repositorio podrá definir de forma independiente:

- default branch;
- staging branch;
- production URL;
- staging URL;
- deployment provider;
- environment metadata;
- required checks;
- migration behavior.

JEV deberá resolver explícitamente qué repositorio afecta cada Task. No deberá asumir que todo proyecto es monorepo.

---

## 8. Work Orders y Tasks

Una orden podrá originarse desde Web, Command Center o un Channel Adapter.

La orden deberá convertirse en un Work Order estructurado con:

- proyecto;
- objetivo;
- alcance;
- restricciones;
- prioridad;
- criterios de aceptación;
- attachments;
- requirements;
- tipo de trabajo.

El Work Order podrá generar una o varias Tasks persistentes.

---

## 9. Lifecycle canónico

Lifecycle principal:

```
PLANNED
→ READY
→ RUNNING
→ VERIFYING
→ VERIFIED
→ STAGING
→ AWAITING_HUMAN
→ APPROVED
→ DONE
```

Estados alternativos:

- BLOCKED
- FAILED
- CHANGES_REQUESTED
- REJECTED

Reglas:

- VERIFIED significa que la verificación técnica pasó; no significa aprobación humana.
- APPROVED significa que el humano aprobó la revisión ligada a una revisión/evidencia concreta; no significa producción completada.
- DONE exige una Promotion real de ESA MISMA Task con estado `PROMOTED_TO_MAIN`.
- Un booleano manual como `production_promoted=true` no constituye evidencia suficiente.
- Ninguna transición puede saltarse el state machine.

---

## 10. Temporary Workspace vs Permanent Staging

Son conceptos distintos.

### Temporary Workspace

Entorno aislado y efímero para implementar y probar una Task.

Puede destruirse después de la ejecución.

### Permanent Staging Environment

Entorno online persistente por proyecto, utilizado para validar cambios reales antes de producción.

Deberá incluir, cuando aplique:

- staging branch;
- staging URL;
- backend staging;
- staging database separada;
- migrations;
- test data;
- health checks;
- browser/API/E2E;
- readiness evidence.

Producción nunca se usará como base de datos de pruebas.

---

## 11. Human staging review

Después de VERIFIED, la Task deberá integrarse en staging y producir evidencia actual.

El revisor humano deberá ver como mínimo:

- Task;
- PR/revision;
- staging URL;
- verification report;
- staging readiness evidence;
- cambios relevantes.

Decisiones:

- APPROVED
- CHANGES_REQUESTED
- REJECTED

Si cambia el commit, PR relevante, staging revision o evidencia después de aprobar, la aprobación anterior queda invalidada.

---

## 12. Selective Promotion

JEV nunca promocionará el staging completo a `main` por aprobar una sola Task.

Cada Promotion deberá ligar:

- Task;
- source PR;
- approved commit;
- migration IDs;
- approval;
- production PR;
- resultado de promoción.

Solo después de `PROMOTED_TO_MAIN` la Task podrá alcanzar DONE.

---

## 13. Model Gateway

La Platform implementará adapters reales iniciales para:

- DeepSeek
- OpenAI/Codex
- Qwen
- GLM

El gateway deberá normalizar:

- request/response;
- usage;
- coste;
- typed errors;
- timeout;
- retry;
- fallback;
- circuit breaker;
- health.

Las credenciales se gestionarán fuera del repositorio.

---

## 14. Budgets y costes

Todo proveedor pagado deberá pasar un budget guard antes de la llamada.

JEV deberá soportar límites por:

- Task;
- Work Order;
- Project;
- periodo;
- proveedor/modelo.

El hard stop deberá impedir la siguiente acción pagada cuando se supere el límite.

Los costes deberán ser trazables y reportables.

---

## 15. Agentes

Roles iniciales:

### Architect
Refina intención, especifica restricciones, diseña arquitectura, genera Execution Blueprints y propone replanning.

### Developer
Implementa en el workspace asignado usando source-grounded development, TDD incremental, debugging, simplificación y cleanup obligatorio.

### Verifier
Revisa independientemente y será read-only respecto al código que verifica. Deberá consumir evidencia de runtime/browser, trazabilidad, adversarial review e higiene cuando aplique.

### Integrator
Coordina integración, conflictos y promoción autorizada. Solo podrá integrar la revisión exacta del Blueprint aprobada y el scope exacto autorizado.

La identidad del agente y el proveedor/modelo utilizado serán conceptos separados. **Rol de autoridad y capability también serán conceptos separados**: JEV compondrá capacidades técnicas sobre pocos roles estables en lugar de crear un agente distinto por tecnología/proveedor.

---

## 16. Verificación real

El Verifier deberá recopilar evidencia real según aplique:

- CI/checks;
- unit tests;
- integration tests;
- backend/API;
- database;
- browser/E2E;
- build;
- visual result.

La verificación no podrá depender solo del texto generado por el Developer.

Un build correcto no equivale a implementación completa.

---

## 17. Multiagent

Para trabajo complejo JEV soportará:

- DAG de dependencias;
- handoffs;
- shared state;
- locks;
- parallel work;
- conflict detection;
- conflict resolution;
- Architect/Developer/Verifier/Integrator.

Los agentes no podrán sobrescribir recursos con locks incompatibles.

---

## 18. Audit y Attention Center

La auditoría será append-only.

Registrar, como mínimo:

- actor;
- acción;
- target;
- project/task;
- timestamp;
- result;
- risk;
- provider/model;
- cost;
- approval;
- evidence references.

Attention Center deberá reunir aquello que requiere intervención:

- approvals;
- bloqueos;
- fallos;
- budget alerts;
- stale evidence;
- conflictos;
- incidentes.

---

## 19. Dashboard y Project Control Center

Navegación mínima:

- Dashboard
- Projects
- Orders
- Agents
- Approvals
- Quality
- GitHub
- Costs
- Reports
- Clients
- Settings

Cada Project Control Center deberá exponer:

- Overview
- Orders
- Requirements
- Tasks
- GitHub
- Agents
- Staging
- Quality
- Costs
- Activity
- Settings

---

## 20. Quality Center

Quality Center deberá basarse en evidencia real y trazabilidad.

Deberá mostrar:

- Requirement → code → test → verification;
- missing;
- failed;
- unverified;
- CI status;
- staging readiness;
- defects/regressions;
- production promotion status.

---

## 21. Command Center y Control Layer

Command Center acepta lenguaje natural, pero no ejecuta directamente.

Flujo:

```
Natural language
→ structured intent
→ validation
→ authorization
→ Control Layer command
→ execution
```

Command Center es un subconjunto seguro del Control Layer y no tiene que exponer todas las acciones internas.

Toda acción sensible podrá requerir confirmación adicional.

---

## 22. Multimodal Intake

JEV deberá aceptar:

- text;
- image;
- screenshot;
- file;
- link.

Attachment roles:

- CURRENT_BASE
- EDIT_TARGET
- STYLE_REFERENCE
- DESIRED_RESULT
- REQUIREMENT_DOCUMENT

Work types:

- GENERAL
- IMAGE_REPLACEMENT
- IMAGE_GENERATION
- IMAGE_EDIT
- UI_REFERENCE_REDESIGN

JEV deberá conservar inequívocamente qué asset es original, cuál es target y cuál es referencia.

Todo cambio visual deberá llegar a staging y revisión humana antes de producción.

---

## 23. Channels

Canales previstos:

- Web
- Telegram
- WhatsApp

Los Channel Adapters solo transportan entrada/salida.

```
Channel
→ Multimodal Intake
→ Work Order / Command
→ Control Layer
→ JEV
```

Ningún Channel Adapter ejecutará directamente GitHub, agentes, Docker, provider calls o deploy.

Telegram y WhatsApp reales son responsabilidades Platform, no Foundation.

---

## 24. Secrets, observability, security y recovery

Platform deberá implementar:

- secrets management;
- credenciales scoped;
- structured logs;
- correlation IDs;
- metrics;
- security review;
- authz/tenant/command-injection tests;
- backups;
- restore;
- deployment rollback;
- audited rollback.

---

## 25. Contract Drift Prevention

JEV deberá comprobar automáticamente coherencia entre runtime, schemas, policies y documentación.

Como mínimo:

- lifecycle;
- risk levels;
- Control Actions;
- Command Center actions;
- Work Order states/types;
- Notification categories;
- approval rules.

El drift crítico deberá bloquear release.

---

## 26. Pilotos

Orden:

1. controlled pilot repository;
2. Espacore;
3. Nuvurent;
4. JEV self-development.

JEV solo podrá trabajar sobre su propio repositorio posteriormente y bajo la política de mayor riesgo, con Verifier independiente, aprobación humana y rollback probado.

---

## 27. MVP real

El MVP deberá demostrar:

```
Order
→ Task
→ real workspace
→ real AI provider
→ implementation
→ tests
→ PR
→ independent verification
→ permanent staging
→ staging evidence
→ human review
→ selective promotion
→ production
→ DONE
→ costs/audit
```

No se considerará MVP un agente que solamente escribe código.

---

## 28. Métricas de éxito

- tareas completadas end-to-end;
- % con trazabilidad completa;
- verificación independiente;
- CI first-pass;
- coste por Task/Project;
- budget stops correctos;
- defectos detectados antes de producción;
- stale approvals bloqueadas;
- promociones selectivas correctas;
- tiempo Order → DONE;
- incidentes y rollback.

---

## 29. Fuera de alcance inicial

No forma parte del MVP:

- contabilidad completa;
- payroll;
- marketplace de agentes;
- IDE completo;
- reemplazo de GitHub;
- entrenamiento propio de modelos;
- autonomía irrestricta de JEV sobre sí mismo.

---

## 30. Intent Compiler y Acceptance Contracts

Toda orden deberá pasar por un refinamiento proporcional antes de convertirse en ejecución.

JEV deberá producir un `IntentBrief` con objetivo, alcance, exclusiones, contexto observado, supuestos, preguntas abiertas, ambigüedad, radio de cambio, señales de riesgo, profundidad documental y evidencia necesaria.

La profundidad será proporcional:

- L0 — cambio local/directo;
- L1 — acceptance brief;
- L2 — task specification;
- L3 — cambio de SPEC/arquitectura;
- L4 — cambio de producto/roadmap.

Una ambigüedad material deberá bloquear ejecución en vez de ser rellenada por el modelo.

Después del IntentBrief, JEV deberá producir un `AcceptanceContract` con criterios observables, restricciones, no-objetivos, compatibilidad, requisitos afectados y evidencia requerida.

---

## 31. Execution Blueprint, Adaptive Workflow y Context Compiler

Cada tarea no trivial deberá poder disponer de un `ExecutionBlueprint` versionado con objetivo, pasos, DAG, dependencias, parallel groups, recursos afectados, capabilities, evidencia, rollback y exit criteria.

Los workflows no serán plantillas rígidas: JEV deberá compilar un `AdaptiveWorkflow` desde intención, riesgo, radio de cambio, capabilities disponibles, constraints, evidencia y budget. El riesgo podrá aumentar profundidad/gates, nunca reducir controles obligatorios.

Si aparecen nuevos hechos, JEV deberá crear una `PlanRevision` append-only, revalidar DAG, locks, riesgo, budget, evidencia y approvals, e impedir ejecución sobre una revisión obsoleta.

Cada agente recibirá un `ContextPack` acotado y trazable. La recuperación deberá ser iterativa y presupuestada; ausencia de contexto REQUIRED bloqueará ejecución.

---

## 32. Capability Composition, Harness Contracts y Artifact Workspace

JEV mantendrá pocos roles de autoridad y compondrá capabilities técnicas por tarea. Una capability no podrá elevar permisos por encima del role/policy ceiling.

Claude Code, Codex, Cursor y futuros harnesses serán superficies de ejecución reemplazables. Cada adapter deberá declarar capabilities y limitaciones reales. Si falta una capability requerida, JEV deberá producir un resultado typed BLOCKED/UNSUPPORTED.

PRD, SPEC, ROADMAP, ADR, Execution Blueprint, UI evidence, verification reports y propuestas de mejora deberán ser revisables mediante conversación/anotaciones ligadas a una revisión exacta.

APPROVE, REQUEST_CHANGES y REJECT deberán ser decisiones explícitas; nunca se inferirán del tono de una conversación.

---

## 33. Living Documentation, Decision Ledger y Requirement Graph

JEV deberá mantener una trazabilidad canónica:

```
Business Goal
→ PRD Capability
→ SPEC Requirement
→ ADR
→ ROADMAP Phase
→ Task
→ Code
→ Test
→ Evidence
→ Release
```

Los cambios deberán calcular impacto upstream/downstream y detectar drift entre documentación, backlog, implementación, tests y evidencia.

Las decisiones materiales deberán vivir en un ledger append-only con alternativas, rationale, evidencia, actor, scope, artefactos afectados y relaciones de supersesión.

Quality Center deberá consumir este grafo canónico en lugar de reconstruir estado empresarial desde flags manuales.

---

## 34. Evidence-Based Learning y Self-Improvement

JEV distinguirá entre Observation, Hypothesis, Pattern, Project Rule, Global Rule, Skill Candidate y Policy Candidate.

El aprendizaje deberá registrar scope, confidence, evidence, contradictions y source events. Ningún aprendizaje global podrá autoactivarse.

Las propuestas de mejora deberán surgir de fallos repetidos, correcciones, coste, latencia, overlap, capacidades ausentes o reglas obsoletas y deberán incluir beneficio esperado, riesgo, contratos afectados, rollback y evaluation plan.

Antes de promover una mejora, JEV deberá comparar baseline vs candidate sobre el mismo replay corpus versionado. Regresiones críticas de seguridad o calidad tendrán veto aunque el candidato sea más barato o rápido.

El self-improvement seguirá obligatoriamente:

```
proposal
→ artifact review
→ counterfactual benchmark
→ human approval
→ isolated canary
→ monitoring
→ promote OR rollback
```

JEV no podrá modificar unilateralmente authorization, audit, risk gates, verifier independence, human approval ni otras salvaguardas protegidas.

---

## 35. Repository Hygiene y Clean Repository Gate

La Definition of Done deberá incluir higiene del repositorio.

JEV deberá detectar y clasificar:

- dead-code candidates;
- orphan files;
- temporary/debug artifacts;
- exact/semantic duplication;
- unused dependencies cuando el stack lo permita;
- obsolete test artifacts;
- stale TODO/FIXME;
- generated-file drift;
- código reemplazado que quedó abandonado.

Antes de crear una nueva función, clase, componente, servicio, endpoint o archivo, JEV deberá buscar candidatos reutilizables/extensibles y registrar una `ReuseDecision`.

Un refactor deberá declarar added/replaced/removed/retained-for-compatibility. Reemplazar sin retirar ni justificar el legado será `INCOMPLETE_CLEANUP`.

El sistema no deberá auto-eliminar código incierto, dinámico, reflection/config-driven o plugin-driven únicamente por ausencia de referencias estáticas.

Repository Health deberá mantener baseline/delta de cleanup debt para impedir que la deuda aumente silenciosamente.

---

## 36. Criterio de éxito del producto

JEV será operacional cuando pueda completar el circuito MVP con integraciones reales, mostrar evidencia y costes, impedir bypass de aprobación/promoción, gobernar workflows adaptativos y administrar al menos un proyecto multi-repo desde el dashboard.

Además, deberá demostrar que:
- el workflow elegido es proporcional al trabajo;
- el contexto utilizado es suficiente y acotado;
- los cambios quedan trazados hasta requisito/evidencia;
- una propuesta de auto-mejora no puede auto-promocionarse;
- repository hygiene bloquea duplicación/basura no justificada.
