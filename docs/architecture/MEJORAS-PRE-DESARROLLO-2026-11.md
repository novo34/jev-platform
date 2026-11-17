# Mejoras detectadas antes del desarrollo — noviembre de 2026

**Fecha:** 2026-11-17  
**Estado:** propuesta registrada por decisión del operador; sin implementar.  
**Alcance:** auditoría de `rsc-harness`, `rsc-brain` y `gregoryjp/rsc-factory`, repositorios externos evaluados como referencia de diseño. **No se adoptan como dependencias.**

Cada mejora indica problema, propuesta, fase o REQ afectado y prioridad. Los IDs REQ citados están en la [SPEC](../product-specs/SPEC.md) y el orden de ejecución en el [ROADMAP](../product-specs/ROADMAP.md#prioridad-de-ejecución-ajustada-2026-11-17).

**Pendiente de Foundation.** Ninguna prioridad de este documento es ejecutable hasta que se refleje en `backlog/jev-master-tasks.yaml` y en NEXT_TASK (ver la mejora 12). PLT-011, en curso y autorizada, no se interrumpe.

## 1. Caché de prompts y Fase 10 (Context Runtime)

- **Problema:** el coste de tokens amenaza la viabilidad económica. Hoy el gateway (solo OpenAI y DeepSeek) no usa caché ni mide su efecto, y no hay ContextPack acotado.
- **Propuesta:** caché de prompts con prefijo estable (sistema, reglas, skills y especificación al inicio; contenido variable al final), adaptador Anthropic con `cache_control` desde su primera versión, y Fase 10 con Context Packs acotados con presupuesto de tokens por tipo de tarea.
- **Afecta a:** Fase 17, Fase 10; REQ-CACHE-001..007, REQ-CTX-009 y REQ-CTX-010. Detalle en [MODEL_GATEWAY.md](../MODEL_GATEWAY.md#prompt-caching-not_implemented-planificado-prioridad-adelantada).
- **Prioridad:** alta, adelantada tras PLT-011.

## 2. Decisión: no integrar rsc-harness ni rsc-brain

- **Problema:** parecían atajos para el runtime de agentes y la memoria, pero:
  - Harness añade unos 250 tokens por turno, más su texto de arranque, y unos 3.200 tokens de media por skill cargada.
  - Harness duplica el gobierno de JEV (autorización, riesgo, aprobaciones).
  - Harness se actualiza solo con `npx -y` en cada sesión, sin versión fijada.
  - Las guardas de Harness dejan pasar la acción si fallan.
  - Brain no aísla clientes y obligaría a mantener otro servidor, con Node 25 y PostgreSQL 17, que se solapa con las Fases 13 y 38.
- **Propuesta:** usarlos solo como referencia de diseño. Las skills MIT de Harness `design`, `seo-geo`, `accessibility` y `e2e-testing` pueden copiarse con atribución (licencia y origen), fijadas a una versión y cargadas solo cuando se necesiten.
- **Afecta a:** Fases 12, 13, 38.
- **Prioridad:** decisión cerrada; copia de skills, baja.

## 3. Gate de evidencia como código, no como texto

- **Problema:** en Harness la verificación es solo prosa; un agente puede declarar "terminado" sin evidencia.
- **Propuesta:** ningún estado "terminado" sin evidencias registradas, comprobado por código en el servidor, no por instrucciones al agente.
- **Afecta a:** Fases 20 y 21; REQ-VER y REQ-WFL-006..008.
- **Prioridad:** alta antes de ejecución automatizada.

## 4. Guardas que bloquean ante fallo; versiones fijadas; sin permisos globales

- **Problema:** una guarda que falla y deja pasar la acción equivale a no tener guarda; las herramientas que se autoactualizan cambian el comportamiento sin revisión; un permiso global para `git push` o abrir PR salta las aprobaciones.
- **Propuesta:** las guardas de ejecución de agentes bloquean la acción si fallan (fail closed). Sin actualización automática de herramientas: versiones fijadas (como las imágenes por digest de PLT-011). Ningún permiso global para que los agentes hagan `git push` o abran PR sin pasar por las aprobaciones de JEV.
- **Afecta a:** Fases 12, 20 y 23; REQ-CAP, REQ-ORG-005, REQ-SEC.
- **Prioridad:** alta.

## 5. Ideas de rsc-factory para el runtime de ejecución

- **Problema:** el runtime de agentes necesita robustez ante cortes, gasto y cuotas.
- **Propuesta (solo ideas, sin copiar código: el repositorio no tiene licencia):**
  - tareas reservadas para un solo trabajador y reanudables tras un corte;
  - presupuesto reservado antes de cada llamada;
  - comprobaciones sobre una copia del commit sin `.git`;
  - proveedor alternativo por rol;
  - espera por cuota en estado BLOCKED con hora de reintento.
- **Afecta a:** Fases 12 y 20, PLT-017, Fase 6 (cola) y Fase 21; REQ-QUE, REQ-CST.
- **Prioridad:** media; el presupuesto reservado entra con el guard mínimo de PLT-017.

## 6. Aislamiento por cliente o proyecto

- **Problema:** Brain no aísla clientes; mezclar conocimiento, credenciales o entornos entre clientes es un riesgo contractual y de seguridad.
- **Propuesta:** conocimiento, credenciales y contenedor separados por cliente o proyecto. El aprendizaje de un proyecto nunca pasa a regla global de forma automática (refuerza REQ-LRN-003 y REQ-LRN-004). Si se activa la búsqueda semántica, no enviar datos de clientes a proveedores externos de embeddings sin política explícita; preferir un modelo local.
- **Afecta a:** Fases 13, 16, 19 y 38; REQ-LRN, REQ-ORG-004, REQ-SEC.
- **Prioridad:** alta como principio; la búsqueda semántica queda bajo política explícita.

## 7. Condiciones de uso de los proveedores

- **Problema:** las suscripciones de consumo no están pensadas para automatización de terceros.
- **Propuesta:** la ejecución automatizada para clientes usa claves de API comerciales, no suscripciones de consumo. Revisar las condiciones de cada proveedor antes de activar un adaptador.
- **Afecta a:** Fases 12, 17 y 20; REQ-MDL.
- **Prioridad:** alta (condición de activación).

## 8. Telemetría de tokens por llamada, tarea y proyecto

- **Problema:** sin medición no se puede demostrar el ahorro de la caché ni de los Context Packs.
- **Propuesta:** registrar tokens de entrada, salida, escritura y lectura de caché por llamada, tarea y proyecto, y medir el tamaño real del ContextPack enviado; comparar antes y después.
- **Afecta a:** Fases 10, 17 y 25; REQ-CACHE-004, REQ-CACHE-005, REQ-CTX-010.
- **Prioridad:** alta, junto con la caché.

## 9. Presupuesto de skills

- **Problema:** cargar skills siempre cuesta tokens (en Harness, unos 3.200 de media por skill).
- **Propuesta:** cargar skills solo cuando hagan falta y medir su tamaño. Enlazar con skill health: el tamaño y el coste medio entran en REQ-SHL-001.
- **Afecta a:** Fase 38 (skill health), Fase 10; REQ-SHL, REQ-SKL, REQ-CTX.
- **Prioridad:** media.

## 10. Política de modelos por tipo de tarea

- **Problema:** los modelos baratos son útiles para explorar, pero no para sostener decisiones. Lección de esta sesión: un barrido rápido de lectura dio una conclusión mal enfocada sobre el propósito de JEV.
- **Propuesta:** política por tipo de tarea. Los modelos baratos sirven para explorar; un análisis que sostenga una decisión necesita revisión o un modelo superior.
- **Afecta a:** Fases 11, 12 y 20; REQ-MDL, REQ-WFL.
- **Prioridad:** media.

## 11. Pendiente de decisión del operador: capa comercial

Sin añadir al roadmap. Se plantea una capa comercial (clientes potenciales, propuestas, pagos, portal) como producto aparte gobernado por JEV, como Espacore y Nuvurent.

- **Riesgo legal en Suiza:** el envío masivo de publicidad por email exige consentimiento (UWG art. 3 apdo. 1 letra o). Debe validarse con un asesor jurídico antes de cualquier diseño.
- **Estado:** sin decisión; no existe fase ni REQ asociado.

## 12. Pendiente en Foundation

Reflejar la nueva prioridad en `backlog/jev-master-tasks.yaml` y en NEXT_TASK de `novo34/base-skills_klever`. Esta sesión de Platform no tuvo acceso a Foundation, por lo que no se han creado ni modificado IDs allí. Mientras tanto, NEXT_TASK manda sobre el orden propuesto.

## Discrepancia abierta

`PROGRESO.md` figura PLT-009 como `DONE`, pero [MODEL_GATEWAY.md](../MODEL_GATEWAY.md) y [PLT-009-LIVE-ACCEPTANCE.md](../PLT-009-LIVE-ACCEPTANCE.md) mantienen la aceptación en vivo pendiente. El operador debe confirmar qué cubre ese `DONE`.
