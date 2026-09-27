# JEV Development Platform — ROADMAP

**Versión:** 2.0  
**Estado:** Canonical Development Roadmap  
**Rama:** `jev-foundation`  
**Fecha:** 2026-09-27

---

## 1. Reglas del roadmap

Este roadmap implementa los contratos Foundation en `jev-platform`.

Ninguna fase se considera terminada por existir un contrato Foundation. Cada fase Platform requiere runtime/integración real y exit criteria verificable.

La trazabilidad objetivo es:

```
PRD capability
→ SPEC REQ
→ ROADMAP phase
→ PLT backlog task
→ future Task/Test/Evidence
```

No iniciar PLT-002 hasta aceptación manual de PLT-001.

---

# Fase 1 — Document Freeze

**Backlog:** PLT-001  
**Dependencia:** FND-032 DONE

## Objetivo
Congelar PRD/SPEC/ROADMAP alineados con Foundation final.

## Incluye
- Foundation/Platform boundary;
- lifecycle final;
- permanent staging;
- human approval;
- selective promotion;
- multi-repo;
- multimodal/channels;
- contract drift.

## Exit criteria
- PRD/SPEC/ROADMAP misma versión;
- IDs SPEC únicos;
- no contradicciones críticas;
- PLT backlog compatible;
- revisión manual aceptada.

---

# Fase 2 — Platform Skeleton

**Backlog:** PLT-002  
**Depende de:** PLT-001

## Objetivo
Crear estructura de Web, API, workers y packages compartidos.

## Exit criteria
- local development inicia;
- servicios separados;
- health checks;
- CI base verde.

---

# Fase 3 — PostgreSQL Canonical Persistence

**Backlog:** PLT-003  
**Depende de:** PLT-002

## Objetivo
Crear estado empresarial persistente.

## Exit criteria
Persisten y migran entidades canónicas, incluyendo Organization, User, Client, Project, Repository, Environment, Order, Requirement, Task, TaskRun, Approval, Promotion, AuditEvent, CostEvent y Notification.

---

# Fase 4 — Authentication + RBAC

**Backlog:** PLT-004  
**Depende de:** PLT-003

## Exit criteria
- login real;
- roles server-side;
- project/client scope;
- pruebas de autorización.

---

# Fase 5 — Control Plane + Audit Base

**Backlog principal:** PLT-005 + base temprana de PLT-030  
**Depende de:** PLT-003, PLT-004

## Objetivo
Centralizar commands, authz y audit desde el principio.

## Exit criteria
- API → Control Layer;
- ninguna mutation bypassa authorization;
- errores estables;
- mutations emiten audit append-only.

---

# Fase 6 — Queue / Workers

**Backlog:** PLT-006  
**Depende de:** PLT-003

## Exit criteria
- long jobs fuera del request thread;
- retry/idempotency;
- persistent worker state;
- correlation IDs.

---

# Fase 7 — Project Registry / Multi-Repo / Environments

**Backlog:** PLT-007  
**Depende de:** PLT-003, FND-024/FND-025

## Exit criteria
- proyectos persistentes;
- múltiples repos;
- roles frontend/backend/infra/other;
- environments por project/repository.

---

# Fase 8 — Work Orders / Tasks Persistence

**Backlog:** PLT-008  
**Depende de:** PLT-003

## Exit criteria
- Work Orders/Tasks persistentes;
- lifecycle completo;
- acceptance criteria/REQ IDs;
- history;
- illegal transition rejection.

---

# Fase 9 — Secrets Management

**Backlog:** PLT-032  
**Depende de:** PLT-002

## Exit criteria
- provider/GitHub/hosting secrets fuera del repo;
- scoped injection;
- production secrets excluidos de development workspaces.

---

# Fase 10 — Real Model Gateway

**Backlog:** PLT-009 + PLT-017 para budget integration  
**Depende de:** skeleton + Foundation provider profiles

## Objetivo
Adapters reales DeepSeek, OpenAI/Codex, Qwen y GLM.

## Exit criteria
- DeepSeek y OpenAI/Codex end-to-end;
- Qwen/GLM habilitables sin cambiar agent contracts;
- timeout/retry/typed errors/fallback/circuit breaker;
- usage/cost;
- budget guard antes de paid calls.

---

# Fase 11 — GitHub App

**Backlog:** PLT-010  
**Depende de:** PLT-002, secrets

## Exit criteria
- install flow;
- installation tokens temporales;
- branch/commit/PR/check/merge reales;
- direct main/master impossible;
- audit.

---

# Fase 12 — Workspace Engine

**Backlog:** PLT-011  
**Depende de:** PLT-006, PLT-010, secrets

## Exit criteria
- container por writable Task;
- repo/branch asignados;
- install/test;
- CPU/RAM/network/timeout;
- scoped secrets;
- cleanup.

---

# Fase 13 — Architect + Developer Runtime

**Backlog:** PLT-014 + Architect Platform runtime requerido por SPEC  
**Depende de:** Model Gateway, GitHub App, Workspace Engine

## Exit criteria
- plan estructurado;
- context/skills;
- Developer modifica proyecto real de prueba;
- tests;
- commit + PR;
- cost/audit/traceability.

---

# Fase 14 — Real Verification Engine

**Backlog:** PLT-015  
**Depende de:** workspace + staging prerequisites

## Exit criteria
- Verifier independiente read-only;
- collectors reales CI/unit/integration/API/DB/browser/E2E;
- evidence bundle;
- incomplete implementation rejected aunque build pase.

---

# Fase 15 — Permanent Staging

**Backlog:** PLT-012  
**Depende de:** Project Registry, GitHub App, staging Foundation contracts

## Exit criteria
- staging permanente por proyecto;
- staging branch;
- URL online;
- backend staging;
- staging DB separada;
- migrations/seeds;
- health checks;
- online E2E;
- readiness evidence.

---

# Fase 16 — Human Review / Approval

**Backlog:** PLT-021  
**Depende de:** PLT-012, Dashboard base

## Exit criteria
- exact staging URL/evidence/revision visible;
- APPROVED / CHANGES_REQUESTED / REJECTED;
- stale approval invalidation;
- no production bypass.

---

# Fase 17 — Selective Promotion / Production

**Backlog:** PLT-013  
**Depende de:** staging + approval + FND-028

## Exit criteria
- Promotion ligada a Task/source PR/approved commit/migrations/approval;
- production PR task-specific;
- no whole-staging promotion;
- PROMOTED_TO_MAIN requerido para DONE;
- rollback path.

---

# Fase 18 — Budget / Costs

**Backlog:** PLT-017 + PLT-023  
**Depende de:** PostgreSQL + Model Gateway

## Exit criteria
- budgets persistentes;
- hard stop real;
- warnings/audit;
- costes por project/order/task/provider/model/period.

---

# Fase 19 — Notifications / Attention Center

**Backlog:** PLT-018  
**Depende de:** PostgreSQL + audit/control events

## Exit criteria
- notifications automáticas;
- approvals/failures/budgets/stale evidence;
- links al contexto correcto.

---

# Fase 20 — Multiagent / Conflicts

**Backlog:** PLT-016  
**Depende de:** Developer + Verifier

## Exit criteria
- Architect/Developer/Verifier/Integrator reales;
- DAG;
- locks;
- handoffs;
- parallel work;
- conflict resolution.

---

# Fase 21 — Dashboard

**Backlog:** PLT-019  
**Depende de:** Control Plane, Project Registry, Tasks, Notifications

## Exit criteria
Dashboard muestra Projects, Orders, running/blocked Tasks, approvals, staging, costs y Attention Center desde read models/API canónicos.

---

# Fase 22 — Project Control Center

**Backlog:** PLT-020  
**Depende de:** Dashboard

## Exit criteria
Overview, Orders, Requirements, Tasks, GitHub, Agents, Staging, Quality, Costs, Activity y Settings por proyecto.

---

# Fase 23 — Quality Center

**Backlog:** PLT-022  
**Depende de:** Verification + Dashboard

## Exit criteria
- Requirement→code→test→verification visible;
- missing/unverified/failed filterable;
- staging/promotion state visible.

---

# Fase 24 — Reports

**Backlog:** PLT-023  
**Depende de:** canonical data + Dashboard

## Exit criteria
Project report reproducible desde datos canónicos con calidad, progreso, costes y promotion status.

---

# Fase 25 — Command Center

**Backlog:** PLT-024  
**Depende de:** Control Plane + Foundation command contracts

## Exit criteria
natural language → structured intent → validation → authorization → Control Layer execution; ambiguous/sensitive confirmation; audit completo.

---

# Fase 26 — Multimodal Intake

**Backlog:** PLT-025  
**Depende de:** Control Plane + Foundation multimodal contracts

## Exit criteria
Text/image/screenshot/file/link; attachment roles; visual work types; Work Orders estructurados.

---

# Fase 27 — Image Workflows

**Backlog:** PLT-028, PLT-029  
**Depende de:** Multimodal Intake

## Exit criteria
- generation/edit provider real;
- original/target/reference preservados;
- target component definido;
- assets linked;
- staging review obligatorio.

---

# Fase 28 — Telegram / WhatsApp

**Backlog:** PLT-026, PLT-027  
**Depende de:** Multimodal Intake

## Exit criteria
- adapters reales;
- input/output solamente;
- no bypass de auth/control/audit;
- staging review links soportados.

---

# Fase 29 — Observability + Security Hardening

**Backlog:** PLT-031, PLT-033  
**Depende de:** skeleton/workers/auth/GitHub/workspace/secrets

## Exit criteria
- structured logs;
- correlation IDs;
- latency/error/job/cost metrics;
- authz/tenant/secrets/command injection tests;
- critical findings block release.

---

# Fase 30 — Backups / Rollback

**Backlog:** PLT-034  
**Depende de:** PostgreSQL, staging, promotion

## Exit criteria
- backup/restore probado;
- failed deployment rollback;
- audited rollback.

---

# Fase 31 — Controlled Pilot Repo

**Backlog:** PLT-035  
**Depende de:** core end-to-end stack

## Exit criteria

```
Order
→ Task
→ real workspace
→ real provider
→ implementation
→ tests
→ PR
→ independent verification
→ permanent staging
→ readiness evidence
→ human review
→ selective production promotion
→ PROMOTED_TO_MAIN
→ DONE
→ costs/audit/traceability
```

---

# Fase 32 — Espacore

**Backlog:** PLT-036  
**Depende de:** controlled pilot

## Exit criteria
- Espacore staging/test data;
- una Task real low/medium-risk end-to-end;
- production human-gated.

---

# Fase 33 — Nuvurent

**Backlog:** PLT-037  
**Depende de:** Espacore

## Exit criteria
- staging DB/test users;
- workflow real con persistencia;
- end-to-end evidence.

---

# Fase 34 — JEV Self-Development Safety Mode

**Backlog:** PLT-038  
**Depende de:** Nuvurent + security + backup/rollback

## Exit criteria
- highest-risk policy;
- independent Verifier;
- mandatory human approval;
- proven rollback;
- JEV no puede debilitar sus propios gates unilateralmente.

---

# Fase 35 — MVP Release Readiness

**Backlog:** PLT-039  
**Depende de:** P0 gates del master backlog

## Exit criteria
- end-to-end MVP demostrado;
- P0 release gates verdes;
- contract drift checks verdes;
- limitaciones conocidas documentadas.

---

## Definition of Done global

Una capability Platform solo se considerará terminada cuando:

- SPEC REQs asociados identificados;
- implementación real;
- tests;
- CI;
- evidence;
- security review cuando aplique;
- audit;
- docs actualizados;
- staging/human review/promotion cuando el cambio afecte producción.

---

## Estado después de PLT-001

Después de aceptar manualmente esta actualización documental:

- Foundation: release-ready;
- Platform docs: frozen v2.0;
- PLT-001: elegible para cerrar;
- PLT-002: siguiente tarea, **pero no debe iniciarse automáticamente**.
