# Bridges

Vault de documentación compartido para el equipo — Obsidian self-hosteado + contexto para Claude Code.

La fuente de verdad son **archivos `.md` en disco**. El servidor mantiene la copia canónica y los clientes la replican entera. SQLite es solo un **índice + contador de secuencia**, nunca el contenido canónico.

```
┌──────────────────────────────┐
│         SERVIDOR (Bun)        │
│  SQLite (índice + seq)        │
│  Carpeta canónica .md         │
│  REST  +  SSE (/events)       │
└───────────────┬──────────────┘
                │  pull incremental por seq
      ┌─────────┴─────────┐
┌─────▼──────┐     ┌──────▼─────┐
│ Cliente A  │     │ Cliente B  │   (Tauri + SolidJS)
│ vault .md  │     │ vault .md  │   ← réplica local completa
│  └─ Claude Code lee de acá    │
└────────────┘     └────────────┘
```

## Estado (MVP — hitos 1-6)

| Hito | Qué | Estado |
|------|-----|--------|
| 1 | Server core: SQLite + `seq` atómico, `GET /sync`, `POST/DELETE /documents` | ✅ |
| 2 | SSE: canal `/events` que emite `seq` en cada cambio | ✅ |
| 3 | Cliente sync: pull + escritura `.md` a disco + SSE | ✅ |
| 4 | Validar con Claude Code + `CLAUDE.md` del vault | ✅ |
| 5 | UI: árbol + editor + preview + guardado con 409 | ✅ |
| 6 | Búsqueda full-text básica sobre el índice | ✅ |

### Más allá del MVP (hecho)

- **Vista de grafo** estilo Obsidian (`GraphView.tsx`): canvas + d3-force, nodos por `[[wikilinks]]`, tamaño por conexiones, fantasmas para links no resueltos, hover/selección con glow, auto-fit.
- **Panel de filtros/fuerzas** del grafo (`GraphControls.tsx`): búsqueda/resaltado, toggles (solo existentes, huérfanos), modo de labels, sliders de fuerzas en vivo.
- **Wikilinks navegables** en el preview + **panel de backlinks** (`lib/links.ts`, `Backlinks.tsx`).
- **Sync bidireccional** (`notify` en Rust + watcher en `store.ts`): ediciones externas (Zed, Claude Code) vuelven al server. Echo evitado por comparación de contenido.
- **Conexiones guardadas + autoconexión** (`config_load`/`config_save` → `bridges.json` en el config dir): abre el último vault solo; gestor para cambiar/agregar.
- **Operaciones de archivos** en el árbol (⋮ / click derecho): renombrar/mover, eliminar, nueva nota en carpeta, renombrar/eliminar carpeta.
- **Búsqueda full-text con ranking BM25** (SQLite FTS5): índice external-content sobre `documents` (title/path/content) mantenido por triggers, insensible a acentos. Reemplaza el `LIKE` plano, que ni rankeaba ni escalaba.
- **MCP server** (`mcp/`): expone `search_vault` para que Claude Code busque rankeado en vez de grepear el vault. Ver `mcp/README.md`.
- Color primary `#FF0033`.

### Decisiones de sync (importantes)

- **Borrados externos → se ignoran** (borrar solo desde la app). Evita falsos positivos de editores.
- **Conflicto en push de fondo → gana el server + aviso** (toast).
- **Rename externo → detección por contenido**: archivo nuevo con contenido idéntico a un doc cuyo archivo desapareció = move (no duplica). Limitación: rename+edit simultáneo no se detecta.
- **Sin índice local en el cliente**: el store se rehidrata con un pull completo (`since=0`) en cada arranque; el `last_seq` guardado no alcanza para reconstruir docs.
- **Gotcha SSE**: cada cliente abre 1 conexión EventSource (cuenta contra el límite ~6/host de HTTP/1.1). En dev, HMR acumulaba conexiones y saturaba el pool → `pull` colgado. Mitigado con `import.meta.hot.dispose` + timeout de 15s en `sync`.

### Próximos pasos (backlog)

- Editor con CodeMirror (syntax highlight, autocompletado de `[[wikilinks]]`).
- Búsqueda **semántica** (embeddings) como complemento del FTS5 léxico, para matchear sinónimos/paráfrasis que BM25 no alcanza.
- **Firma + notarización** del `.dmg` (Apple Developer ID) para distribuir sin warnings de Gatekeeper. Hoy sale con firma ad-hoc.
- **Firma/notarización** en el pipeline de release (hoy los instaladores salen sin firmar; ver [Descargas](#descargas-instaladores)).
- **Protección contra vaciado**: hoy un `editor` no puede borrar (`DELETE` es admin), pero sí puede sobreescribir el contenido de una nota con vacío vía update — no hay historial de versiones. Una papelera/versionado lo cubriría.

### Resuelto

- **Vaults locales (offline, sin servidor ni token)**: "Agregar vault" → toggle "Local" → elegís una carpeta y el disco es la verdad, el store su espejo. Sin sync/SSE/índice. La búsqueda corre en memoria sobre las notas cargadas; el borrado va a la **papelera del SO** (recuperable desde Finder/Explorer). Persiste con `serverUrl: null` y se reabre solo. El motor de sync de los vaults con server queda intacto (ver `plans/010-vaults-offline-locales.md`).
- **Sync en vivo (SSE) en la app de escritorio**: el WKWebView de macOS no entrega respuestas long-lived al JS (ni `EventSource` ni `fetch` streaming) sobre HTTP/2. Se movió el stream a Rust (`start_event_stream` en `src-tauri/src/lib.rs`): abre `/events` con reqwest, parsea el SSE y emite eventos Tauri (`server-change`/`server-status`) que el frontend escucha. En modo browser se usa fetch-streaming.
- **App empaquetada (.dmg)** para macOS Apple Silicon. Ver [Empaquetar](#empaquetar-dmg).
- **Auth multi-token con permisos (RBAC)** + deploy con Docker. Ver [Auth](#auth) y [Deploy](#deploy).
- Edición externa del doc abierto: si llega una edición externa/SSE del *mismo* doc mientras tenés cambios sin guardar, ya no se pisa el borrador. El `createEffect` de carga (`App.tsx`) distingue cambio de selección (carga fresca) de actualización externa: sin borrador refleja la edición; con borrador abre el `ConflictDialog` para resolver.

Stack: **Bun + bun:sqlite** (server), **Tauri 2 + SolidJS + shadcn-solid + Tailwind** (cliente).
> Nota: el spec original proponía Vue; se eligió **SolidJS** por performance.

## Descargas (instaladores)

Los instaladores para macOS, Windows y Linux se compilan en CI y se publican en la
**[página de Releases](https://github.com/Pepo2405/bridges/releases)** del repo. El repo es
privado: hay que estar logueado en GitHub con acceso al repo para descargarlos.

| OS | Archivo | Notas |
|----|---------|-------|
| macOS | `Bridges_<version>_universal.dmg` | Intel + Apple Silicon |
| Windows | `Bridges_<version>_x64-setup.exe` (NSIS) o `..._x64_en-US.msi` | |
| Linux | `Bridges_<version>_amd64.AppImage` o `..._amd64.deb` | |

**Sin firmar** — la primera vez el SO avisa:
- **macOS**: click derecho sobre la app → *Abrir* (o `xattr -cr /Applications/Bridges.app` si la marca como dañada).
- **Windows**: en el aviso de SmartScreen, *Más info → Ejecutar de todos modos*.
- **Linux**: al `.AppImage` dale permisos (`chmod +x`) y ejecutalo; o instalá el `.deb` (`sudo dpkg -i`).

### Publicar una versión nueva

El workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) corre al pushear un tag `v*`:

```bash
# 1) Alinear la versión en client/src-tauri/tauri.conf.json (y Cargo.toml) con el tag
# 2) Taggear y pushear
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions compila los 3 OS en paralelo y publica el Release con los assets. También se
puede disparar a mano desde la pestaña **Actions** (usa la versión de `tauri.conf.json`).

## Correr

### Servidor

```bash
cd server
bun run src/seed.ts     # datos de ejemplo (opcional)
bun run dev             # http://localhost:4321
```

Variables de entorno: `PORT`, `BRIDGES_DB`, `BRIDGES_VAULT`, `BRIDGES_TOKEN` (auth simple opcional).

### Cliente (escritorio)

```bash
cd client
bun install
bun run tauri dev       # app nativa (requiere Rust)
```

O en modo browser para iterar la UI sin compilar el shell nativo (no escribe a disco):

```bash
cd client
bun run dev             # http://localhost:1420
```

## Empaquetar (.dmg) — build local

> Para distribuir, no hace falta compilar a mano: el CI genera los instaladores de los 3 OS
> (ver [Descargas](#descargas-instaladores)). Esto es para un build local puntual.

Requiere el toolchain de **Rust** (`rustup`). Para macOS Apple Silicon:

```bash
cd client
bun run tauri build
# → src-tauri/target/release/bundle/dmg/Bridges_<version>_aarch64.dmg
```

La primera compilación baja y compila todos los crates del shell nativo (varios minutos); las siguientes son incrementales.

**Build universal** (corre en Intel + Apple Silicon), si lo necesitás:

```bash
rustup target add x86_64-apple-darwin
bun run tauri build --target universal-apple-darwin
```

> **Sin firmar (ad-hoc).** No hay certificado Apple Developer ID, así que Gatekeeper avisa que "no se puede verificar el desarrollador". Se abre con click derecho → Abrir, o quitando la cuarentena:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Bridges.app
> ```
> Distribución sin fricción = firma + notarización con cuenta Apple Developer (backlog).

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/health` | estado + `last_seq` |
| `GET`  | `/sync?since=<seq>` | pull incremental de docs cambiados |
| `GET`  | `/events` | stream SSE (`{type:"change",seq}`) |
| `GET`  | `/search?q=<texto>` | búsqueda full-text con ranking BM25 (FTS5) |
| `POST` | `/documents` | crear (`{path,title?,content}`) → 201 |
| `POST` | `/documents/:id` | actualizar (`{path,content,base_version}`) → 200 / 409 |
| `DELETE` | `/documents/:id` | borrado lógico (propaga `deleted=1`) |

Conflictos: versión optimista. Si `base_version` quedó vieja, el server responde **409** con el doc actual del server y el cliente resuelve manualmente (quedate con la tuya / con la del server).

## Auth

Multi-token con permisos por rol. Los tokens viven en SQLite (se guarda el **hash**, no el token en claro) y se consultan por request, así que crear/revocar funciona **en vivo sin reiniciar**.

| Rol | Permisos | Puede |
|-----|----------|-------|
| `viewer` | `read` | `GET /sync`, `/search`, `/events` |
| `editor` | `read` + `write` | lo anterior + crear/editar (`POST`) |
| `admin` | `read` + `write` + `delete` | todo, incluido **`DELETE`** |

- **401** = token ausente/inválido. **403** = token válido sin permiso (p.ej. un `editor` intentando borrar).
- `GET /health` es **público** (para el healthcheck).
- El token va en `Authorization: Bearer`. Excepción: el SSE (`/events`) lo acepta por query `?token=<token>` porque el `EventSource` del browser no puede mandar headers. → el token aparece en logs de proxy; aceptable para red interna.
- **La auth se activa sola** cuando existe al menos un token (o `BRIDGES_TOKEN`). Con tabla vacía y sin `BRIDGES_TOKEN`, el server queda **abierto** (modo dev). ⚠️ En un deploy público, seteá `BRIDGES_TOKEN` en el primer arranque para que nunca esté abierto, creá los tokens por persona, y después quitá `BRIDGES_TOKEN`.

### Administrar tokens (CLI)

```bash
cd server
bun run tokens add ivan admin       # imprime el token UNA vez — guardalo
bun run tokens add equipo editor
bun run tokens add lectura viewer
bun run tokens list
bun run tokens revoke equipo
```

En el cliente, el token se pone en el gestor de conexiones (campo "Token") y se guarda por conexión.

## Deploy

El server corre con Bun y `bun:sqlite` (sin dependencias npm). Se despliega con Docker.

```bash
cd server
docker build -t bridges-server .
docker run -d -p 4321:4321 -v bridges-data:/data bridges-server
```

La DB (`BRIDGES_DB`) y el vault canónico (`BRIDGES_VAULT`) van a **`/data`**, montado como volumen para sobrevivir redeploys.

### Coolify

1. Nueva app → **Docker Compose**, apuntando a `server/docker-compose.yml`.
2. (Recomendado) seteá `BRIDGES_TOKEN` en las env para el primer login; el healthcheck pega a `/health`.
3. Una vez levantado, creá los tokens por persona dentro del contenedor y quitá `BRIDGES_TOKEN`:
   ```bash
   docker compose exec bridges bun run src/tokens.ts add ivan admin
   ```

> SSE detrás del reverse proxy: el server manda keep-alive cada 25s para que el proxy no corte la conexión.

## Integración con Claude Code

Apuntá Claude Code a la carpeta del vault (la que elige el cliente). Lee los `.md` nativo, sin capa intermedia. En la raíz del vault hay un `CLAUDE.md` que describe la estructura.
