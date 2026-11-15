# Experiencia del agente en JEV

La experiencia del agente se mide por su capacidad de identificar el trabajo, conseguir contexto y herramientas fiables, ejecutar con permisos claros, aportar evidencia y continuar tras un bloqueo. Esta guía concreta la [capacidad del PRD](PRD.md#38-experiencia-del-agente-y-conocimiento-del-proyecto), los [requisitos AX del SPEC](SPEC.md#48-experiencia-del-agente-y-conocimiento-verificable) y sus [dependencias](ROADMAP.md#experiencia-del-agente-y-conocimiento-verificable).

## Cómo trabaja el agente

1. Al conectar un repositorio, JEV inspecciona la revisión objetivo y propone un plan de preparación. Muestra qué detectó, qué puede verificar, qué archivos cambiarían y qué queda pendiente. Tras aplicar el plan autorizado, comprueba el resultado y registra el perfil reproducible del proyecto.
2. JEV distingue una consulta de solo lectura, una corrección acotada y un trabajo que necesita especificación. Para una tarea escribible, prepara un ContextPack con fuentes vigentes, reglas, revisión, límites, herramientas y pruebas. Antes de crear código, el agente busca capacidades existentes y registra su decisión de reutilización.
3. El agente trabaja en un entorno aislado con permisos acotados. Registra puntos de reanudación y deja información suficiente para que otro agente continúe. Si necesita una decisión, JEV conserva la pregunta, opciones y evidencia y sigue con los pasos independientes autorizados.
4. El verificador comprueba el resultado real y adjunta evidencia vinculada a la revisión. Un cambio de alcance o de SHA activa la reevaluación correspondiente. JEV aplica la [política de reparación por riesgo](SPEC.md#47-reparación-de-incidentes-supervisada-por-riesgo).
5. Tras integrar o desplegar, JEV actualiza el inventario y conserva lo aprendido con sus fuentes. RSC Brain puede aportar memoria de proyecto. Las decisiones aprobadas y la evidencia del repositorio, las pruebas y los entornos determinan el estado que JEV afirma.

## Alcance y ejemplos

La experiencia del agente se aplica a todo trabajo autorizado de JEV y a todos los proyectos que gestiona. Incluye consultar qué existe, crear o ampliar una capacidad, reparar fallos y retomar trabajo. Los mismos controles de contexto, autorización y evidencia se aplican en cada caso. Las pruebas concretas dependen de la superficie y el riesgo.

| Superficie | Ejemplo de consulta | Evidencia o prueba pertinente |
|---|---|---|
| Interfaz y experiencia de usuario | «¿Ya se puede filtrar esta tabla por cliente?» | Componente, ruta, PR y prueba de navegador en staging. |
| API y lógica de negocio | «¿Qué reglas se aplican al calcular el IVA?» | Servicio, fuente de la regla, pruebas de integración y versión en cada entorno. |
| Datos y persistencia | «¿La nueva columna ya existe en producción?» | Migración, versión aplicada y evidencia autorizada del entorno. |
| Integraciones y automatizaciones | «¿Ya enviamos emails?» | Conector, llamada, última prueba de integración y versión desplegada. |
| Infraestructura y despliegue | «¿Este servicio tiene rollback verificado?» | Configuración, release y resultado de una prueba de recuperación. |

En una **consulta**, JEV cita las fuentes y la fecha. Cuando la evidencia es incompleta u obsoleta, comprueba el repositorio autorizado o indica qué falta para confirmar el resultado. En un **cambio**, un agente nuevo recibe lo necesario para localizar y reutilizar lo que corresponda, ejecutar las pruebas y dejar el punto de reanudación. Si hace falta decidir una regla o ampliar el alcance, JEV detiene solo el trabajo afectado. Cuando se pide aprobación para una corrección implementada, el operador puede revisar la PR, las pruebas y staging cuando aplique, con aviso por Telegram si está habilitado.

## Piloto y métricas

| Caso | Resultado esperado |
|---|---|
| Consulta con índice actualizado y consulta con datos antiguos | La primera cita fuentes vigentes. La segunda verifica la evidencia disponible y explica qué estado queda sin confirmar. Medir ambas latencias. |
| Dos proyectos contienen capacidades de nombre similar | Cada consulta y ContextPack devuelve solo el proyecto autorizado y conserva los repos y commits correctos. |
| Casos de distintas superficies | La suite cubre interfaz, API o lógica de negocio, datos, integraciones y despliegue. Verifica consultas, cambios nuevos, mejoras, reparaciones y las pruebas adecuadas para cada caso. |
| Nace un proyecto o se conecta un repo existente | JEV propone el perfil, preserva configuración propia y detecta si la evidencia cambió antes de aplicar el plan aceptado. |
| Falta una regla obligatoria, una herramienta o una prueba de conexión | Antes de escribir, JEV devuelve el elemento que falta y qué acción permite continuar. |
| Worker interrumpido después de un efecto confirmado | El segundo agente valida el contexto y la revisión, conserva la evidencia existente y reanuda sin duplicar la operación. |
| Una decisión humana afecta a una rama de trabajo | Se pausan el paso y sus dependientes. Otro paso independiente continúa y el operador recibe contexto suficiente para decidir. |
| Cambia el SHA después de verificar | La evidencia anterior no satisface el gate de la nueva revisión. |
| Dos alertas informan el mismo fallo | Una orden y una PR, con prueba que falla antes del parche y pasa después. La confirmación postdespliegue verifica si reaparece. |
| Alerta de un emisor sin permiso sobre el proyecto | JEV registra el rechazo y no crea ni ejecuta una reparación. |
| Corrección sensible y corrección elegible de bajo riesgo | La primera se presenta ya probada con staging cuando corresponda. La segunda solo prueba la vía automática en un piloto habilitado conforme al SPEC. |
| API y worker de JEV detenidos | El monitor externo ejecuta y registra una acción preautorizada y comprueba la recuperación. |

Medir tiempo humano por incidente, número de avisos y aprobaciones, latencia de consulta, reanudaciones sin relectura de chat, duplicaciones evitadas y coste por fase. El **30 % menos de tiempo humano en incidentes repetibles** es una hipótesis del piloto. **Cero aprobaciones individuales** solo aplica a PR elegibles con la ruta automática habilitada. Si 7 de cada 10 fueran elegibles, la reducción de aprobaciones frente a revisar todas sería del 70 %.

## Matriz de las 39 mejoras

Cada fila vincula una observación de RSC o del vídeo con el comportamiento que JEV deberá demostrar. Los requisitos AX y REP son especificación de producto. La evidencia operativa y los estados de implementación se rigen por el [backlog de Foundation](https://github.com/novo34/base-skills_klever/blob/main/backlog/jev-master-tasks.yaml).

| # | Mejora | Qué hace RSC o qué expone el vídeo | Comportamiento esperado en JEV | Requisito |
|---:|---|---|---|---|
| 1 | Preparar proyecto | Detecta stack en archivos reales. | Reconocer stack, pruebas, reglas y estructura al crear o conectar un repo. | REQ-AX-001 |
| 2 | Plan revisable | Enumera componentes y archivos afectados. | Mostrar qué se propone aplicar y cómo se comprobará. | REQ-AX-001 |
| 3 | Aceptación exacta | Recalcula la identidad del plan si cambian sus entradas. | Invalidar una aceptación cuya evidencia relevante cambió. | REQ-AX-002 |
| 4 | Verificación posterior | Comprueba los archivos instalados y sus huellas. | Probar capacidades y registrar qué se aplicó. | REQ-AX-002 |
| 5 | Arnés reproducible | Reconstruye la configuración declarada para el equipo. | Fijar perfil de arnés, adaptador, skills y reglas por tarea. | REQ-AX-003 |
| 6 | Adaptación al ejecutor | Prepara configuraciones específicas por asistente. | Comprobar las capacidades reales de cada ejecutor. | REQ-AX-006, REQ-HRN-001 |
| 7 | Configuración existente | Detecta archivos y skills propios. | Respetar instrucciones, scripts y personalizaciones del repo. | REQ-AX-001, REQ-AX-002 |
| 8 | Constitución | Prepara un borrador de reglas del proyecto. | Entregar reglas vigentes y registrar decisiones materiales. | REQ-AX-001, REQ-DEC-001 |
| 9 | Actualización y reversión | Ofrece sincronización, copias y restauración. | Validar actualizaciones y recuperar el perfil anterior. | REQ-AX-002, REQ-AX-003 |
| 10 | Diagnóstico | Doctor detecta artefactos y hooks ausentes o duplicados. | Informar si el proyecto está listo, degradado o bloqueado y por qué. | REQ-AX-003 |
| 11 | Consultar qué existe | La wiki orienta al asistente. Consult sugiere skills. | Responder qué está implementado y dónde, con evidencia por entorno. | REQ-AX-005 |
| 12 | Inventario | Enlaza specs, herramientas y decisiones en la wiki. | Relacionar funcionalidades, repos, código, pruebas y releases. | REQ-AX-004 |
| 13 | Vigencia | Sincroniza conocimiento y detecta registros de trabajo integrados. | Actualizar el índice tras cambios, verificación y despliegues. | REQ-AX-004 |
| 14 | Contradicciones | Diagnostica referencias caducadas y divergencias de documentación. | Mostrar diferencias entre requisitos, código y versión desplegada. | REQ-AX-004 |
| 15 | Contexto por tarea | Usa referencias y memoria para orientar la sesión. | Entregar ContextPack y bloquear escritura si falta información obligatoria. | REQ-CTX-001 a 008, REQ-AX-007 |
| 16 | Memoria por proyecto | Brain permite consultar wiki y diario por ámbito. | Recuperar lecciones e incidentes del proyecto correcto. | REQ-REP-003, REQ-AX-005 |
| 17 | Revisión de aprendizaje | Brain permite proponer cambios de wiki para revisión. | Revisar una observación antes de convertirla en regla aprobada. | REQ-REP-003, REQ-LRN-001 a 004 |
| 18 | Reutilizar primero | La wiki y el catálogo ayudan a localizar capacidades. | Buscar implementación existente y justificar reutilizar, ampliar o crear. | REQ-AX-005, REQ-HYG-005 |
| 19 | Conectores probados | Proporciona plantillas y una prueba de conexión. | Registrar permisos, entorno y última evidencia válida de conexión. | REQ-AX-006 |
| 20 | Selección de skills | Recomienda por señales y texto. | Validar disponibilidad y medir activaciones correctas y equivocadas. | REQ-AX-006, REQ-SHL-001 |
| 21 | Repetición | Agrupa procedimientos que podrían convertirse en skills. | Proponer automatizar repeticiones verificadas con ejemplos. | REQ-AX-011 |
| 22 | Evaluación | Compara ejecuciones con y sin la skill. | Medir calidad, tiempo, coste y correcciones antes de activar mejoras. | REQ-AX-011, sección 40 |
| 23 | Proceso proporcional | Distingue consulta, vía rápida y especificación. | Aplicar el workflow y la evidencia que correspondan al alcance. | REQ-AX-008 |
| 24 | Reclasificación | Usa riesgo y gates locales de especificación. | Reevaluar riesgo y autorización al ampliar el diff. | REQ-AX-008, REQ-REP-006 |
| 25 | Decisión pendiente | Pone decisiones en cola y sigue con trabajo independiente. | Pausar solo el paso y sus dependientes y avisar al operador. | REQ-AX-008 |
| 26 | Reanudación | Registra rama, cambios y próximos pasos. | Retomar desde una evidencia validada con otro agente. | REQ-AX-007 |
| 27 | Concurrencia | Detecta sesiones simultáneas y protege el trabajo local. | Aislar workspaces y respetar locks de recursos. | REQ-AX-010 |
| 28 | Limpieza | Clasifica worktrees y distingue trabajo integrado y pendiente. | Liberar recursos con retención de parches, pruebas y evidencia. | REQ-AX-010 |
| 29 | Revisión pertinente | Selecciona perspectivas de revisión según el riesgo. | Escoger verificaciones por diff y política aplicable. | REQ-AX-009 |
| 30 | Consolidación | Agrupa hallazgos repetidos y conserva su resolución. | Mantener una lista coherente de hallazgos y decisiones por PR. | REQ-AX-009 |
| 31 | Límite de revisión | Limita rondas y registra hallazgos pendientes. | Escalar un desacuerdo persistente con evidencia y opciones. | REQ-AX-009 |
| 32 | Evidencia obsoleta | El sello local detecta contenido revisado que cambió. | Reaplicar el control de SHA exacto y reevaluar evidencia y aprobación. | REQ-AX-009, REQ-APR-006 |
| 33 | Regresión escapada | Distingue hallazgos reabiertos de duplicados. | Vincular la regresión a la prueba que faltó o que la dejó pasar. | REQ-AX-009, REQ-AX-011 |
| 34 | Evidencia de navegador | Distingue verificación de UI ejecutada de comprobación omitida. | Guardar evidencia de UI o el motivo explícito de que falta. | REQ-AX-009, REQ-VER-007 |
| 35 | Coste y esfuerzo | Conserva métricas y valores desconocidos. | Medir coste y trabajo humano por fase de la tarea. | REQ-AX-011 |
| 36 | Del incidente a la PR | El vídeo de la fábrica inicia trabajo desde una alerta. | Duplicados en una orden, parche y prueba antes/después. | REQ-REP-001 a 004 |
| 37 | Aprobación por riesgo | El vídeo describe rutas automáticas y escaladas. | Automatizar casos elegibles y avisar por Telegram para la revisión humana. | REQ-REP-005 a 008 |
| 38 | Confirmar recuperación | El vídeo describe desplegar la corrección. | Observar la señal posterior y cerrar, reabrir o revertir según evidencia. | REQ-REP-009 |
| 39 | Recuperación de JEV | Extensión del diseño para el caso en que JEV esté caído. | Supervisión y recuperación externa con política propia para editar JEV. | REQ-REP-010 |

[Vídeo del arnés](https://youtu.be/pv3A38NnJSk) · [Vídeo de la fábrica](https://youtu.be/p6nnqerea7w) · [RSC Harness auditado](https://github.com/ericrisco/rsc-harness/tree/d11cd71fdd117669c8e8806295392470c0907d09) · [RSC Brain auditado](https://github.com/ericrisco/rsc-brain/tree/7163117831f01fea08dce0386044ea60fb5c4452)
