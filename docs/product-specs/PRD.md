# JEV Development Platform — PRD

**Versión:** 1.0  
**Estado:** Draft canónico de producto  
**Rama:** `jev-foundation`  
**Fecha:** 2026-09-27

## 1. Visión

JEV será una plataforma para dirigir una empresa de desarrollo de software asistida por IA.

El usuario no tendrá que coordinar manualmente modelos, agentes, ramas, pruebas o revisiones. JEV recibirá órdenes de trabajo, decidirá cómo ejecutarlas, controlará riesgos y costes, coordinará agentes especializados, trabajará sobre repositorios GitHub y mantendrá trazabilidad completa desde el requisito hasta la verificación final.

**Principio central:** los modelos no gobiernan JEV. JEV gobierna los modelos.

Los proveedores de IA son trabajadores reemplazables. El control de estado, permisos, costes, calidad, decisiones, aprobaciones y trazabilidad pertenece a JEV.

## 2. Problema que resuelve

Los principales problemas que JEV debe resolver son:

- una IA puede afirmar que una tarea está terminada sin comprobar frontend, backend, API o base de datos;
- varios agentes pueden modificar el mismo código y generar conflictos;
- no existe una visión empresarial consolidada de proyectos, estados, costes y entregas;
- los cambios pueden perder la relación con PRD/SPEC;
- es difícil saber qué modelo trabajó, cuánto costó y por qué se eligió;
- los agentes pueden exceder presupuestos o realizar acciones sensibles sin control suficiente;
- GitHub registra código, pero no necesariamente la intención de negocio ni el estado operativo completo;
- el dueño del producto termina actuando como coordinador manual de agentes.

## 3. Objetivos del producto

JEV deberá permitir:

1. administrar múltiples clientes y proyectos;
2. conectar cada proyecto a uno o varios repositorios GitHub;
3. crear órdenes de trabajo en lenguaje natural;
4. convertir cada orden en tareas trazables;
5. clasificar automáticamente el riesgo de cada tarea;
6. seleccionar las skills aplicables;
7. seleccionar agentes adecuados;
8. seleccionar el modelo de IA apropiado según coste, capacidad y riesgo;
9. ejecutar cambios en ramas y workspaces aislados;
10. ejecutar pruebas automáticas;
11. verificar independientemente el resultado;
12. bloquear integración cuando no se cumplan los requisitos;
13. requerir aprobación humana en operaciones críticas;
14. mostrar todo el proceso en un dashboard empresarial;
15. registrar costes, actividad, estados, fallos y decisiones;
16. generar reportes operativos y ejecutivos;
17. permitir crear proyectos nuevos y trabajar sobre repositorios existentes;
18. mantener una historia auditable de quién hizo qué, cuándo y por qué.

## 4. Usuarios

### Administrador / Propietario
Puede crear clientes y proyectos, conectar repositorios, crear órdenes, definir presupuestos, aprobar operaciones críticas, detener agentes, cambiar prioridades, ver costes, generar reportes y acceder a auditoría completa.

### Project Manager
Puede gestionar backlog, crear y priorizar órdenes, revisar bloqueos, gestionar entregas, consultar calidad y progreso y solicitar reintentos o auditorías.

### Developer humano
Puede recibir tareas, trabajar junto a agentes, consultar contexto, crear ramas y PR, ver fallos de CI y responder a revisiones.

### Auditor / QA
Puede revisar requisitos, consultar cambios, ejecutar o revisar pruebas, aprobar o rechazar verificación y registrar hallazgos.

### Cliente
Opcionalmente podrá ver progreso autorizado, revisar entregas, aprobar hitos, descargar reportes y dejar comentarios.

## 5. Estructura empresarial

```
Organización
 ├── Clientes
 │    └── Proyectos
 │         ├── Repositorios
 │         ├── Órdenes
 │         ├── Requisitos
 │         ├── Tareas
 │         ├── Agentes
 │         ├── Costes
 │         ├── Entregas
 │         └── Reportes
 └── Configuración global
```

Un proyecto puede existir sin cliente cuando se trate de un producto interno.

## 6. Dashboard principal

El dashboard deberá mostrar, como mínimo:

- proyectos activos;
- órdenes abiertas;
- tareas en ejecución;
- tareas bloqueadas;
- tareas pendientes de aprobación;
- tareas fallidas;
- tareas completadas;
- coste de IA del periodo;
- presupuesto consumido;
- PR pendientes;
- incidentes críticos;
- actividad reciente.

El dashboard deberá priorizar excepciones y decisiones necesarias, no solamente métricas.

## 7. Proyectos

Cada proyecto deberá incluir nombre, cliente, estado, prioridad, responsables, repositorios conectados, stack, entornos, PRD, SPEC, roadmap, presupuesto, configuración de modelos, reglas específicas, actividad reciente y métricas de calidad.

Ejemplos: Espacore Web, Nuvurent, Cleaning Planner y JEV.

## 8. Órdenes de trabajo

El usuario podrá crear órdenes en lenguaje natural.

Ejemplo:

> Revisa el formulario de contacto de Espacore. Nombre, email, teléfono y PLZ deben ser obligatorios y quiero comprobar que los datos llegan correctamente al backend.

JEV deberá transformar la orden en una estructura controlada con objetivo, proyecto, alcance, prioridad, criterios de aceptación, restricciones, riesgos, requisitos relacionados y tareas derivadas.

## 9. Ciclo de una tarea

```
PLANNED
  ↓
READY
  ↓
RUNNING
  ↓
VERIFYING
  ↓
VERIFIED
  ↓
DONE
```

Estados adicionales: BLOCKED y FAILED.

No se permitirá marcar una tarea como DONE sin cumplir sus gates.

## 10. Riesgo

JEV usará cinco niveles:

- **R0:** cambio local, simple y reversible.
- **R1:** cambio normal con verificación independiente.
- **R2:** cambio con impacto entre capas.
- **R3:** cambio sensible, como auth, permisos o multi-tenant.
- **R4:** cambio crítico, como producción, eliminación de datos, migración destructiva o acción irreversible.

R4 requerirá aprobación humana.

## 11. Skills Engine

JEV utilizará `base-skills_klever` como constitución operativa.

Cada tarea deberá cargar únicamente las skills pertinentes más las obligatorias. El sistema deberá resolver prioridades, detectar conflictos, cargar dependencias y registrar qué skills gobernaron cada ejecución.

## 12. Agentes

Agentes iniciales:

- Architect
- Developer
- Verifier
- Integrator

Agentes futuros:

- Frontend
- Backend
- Database
- Security
- QA
- UX
- Documentation
- DevOps
- Product Analyst

El rol del agente deberá estar separado del modelo de IA utilizado.

## 13. Model Router

JEV deberá decidir qué modelo usar según riesgo, tipo de tarea, capacidades, contexto requerido, coste, presupuesto restante, disponibilidad y rendimiento histórico.

Un agente no estará permanentemente vinculado a un proveedor.

## 14. GitHub

GitHub será la fuente de verdad del código.

JEV deberá poder leer repositorios, crear repositorios, crear ramas, leer/escribir archivos, crear commits, crear PR, consultar checks, solicitar revisiones, leer resultados de Actions e integrar cambios autorizados.

Reglas:

- ningún agente escribe directamente a `main`;
- cada tarea usa una rama;
- el trabajo se integra mediante PR;
- un agente no puede aprobar su propio trabajo crítico;
- R4 requiere aprobación humana.

## 15. Workspaces

Cada ejecución deberá usar un entorno aislado para evitar contaminación entre tareas, ejecutar el proyecto, instalar dependencias, ejecutar pruebas, detectar errores reales y destruir el entorno al finalizar.

## 16. Verificación

La verificación es una función independiente del desarrollo.

El Verifier deberá comprobar, según aplique:

- requisito PRD/SPEC;
- backend;
- frontend;
- API;
- base de datos;
- seguridad;
- tests unitarios;
- integración;
- E2E;
- build;
- comportamiento visual.

Una tarea no deberá considerarse terminada simplemente porque el código compile.

## 17. Trazabilidad

```
REQ
 ↓
ORDER
 ↓
TASK
 ↓
BRANCH
 ↓
COMMIT
 ↓
PR
 ↓
TEST
 ↓
VERIFICATION
 ↓
DELIVERY
```

El usuario deberá poder abrir cualquier requisito y saber dónde está implementado, qué PR lo modificó, qué pruebas lo cubren, si está verificado, qué agente trabajó, qué modelo se utilizó y cuánto costó.

## 18. Aprobaciones

JEV deberá tener una bandeja de aprobaciones para merge crítico, despliegue, migración destructiva, cambio de permisos, aumento de presupuesto, promoción de memoria y excepciones de seguridad.

Acciones: aprobar, rechazar, pedir cambios o delegar.

## 19. Costes y presupuestos

El sistema deberá registrar costes por cliente, proyecto, orden, tarea, agente, modelo, proveedor y periodo.

El administrador podrá configurar presupuesto diario, mensual, por proyecto, por tarea, alertas y hard stop.

## 20. Reportes

Reportes mínimos:

- proyecto;
- cliente;
- operaciones;
- calidad;
- costes.

Exportaciones futuras: PDF, Excel y CSV.

## 21. Centro de mando

El usuario podrá enviar órdenes de alto nivel como:

- detener Nuvurent;
- priorizar Espacore;
- auditar todas las tareas fallidas;
- no gastar más de X;
- cambiar una tarea a un modelo premium;
- reintentar un trabajo;
- pausar un proyecto.

JEV deberá traducir estas órdenes en acciones controladas y auditables.

## 22. Auditoría

Toda acción sensible deberá registrar actor, tipo de actor, acción, proyecto, tarea, timestamp, resultado, riesgo, modelo, coste, aprobación y evidencia relevante.

## 23. Seguridad

Requisitos base:

- menor privilegio;
- credenciales temporales;
- secretos fuera del repositorio;
- separación de tenants;
- workspaces aislados;
- auditoría;
- aprobación humana para R4;
- restricciones de comandos;
- protección contra escritura directa a ramas principales;
- protección frente a escalada de permisos.

## 24. Fuera de alcance inicial

No forma parte del MVP:

- facturación completa;
- contabilidad;
- nóminas;
- marketplace de agentes;
- IDE completo en navegador;
- reemplazo de GitHub;
- infraestructura multi-región compleja;
- entrenamiento propio de modelos.

## 25. Métricas de éxito

- % de tareas verificadas sin intervención manual;
- % de tareas que pasan CI al primer intento;
- coste medio por tarea;
- tiempo medio desde orden hasta verificación;
- nº de regresiones;
- nº de bloqueos detectados antes de merge;
- % de requisitos con trazabilidad completa;
- gasto por modelo;
- ahorro frente a uso indiscriminado de modelos premium.

## 26. Criterio de éxito del producto

JEV se considerará funcional cuando un usuario pueda:

1. seleccionar un proyecto conectado a GitHub;
2. crear una orden;
3. dejar que JEV genere la tarea;
4. clasificar su riesgo;
5. seleccionar skills, agente y modelo;
6. crear una rama/workspace;
7. implementar el cambio;
8. ejecutar pruebas;
9. crear un PR;
10. verificarlo independientemente;
11. bloquearlo si falla;
12. solicitar aprobación cuando corresponda;
13. reflejar todo el proceso en dashboard, trazabilidad y costes.
