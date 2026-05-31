---
name: forge-docs
description: >-
  Documentá repositorios en el vault de Forge de forma estructurada. Usar cuando el
  usuario pida documentar un repo/proyecto, actualizar su documentación, o escribir
  docs de un repositorio en Forge ("documentá este repo", "actualizá los docs de X en
  Forge", "documentá esto en el vault"). Cubre: ubicar el vault en disco, la estructura
  "01 - Proyectos/{repo}/", la convención de wikilinks y mantener el índice del vault.
---

# Documentar repos en el vault de Forge

Forge es un vault de documentación compartido del equipo: una carpeta de `.md` en disco
que una app sincroniza con un server (y que el equipo lee en vivo). Tu trabajo con esta
skill es **documentar el repo actual dentro del vault**, siguiendo las convenciones de
abajo. Escribís archivos `.md` normales; la app de Forge los sincroniza sola.

## 1. Ubicá el vault (está en OTRA carpeta, no en este repo)

Esta skill corre dentro de un repo de código, pero los docs van al vault de Forge, que
vive en otro lado. Resolvé su ruta así (en orden):

1. Ejecutá el helper:
   ```bash
   bash scripts/vault-path.sh
   ```
   (relativo al directorio de esta skill; imprime la ruta del vault).
2. Si no tenés a mano el script, leelo directo de la config de la app:
   ```bash
   python3 -c "import json,os;p=os.path.expanduser('~/Library/Application Support/com.pxsol.forge/forge.json');print(json.load(open(p)).get('lastVault'))"
   ```
3. Fallbacks: variable de entorno `FORGE_VAULT`, o **preguntale al usuario** la ruta si
   hay ambigüedad (varios vaults) o no se resuelve.

Llamá `VAULT` a esa ruta. Todos los paths de abajo son relativos a `VAULT`.

## 2. Estructura y nombres

- Un **proyecto/repo = una carpeta** bajo `01 - Proyectos/`.
- Carpeta del repo en **lowercase con guiones**: `01 - Proyectos/pxsol-next/`.
- **Doc raíz** del repo: `01 - Proyectos/{repo}/{repo}.md` (ej. `pxsol-next/pxsol-next.md`).
- **Sub-docs por tema** cuando el raíz crece: `01 - Proyectos/{repo}/{tema}.md`
  (ej. `auth.md`, `api.md`, `deploy.md`). No metas todo en un solo archivo gigante.
- No inventes categorías nuevas de nivel raíz (`02 - …`, etc.); usá las que ya existen.

## 3. Wikilinks

El vault enlaza notas con `[[wikilink]]`. El resolver es **case-insensitive** y matchea
por **path sin `.md`** o, si no, por **basename**.

- Preferí el **basename**: `[[pxsol-next]]`, `[[api2]]` (más corto y legible).
- Usá el **path completo** solo si hay basenames duplicados: `[[01 - Proyectos/api/api]]`.
- Alias y anclas: `[[api2|la API nueva]]`, `[[deploy#Coolify]]`.

## 4. Template del doc raíz `{repo}.md`

Adaptá según lo que el repo tenga; no inventes secciones vacías.

```markdown
# {repo}

> Una línea: qué es y para qué sirve.

## Overview
Propósito del repo, a quién/qué sirve, contexto de negocio.

## Stack
Lenguaje, frameworks, libs clave, base de datos.

## Arquitectura
Componentes principales y cómo se comunican. Diagrama en texto si ayuda.

## Estructura
Carpetas/módulos importantes y qué hace cada uno.

## Cómo correr (dev)
Pasos reales para levantarlo localmente (install, env, comando de dev).

## Relación con otros repos
| Repo | Rol | Conexión |
|---|---|---|
| [[otro-repo]] | … | … |
```

## 5. Workflow

1. **Explorá el repo de verdad** (README, package.json/Cargo.toml, estructura, scripts,
   configs) antes de escribir. Documentá **solo lo que existe**; no inventes.
2. **¿Carpeta del repo existe en el vault?**
   - No → creá `01 - Proyectos/{repo}/{repo}.md` desde el template.
   - Sí → **actualizá sin duplicar**: editá los docs existentes, agregá sub-docs para
     temas nuevos. Respetá el estilo y formato que ya tienen.
3. **Mantené el índice**: si existe `VAULT/CLAUDE.md` (índice raíz), agregá/actualizá la
   línea del repo (nombre + una frase). Si no existe, no lo crees salvo que te lo pidan.
4. Escribí **incremental**: docs cortos y por tema mejor que un solo archivo enorme.

## 6. Reglas

- **No toques `.forge/`** (estado interno de la app) ni `.obsidian/`, `.git/`.
- **No borres ni reescribas docs ajenos** sin pedirlo; ante la duda, agregá/actualizá.
- Markdown estándar; sin frontmatter salvo que el vault ya lo use.
- Si algo del repo no lo entendés, dejalo marcado como `> TODO: …` en vez de inventar.
