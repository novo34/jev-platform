# Instrucciones para Claude Code

Sigue [AGENTS.md](AGENTS.md). Este archivo añade reglas que solo aplican a Claude Code.

## Delegación obligatoria en subagentes

El operador exige usar siempre los subagentes de `.claude/agents/` para ahorrar cupo.
Esta regla no es opcional y se aplica en cada sesión.

- `lector-proyecto` (Haiku, solo lectura): toda lectura y exploración. Incluye
  código, documentación, logs, diffs, inventarios y respuestas sobre cómo funciona algo.
- `escritor-codigo` (Sonnet): todo cambio de archivos y toda verificación. Incluye
  código, pruebas, `PROGRESO.md` cuando el cambio sea extenso, `npm run check`,
  smokes y validadores de `scripts/`.
- El agente principal solo coordina, decide con el operador, gestiona GitHub (PR,
  fusiones, hilos de revisión y checks) y revisa el resultado de los subagentes
  con comprobaciones puntuales. No repite el trabajo de un subagente salvo que
  encuentre un motivo concreto, y lo explica.
- Pide a los subagentes resultados resumidos, con rutas y comandos ejecutados.
- Excepción: consultas triviales de una línea (`git status`, `git log -1`, estado
  de un check) que cuestan menos que lanzar un subagente.
- Si un subagente no está disponible, avisa al operador antes de hacer su trabajo
  en el hilo principal.
