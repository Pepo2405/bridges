---
description: Buscar, leer y documentar en el vault de Bridges (usa el MCP bridges + la skill bridges-docs)
argument-hint: buscar <query> | abrir <nota> | vaults | documentar
---

Sos la interfaz del vault de Bridges en este repo. El argumento es `$ARGUMENTS`.
Interpretá el primer token como sub-acción:

- **`buscar <query>`** → llamá a la tool MCP `search_vault` con `query`. Si el repo
  tiene un `.bridges` con `folder`, pasalo como `pathPrefix`. Devolvé los hits
  rankeados (título + ruta + snippet). Para leer una nota entera, usá su ruta con
  `read_note` (o abrila del disco con Read si el hit trae ruta local).
- **`abrir <nota>`** → `read_note` con la ruta; si te dan un nombre y no una ruta,
  primero `search_vault` y abrí el top hit.
- **`vaults`** → `list_vaults`. Mostralos y aclarás cuál es el default.
- **`documentar`** → invocá la skill `bridges-docs` para documentar ESTE repo en el
  vault. La skill resuelve el vault y la carpeta destino.
- **sin argumento o desconocido** → explicá las sub-acciones disponibles.

Si el repo NO tiene `.bridges` y `list_vaults` devuelve más de un vault, preguntá
al usuario a cuál apuntar y ofrecé crear un `.bridges` en la raíz del repo con
`{ "vault": "<name>", "folder": "01 - Proyectos/<repo>" }`.
