# JEV Development Platform — ROADMAP

**Versión:** 1.0  
**Estado:** Roadmap canónico  
**Rama:** `jev-foundation`  
**Fecha:** 2026-09-27

## Principio de ejecución

El desarrollo se realizará por capas completas y verificables.

No se avanzará a automatización agresiva mientras no existan estado determinista, permisos, trazabilidad, límites, pruebas y auditoría.

Cada fase tendrá criterios de salida obligatorios.

# Fase 0 — Fundación de gobernanza

**Estado:** en progreso avanzado.

## Objetivo

Convertir `base-skills_klever` de documentación en contratos consumibles por JEV.

## Alcance

- manifest de skills;
- 43 skills registradas;
- Agent Registry inicial;
- schemas;
- risk R0-R4;
- task planner;
- model router policy;
- run guard;
- locks;
- GitHub guard;
- workspace contract;
- requirement traceability;
- state machine;
- CI.

## Criterio de salida

- todas las skills registradas;
- CI verde;
- tests del planificador;
- tests de riesgo;
- tests de locks;
- tests de permisos GitHub;
- state machine sin bypass.

# Fase 1 — JEV Core

## Objetivo

Crear el backend que mantiene estado real.

## Entregables

- proyecto backend;
- configuración;
- PostgreSQL;
- migrations;
- health checks;
- entidades Organization, User, Client, Project, Repository, Order, Requirement, Task, TaskRun, Approval, AuditEvent y CostEvent;
- API inicial de proyectos, clientes, órdenes, tareas, estados y auditoría;
- runtime persistente del orquestador.

## Criterio de salida

Crear una orden vía API y obtener una tarea persistida con riesgo, agentes, skills, modelo sugerido, gates e historial.

# Fase 2 — GitHub Engine

## Objetivo

Permitir que JEV opere de forma segura sobre repositorios reales.

## Entregables

- GitHub App;
- instalación por organización/repositorio;
- tokens temporales;
- listado de repositorios;
- lectura de árbol;
- lectura/escritura de archivos;
- crear branch;
- commits;
- PR;
- checks;
- Actions;
- comentarios/reviews;
- merge guard.

## Criterio de salida

Desde una tarea JEV debe poder:

```
crear branch
→ hacer un cambio controlado
→ commit
→ push
→ PR
→ leer CI
```

sin tocar main.

# Fase 3 — Workspace Engine

## Objetivo

Permitir que los agentes ejecuten y prueben código realmente.

## Entregables

- Docker worker;
- clonación de repo;
- checkout de branch;
- instalación de dependencias;
- comandos permitidos;
- timeout;
- límite de CPU/RAM;
- red restringida;
- secrets scope;
- cleanup;
- logs.

## Criterio de salida

```
crear workspace
→ clonar
→ instalar
→ modificar
→ build
→ test
→ obtener diff
→ destruir workspace
```

# Fase 4 — Model Gateway

## Objetivo

Conectar modelos sin acoplar el sistema a un proveedor.

## Adapters iniciales

- DeepSeek
- GLM
- Qwen
- OpenAI/Codex

## Funciones

- chat;
- tool calling;
- structured outputs cuando estén disponibles;
- uso/tokens;
- coste;
- timeout;
- retry;
- fallback;
- circuit breaker.

## Criterio de salida

El mismo Developer Agent deberá poder ejecutar una tarea equivalente usando al menos dos proveedores distintos sin cambiar su contrato.

# Fase 5 — Developer Agent Runtime

## Objetivo

Implementar el primer agente que modifica software end-to-end.

## Flujo

```
Task
→ context
→ skills
→ workspace
→ model
→ edit
→ test
→ self-check
→ commit
→ PR
```

## Criterio de salida

Developer deberá resolver una tarea R0/R1 real en un repositorio de prueba y crear un PR válido.

# Fase 6 — Verification Agent

## Objetivo

Evitar falsos "terminado".

## Entregables

- lectura de criterios de aceptación;
- requirement trace;
- diff inspection;
- CI inspection;
- test execution;
- E2E;
- backend/frontend integration checks;
- resultado VERIFIED / FAILED / BLOCKED;
- evidence bundle.

## Criterio de salida

El Verifier deberá detectar automáticamente una implementación deliberadamente incompleta aunque el código compile.

# Fase 7 — Orquestación multiagente

## Objetivo

Coordinar tareas que necesitan varios roles.

## Entregables

- Architect runtime;
- Integrator runtime;
- handoffs;
- shared state;
- file locks;
- dependency graph;
- parallel execution;
- conflict handling;
- consensus R3/R4.

## Criterio de salida

Una orden compleja deberá dividirse en varias tareas y ejecutarse sin que dos agentes se pisen recursos bloqueados.

# Fase 8 — Dashboard empresarial MVP

## Navegación

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

## Criterio de salida

El usuario podrá dirigir un proyecto sin entrar a GitHub para operaciones normales.

# Fase 9 — Project Control Center

## Secciones

- Overview
- Orders
- Requirements
- Tasks
- GitHub
- Agents
- Quality
- Costs
- Activity
- Settings

## Criterio de salida

Espacore y Nuvurent deberán poder gestionarse como proyectos independientes dentro de una única instancia JEV.

# Fase 10 — Aprobaciones y supervisión humana

## Entregables

- approval inbox;
- diff/impact summary;
- approve;
- reject;
- request changes;
- audit trail;
- R4 enforcement.

## Criterio de salida

Una operación R4 no podrá completarse desde API, agente ni UI sin aprobación registrada.

# Fase 11 — Cost Control

## Entregables

- coste por request;
- coste por run;
- coste por task;
- coste por project;
- coste por client;
- coste por provider/model;
- budget alerts;
- hard stop;
- cost forecast.

## Criterio de salida

El administrador podrá fijar un presupuesto de proyecto y JEV deberá detener automáticamente trabajo adicional al alcanzar el hard stop.

# Fase 12 — Quality Center

## Entregables

- requirement coverage;
- CI status;
- failed tests;
- regression history;
- verification coverage;
- unresolved defects;
- PR quality;
- technical debt signals.

## Criterio de salida

JEV deberá poder responder objetivamente qué parte del PRD/SPEC todavía no está verificada.

# Fase 13 — Reporting

## Reportes

- project status;
- monthly development;
- costs;
- quality;
- requirements;
- incidents;
- agent performance.

## Criterio de salida

Generar un reporte mensual de proyecto sin recopilar manualmente información de GitHub, agentes y costes.

# Fase 14 — Command Center

## Ejemplos

- "Pausa Nuvurent."
- "Prioriza Espacore."
- "Audita las tareas fallidas."
- "No gastes más de CHF 20 hoy."
- "Manda TASK-423 a Codex."
- "Muéstrame todos los requisitos no verificados."

## Criterio de salida

Cada orden deberá convertirse en acciones explícitas, auditables y sujetas a permisos.

# Fase 15 — Nuevos proyectos desde cero

## Flujo

```
Idea
→ Product brief
→ PRD
→ SPEC
→ ROADMAP
→ arquitectura
→ repository
→ project
→ backlog
→ desarrollo
```

## Criterio de salida

Desde una descripción de producto, JEV podrá preparar un proyecto listo para iniciar implementación.

# Fase 16 — Empresa multiusuario

## Entregables

- equipos;
- roles;
- responsables;
- clientes;
- acceso cliente;
- actividad por usuario;
- delegación;
- ownership;
- SLA internos;
- métricas operativas.

## Criterio de salida

Más de una persona podrá gestionar proyectos concurrentes sin acceso indebido entre clientes.

# Prioridad de construcción

```
0  Fundación
1  JEV Core
2  GitHub Engine
3  Workspace Engine
4  Model Gateway
5  Developer Agent
6  Verification Agent
7  Multiagent
8  Dashboard MVP
9  Project Control Center
10 Approvals
11 Costs
12 Quality
13 Reports
14 Command Center
15 New Project Factory
16 Multiuser Company
```

# MVP real

El MVP no es una simple interfaz. Debe cerrar este circuito:

```
Usuario crea orden
      ↓
JEV genera task
      ↓
clasifica riesgo
      ↓
resuelve skills
      ↓
elige agente/modelo
      ↓
crea branch/workspace
      ↓
agente implementa
      ↓
tests
      ↓
PR
      ↓
Verifier
      ↓
PASS / FAIL
      ↓
aprobación si aplica
      ↓
DONE
      ↓
dashboard + coste + trazabilidad
```

# Piloto recomendado

1. repositorio de prueba controlado;
2. Espacore para tareas de riesgo bajo/medio;
3. Nuvurent para flujos más complejos;
4. JEV sobre sí mismo solo después de demostrar controles de aislamiento, verificación y rollback.

# Definition of Done global

Una funcionalidad de JEV solo se considera terminada cuando:

- requisitos asociados identificados;
- código implementado;
- tests correctos;
- CI verde;
- seguridad revisada cuando aplique;
- UI/backend conectados cuando aplique;
- trazabilidad actualizada;
- auditoría registrada;
- documentación mínima actualizada;
- Verifier aprobado;
- aprobación humana completada cuando aplique.
