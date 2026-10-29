# Memoria en Bridges: Decisiones y Bitácora

Protocolo para que el agente guarde **solo** lo que aprende mientras trabaja en un repo,
dentro del vault de Bridges del proyecto. Es el equivalente de Engram (gentle-ai), pero
en markdown legible, con wikilinks e historial. Aplica a Claude Code, OpenCode, omp y Hermes.

## Dónde

Solo en repos con un archivo `.bridges` en la raíz: `{ "vault": "...", "folder": "..." }`.

- Decisiones: `<folder>/Decisiones/<Tema>.md`
- Bitácora: `<folder>/Bitácora/<AAAA-MM-DD> - <tema>.md`
- Si `folder` es `""`, van en la raíz del vault.
- Si el repo no tiene `.bridges`, no guardes nada. Si había algo para guardar, decilo en una línea.

**El vault es del equipo:** escribí en tono neutro y técnico. Nunca pongas secretos
(tokens, passwords, URLs con credenciales), datos de clientes ni comentarios personales.

## Tools (MCP de Bridges ≥ 0.2.0)

| Tool | Para qué |
|---|---|
| `project_context` | Al empezar: Decisiones vigentes (marca las vencidas) y próximos pasos de la última Bitácora. En Claude Code el plugin lo inyecta solo al iniciar la sesión. |
| `save_decision` | Guardar o actualizar una Decisión en **una** llamada. |
| `log_session` | Escribir el handoff de la sesión en la Bitácora. |

En OpenCode y omp lo mismo lo hace un plugin que instala
`bun run ~/code/forge/mcp/src/index.ts setup <opencode|omp>`. En Hermes no hay inyección
automática: llamá a `project_context` al retomar un repo.

Las tres aceptan `cwd` (ruta del repo). Pasalo si tu proceso no corre dentro del repo
(Hermes, por ejemplo). Sin `.bridges`, podés pasar `vault` y `folder` explícitos.

## Cuándo guardar una Decisión (sin preguntar)

Apenas pasa cualquiera de estas cosas, llamá a `save_decision`:

- Terminaste un bugfix (incluí la causa raíz).
- Se tomó una decisión de arquitectura o de diseño.
- Se eligió una herramienta o librería con tradeoffs.
- Descubriste algo del código que no es obvio: una trampa o un caso borde.
- Hubo un cambio de configuración o de entorno.
- Se estableció un patrón o convención (nombres, estructura).
- El usuario confirma una recomendación ("dale", "va con eso"), rechaza un enfoque
  ("no, mejor X") o elige entre opciones.

Al terminar cada tarea, preguntate si quedó algo de esto sin guardar.

**No guardes:** lo que ya dicen solos el diff o el `git log`, cambios triviales, salida
cruda de herramientas ni pasos intermedios.

## Cómo se usa `save_decision`

- `topic`: el tema, un sustantivo sin fecha ni verbo (`Auth - modelo de sesiones`). Es la
  clave: si ya existe una nota con ese nombre (sin importar mayúsculas ni acentos), se
  **actualiza**. Los campos que no mandes se conservan.
- `tipo`: `decision | bugfix | patron | config | preferencia | descubrimiento`. Define
  `revisar_despues`: 3 meses (preferencia, config), 6 (decision, patron, descubrimiento),
  12 (bugfix).
- `que` y `porque` son obligatorios al crear. `donde` y `aprendido` son opcionales.
- `cambio`: la línea que queda en `## Cambios` (default "creada" / "actualizada").
- `reemplaza`: el topic de otra Decisión que esta deja sin efecto. La vieja queda con
  `estado: reemplazada` y `reemplazada_por`, y la nueva la enlaza.
- La respuesta trae `similares`: si alguno es el mismo tema con otro nombre, unificalos
  (pasá la info a uno y borrá el otro con `delete_note`).

Cada escritura deja un snapshot en `.bridges/history` (se deshace con `restore_note`).

## Al leer Decisiones

- Antes de cambiar código, leé (`read_note`) las Decisiones relacionadas con la tarea.
- Si `revisar_despues` ya pasó (`project_context` la marca con REVISAR), verificala contra
  el código antes de confiar en ella. Si sigue valiendo, `save_decision` con solo `topic` y
  `cambio: "revisada, sigue vigente"` renueva las fechas. Si no, corregila.
- Si una nota está reemplazada, seguí el link `reemplazada_por`.

## Bitácora (handoff)

Llamá a `log_session` al cerrar una sesión de trabajo que dejó algo hecho o pendiente (no
en charlas sin cambios), y **apenas notes que el contexto se compactó** (en Claude Code el
hook lo avisa). Secciones: `objetivo`, `instrucciones`, `descubrimientos`, `hecho`,
`proximos`, `archivos`; las vacías se omiten. Si ya hay una del mismo día y tema, se suma
(`objetivo` y `proximos` se reemplazan, porque `project_context` muestra los próximos pasos).

En una tarea ODD **grande**, el documento de la feature sigue siendo la fuente de verdad:
la Bitácora lo enlaza (ruta en el repo) y solo resume `hecho` y `proximos`.

## Sin las tools

Si el MCP no está o es anterior a 0.2.0, escribí el `.md` a mano con este formato
(es el mismo que generan las tools):

```markdown
---
tipo: decision
estado: vigente
actualizado: 2026-10-29
revisar_despues: 2027-04-29
---
# Auth - modelo de sesiones

**Qué**: una oración con lo que se hizo o decidió.
**Por qué**: qué lo motivó.
**Dónde**: archivos o paths afectados.
**Aprendido**: trampas o casos borde (omitir si no hay).

## Cambios
- 2026-10-29: creada.
```

## Aviso

Cerrá la respuesta con una línea por cada nota escrita:

`Bridges: Decisiones/Auth - modelo de sesiones (nueva | actualizada) · Bitácora/2026-10-29 - spa`
