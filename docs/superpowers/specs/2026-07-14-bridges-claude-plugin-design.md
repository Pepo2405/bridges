# Bridges como plugin de Claude Code — Design

**Fecha:** 2026-07-14
**Proyecto:** Bridges (server Bun + bun:sqlite, cliente SolidJS + Tauri, MCP read-only)

## Contexto

Hoy la capacidad "Claude conoce el vault de Bridges" está **dispersa** y hay que
cablearla a mano en cada repo:

- **MCP `bridges-mcp`** (`mcp/`): server stdio (Bun) con 4 tools read-only
  (`search_vault`, `read_note`, `get_backlinks`, `list_links`). Para usarlo en un
  repo hay que registrarlo a mano y setear env (`BRIDGES_VAULT_DIR` o
  `BRIDGES_URL`/`BRIDGES_TOKEN`).
- **Skill `bridges-docs`** (`skills/bridges-docs/`): documenta un repo dentro del
  vault (estructura `01 - Proyectos/{repo}/`, wikilinks, índice). Vive dentro de
  este repo; para usarla en otro repo hay que copiarla.
- **Drift de nombres:** existe además una skill global vieja `forge-docs` (nombre
  previo del proyecto) que hace lo mismo que `bridges-docs`. Dos fuentes para una
  misma capacidad.
- **No hay `.claude-plugin/`**: `forge` todavía no es instalable como plugin.

El resultado: para que un compañero tenga "Claude que sabe leer/buscar/escribir el
vault" en cualquier repo, hoy tiene que configurar el MCP y copiar la skill. Es la
misma fricción que `pxsol-uxui` (repo hermano) resolvió empaquetándose como
**plugin + marketplace** de Claude Code.

## Objetivo

Empaquetar Bridges como **un plugin de Claude Code** (plugin + marketplace en el
mismo repo `forge`, como `pxsol-uxui`) para que un solo
`/plugin install bridges@bridges` entregue, en cualquier repo:

1. El MCP read-only ya cableado (con resolución de vault **zero-config**).
2. La skill `bridges-docs` (fuente única; se depreca `forge-docs`).
3. Un command de conveniencia `/bridges`.
4. Un agente `doc-writer` para documentar/mantener el vault.

Y que, trabajando dentro de un repo, el plugin **sepa a qué vault apuntar y dónde
guardar** vía un marcador committeado (`.bridges`).

## No-objetivos (v1)

- No se agregan tools de **escritura** al MCP (sigue read-only; la escritura de
  docs la hace la skill escribiendo `.md` a disco, como hoy).
- No se toca el server, el cliente Tauri ni el schema de sync.
- No se reescribe el índice FTS local para Node: el MCP usa `bun:sqlite`
  (`localIndex.ts`), así que se distribuye como **binario Bun compilado** (ver
  §8), no como script corrido con `bun`/`node` en la máquina del consumidor.

## Arquitectura

```
forge/  (repo = plugin + marketplace)
  .claude-plugin/
    plugin.json          ← nombre "bridges", version, mcpServers → launch.sh
    marketplace.json     ← catálogo con 1 plugin, source "./"
    launch.sh            ← NUEVO: launcher (detecta plataforma, cachea, ejecuta el binario del Release)
  mcp/                   ← EXISTE. +1 tool (list_vaults) + cascada de resolución
    src/index.ts         ← registra list_vaults
    src/bridges.ts       ← resolveVaultDir() (cascada) + readVaultsConfig()
    src/config.ts        ← NUEVO: localiza y parsea bridges.json
  skills/
    bridges-docs/        ← EXISTE. Se referencia desde el plugin (fuente única)
  commands/
    bridges.md           ← NUEVO: /bridges (buscar|abrir|documentar|vaults)
  agents/
    doc-writer.md        ← NUEVO: subagente documentador del vault
  .github/workflows/
    mcp-release.yml       ← NUEVO: buildea binarios por plataforma al taggear y los sube al Release
```

Repo consumidor (cualquiera, p. ej. `pxsol-blanco`):

```
<repo>/
  .bridges               ← NUEVO (committeado): { vault, folder }
```

### Flujo de resolución del vault (data flow)

El MCP corre con cwd = el repo consumidor (Claude Code lo lanza ahí). Resuelve la
raíz del vault con esta **cascada** (primera que exista gana):

1. **`.bridges` del repo** (cwd): `{ "vault": "<name>" }` → se busca en
   `connections[]` de `bridges.json` la entrada cuyo `name` (o basename del path)
   coincide → su `vault` (ruta local) es la raíz.
2. **`BRIDGES_VAULT_DIR`** (override explícito por env) — comportamiento actual.
3. **`lastVault`** de `bridges.json` (default zero-config).
4. **HTTP** al `bridges-server` (`BRIDGES_URL`/`BRIDGES_TOKEN`) — fallback si no
   hay vault local resoluble.

El `folder` de `.bridges` NO afecta al MCP (read-only); lo usan la skill y el
command para saber **dónde escribir** (default: `01 - Proyectos/{basename-repo}/`).

## Componentes

### 1. `mcp/src/config.ts` (nuevo) — localizar y parsear `bridges.json`

Módulo puro, testeable, sin dependencia del resto del MCP.

```ts
export type VaultConn = { name: string; path: string; serverUrl: string | null; isDefault: boolean };

/** Ruta del bridges.json (config dir de la app Tauri, identifier `com.pepo.bridges`,
 *  confirmado en skills/bridges-docs/scripts/vault-path.sh). Orden:
 *  1. env BRIDGES_CONFIG (test/override)
 *  2. macOS:  ~/Library/Application Support/com.pepo.bridges/bridges.json
 *  3. Linux:  ${XDG_CONFIG_HOME:-~/.config}/com.pepo.bridges/bridges.json
 */
export function configPath(): string | null
/** Lee y parsea. Devuelve [] si no existe o no parsea (nunca lanza). */
export function readVaults(): VaultConn[]
/** Ruta local del default: lastVault, o la primera connection con vault (igual que
 *  vault-path.sh). null si no hay ninguna. */
export function defaultVaultDir(): string | null
```

`bridges.json` (forma confirmada leyendo `client/src/lib/updateConnection.test.ts`
y `App.tsx`):

```jsonc
{
  "connections": [
    { "vault": "/ruta/local", "name": "PxSol", "serverUrl": "http://...", "token": "...", "openedAt": "..." }
  ],
  "lastVault": "/ruta/local"
}
```

`readVaults()` **nunca expone `token`**. Mapea `isDefault = (vault === lastVault)`
y `name = connection.name ?? basename(vault)`.

### 2. `mcp/src/bridges.ts` — resolución con cascada

Hoy `VAULT_DIR = process.env.BRIDGES_VAULT_DIR` es una constante de módulo. Se
reemplaza por una función `resolveVaultDir()` que aplica la cascada de arriba
(pasos 1–3; el paso 4/HTTP ya es el fallback existente cuando no hay dir). Lee
`.bridges` de `process.cwd()`. El resto de la lógica (`USE_LOCAL`, índice FTS
local, fallback HTTP) queda igual, operando sobre el dir resuelto.

`.bridges` en el repo consumidor:

```jsonc
{
  "vault": "PxSol",                          // matchea connections[].name (o basename)
  "folder": "01 - Proyectos/pxsol-blanco"    // destino de docs (lo usan skill/command)
}
```

Si `.bridges` nombra un vault que no está en `connections[]` → se ignora (log) y
cae al paso 2/3. Si falta `.bridges` → paso 2/3 directo.

### 3. `mcp/src/index.ts` — tool nueva `list_vaults`

```ts
server.registerTool("list_vaults", {
  title: "Listar los vaults de Bridges configurados",
  description:
    "Devuelve los vaults que el usuario tiene configurados en la app de Bridges " +
    "(nombre, ruta local, y cuál es el default). Read-only, no expone tokens. " +
    "Usalo para saber a qué vault escribir/leer cuando el repo no tiene .bridges " +
    "o hay ambigüedad.",
  inputSchema: {}, // sin argumentos
}, async () => {
  const vaults = readVaults();
  if (!vaults.length) return { content: [{ type: "text", text: "No hay vaults configurados en la app de Bridges." }] };
  const text = vaults.map(v => `- ${v.name}${v.isDefault ? " (default)" : ""}\n  ${v.path}`).join("\n");
  return { content: [{ type: "text", text }] };
});
```

Las 4 tools existentes **no cambian su contrato**.

### 4. `.claude-plugin/plugin.json` + `marketplace.json`

`plugin.json` (calcado de `pxsol-uxui`, + `mcpServers`):

```jsonc
{
  "name": "bridges",
  "version": "0.1.0",
  "description": "Vault de documentación del equipo (Obsidian self-hosteado) como capacidad de Claude Code: MCP read-only para buscar/leer/navegar el vault, skill para documentar repos, command /bridges y agente doc-writer. El repo consumidor declara su vault en .bridges.",
  "author": { "name": "Bridges — PXSOL" },
  "keywords": ["docs", "vault", "obsidian", "mcp", "knowledge-base"],
  "mcpServers": {
    "bridges": {
      "command": "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/launch.sh"
    }
  }
}
```

El `command` es el launcher, no `bun`: el consumidor no necesita Bun (ver §8).

`marketplace.json`:

```jsonc
{
  "name": "bridges",
  "owner": { "name": "Bridges — PXSOL" },
  "plugins": [
    { "name": "bridges", "source": "./", "description": "MCP read-only del vault + skill bridges-docs + /bridges + agente doc-writer." }
  ]
}
```

Instalación:

```
/plugin marketplace add SoPxsol/forge      # repo privado: usa credenciales de git
/plugin install bridges@bridges
/reload-plugins
```

Pin de versión: apuntar el marketplace a un tag/sha.

### 5. `commands/bridges.md` — `/bridges`

Command único con sub-acciones (parseadas del argumento):

- `/bridges buscar <query>` → `search_vault` (+ `pathPrefix` del `folder` de `.bridges` si aplica).
- `/bridges abrir <nota>` → `read_note` (o `search_vault` + `read_note` del top hit).
- `/bridges vaults` → `list_vaults`.
- `/bridges documentar` → dispara la skill `bridges-docs` para el repo actual.
- Sin `.bridges` y con >1 vault: el command corre `list_vaults`, pregunta cuál, y
  **ofrece crear `.bridges`** con el vault elegido + `folder` sugerido.

### 6. `agents/doc-writer.md` — subagente

Agente especializado en documentar/mantener el vault siguiendo `bridges-docs`
(estructura `01 - Proyectos/`, wikilinks, índice). Read/write sobre archivos `.md`
del vault; read-only sobre el código del repo que documenta. Invocable desde
cualquier repo con el plugin instalado.

### 7. Deprecación de `forge-docs`

La skill global `forge-docs` (`~/.claude/skills/forge-docs/`) se marca deprecada
(nota en su `SKILL.md` apuntando a `bridges-docs` del plugin). No se borra en este
spec para no romper flujos en curso; se retira en un paso posterior.

### 8. Packaging y distribución del MCP (binario, sin Bun en el consumidor)

El MCP usa `bun:sqlite` (`mcp/src/localIndex.ts`) para el índice FTS local, así
que **no corre con Node**. Se distribuye como **binario self-contained** de Bun
(`bun build --compile`, embebe runtime + sqlite): quien compila necesita Bun,
quien instala el plugin **no necesita nada de Bun**.

**Build (CI, `.github/workflows/mcp-release.yml`):** al pushear un tag `mcp-v*`,
un job por plataforma corre:

```bash
bun build --compile --target=bun-<os>-<arch> ./mcp/src/index.ts \
  --outfile bridges-mcp-<os>-<arch>
```

Targets v1: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`. (Windows queda
fuera de v1; ver Riesgos.) Los binarios se suben como **assets del GitHub Release**
del tag. Los binarios **no se commitean** al repo.

**Launcher (`.claude-plugin/launch.sh`, POSIX sh):** es el `command` del
`mcpServers`. Al arrancar:

1. Detecta plataforma (`uname -s`/`uname -m` → `darwin-arm64`, etc.).
2. Resuelve la versión objetivo (lee `version` de `plugin.json` vía el tag
   correspondiente, o una constante `MCP_VERSION` en el script).
3. Busca el binario cacheado en `${XDG_CACHE_HOME:-~/.cache}/bridges-mcp/<version>/bridges-mcp-<plat>`.
4. Si falta, lo baja del GitHub Release (`curl -fsSL`) del tag `mcp-v<version>`,
   `chmod +x`, y valida (tamaño/checksum si publicamos `SHA256SUMS`).
5. `exec` del binario, heredando stdio (el MCP habla por stdio) y el entorno
   (incluye `cwd` = repo consumidor, para la cascada de resolución de vault).

Requisitos en el consumidor: `sh` + `curl` (nativos en mac/linux). Sin red, si el
binario ya está cacheado, funciona offline; la primera vez necesita conexión al
Release.

**Errores del launcher:** si la plataforma no tiene binario publicado, o la
descarga falla, `launch.sh` sale con un mensaje claro a stderr (que Claude Code
muestra como fallo del MCP) indicando plataforma detectada y URL intentada.

## Manejo de errores

- **`bridges.json` ausente/corrupto:** `readVaults()` devuelve `[]`, `list_vaults`
  responde "no hay vaults configurados", y la cascada de resolución cae a
  `BRIDGES_VAULT_DIR`/HTTP. Nunca lanza.
- **`.bridges` con vault inexistente:** se ignora con log, cae al default.
- **`.bridges` malformado (JSON inválido):** se ignora con log, cae al default.
- **Plataforma sin binario / descarga fallida:** `launch.sh` sale con mensaje
  claro (plataforma + URL intentada); Claude Code lo muestra como fallo del MCP
  (ver §8). El consumidor NO necesita Bun.
- **Vault local inaccesible:** comportamiento actual (fallback a HTTP si hay
  server; si no, error por tool con mensaje claro).

## Testing

Baseline del repo: `cd mcp && bun test` (el MCP ya tiene `localIndex.test.ts`).

- `config.test.ts` (nuevo): `readVaults()` contra un `bridges.json` fixture
  (vía `BRIDGES_CONFIG`) — mapea `isDefault`, cae a basename cuando falta `name`,
  **no incluye `token`**, devuelve `[]` si el archivo no existe o es JSON inválido.
- `resolveVaultDir` (en `bridges.test.ts` o extendiendo el existente): cascada
  `.bridges` → env → `lastVault`; `.bridges` con vault inexistente cae al default;
  sin config ni env → null (fuerza HTTP).
- **Launcher (`launch.sh`):** test de detección de plataforma (`uname` mockeado)
  y de la ruta de caché resuelta; que con el binario ya cacheado no llama a `curl`.
- **CI build:** el workflow `mcp-release.yml` produce los 3 binarios y arrancan
  (`bridges-mcp --version` o un handshake MCP mínimo) — verificable en el job.
- **Smoke manual** (STOP condition, no automatizable): taggear `mcp-v0.1.0`,
  instalar el plugin en un repo real (p. ej. `pxsol-blanco`) con un `.bridges` en
  una máquina **sin Bun**, y verificar en Claude Code: el launcher baja/cachea el
  binario, `/bridges vaults` lista, `/bridges buscar <x>` devuelve hits rankeados,
  `/bridges documentar` escribe bajo el `folder` correcto del vault correcto.

## Decisiones tomadas (en brainstorming)

- **Scope v1:** los 4 componentes (MCP + skill + command + agente). Bundle completo.
- **Resolución de vault:** cascada con `bridges.json` (`lastVault`) como default
  zero-config, + `list_vaults` para enumerar todos.
- **Binding por-repo:** marcador **committeado** `.bridges` (opción "adapter",
  como el `ux-context.md` de `pxsol-uxui`) — determinista y compartido por el
  equipo, en vez de memoria local o "siempre lastVault".
- **Packaging:** binario Bun compilado (`bun build --compile`, porque el MCP usa
  `bun:sqlite`) distribuido por **GitHub Release + launcher** (opción B), no `bun
  run` — para que quien instale el plugin no necesite Bun. Alternativa descartada:
  binario committeado (opción A) por peso de repo/clone y dep escondida de
  `git-lfs`.

## Riesgos / preguntas abiertas

- **Windows fuera de v1:** el launcher es POSIX `sh` y los targets son
  mac/linux. Windows necesitaría un `launch.cmd`/`.ps1` + target
  `bun-windows-x64`. Diferido hasta que haya un consumidor Windows.
- **Primer arranque necesita red:** el launcher baja el binario del Release la
  primera vez (después cachea y va offline). Si el Release/tag no existe aún, el
  MCP no arranca — el tag `mcp-v<version>` debe publicarse antes de que alguien
  instale esa versión.
- **Tamaño del binario:** cada binario `--compile` pesa ~60-90MB. Vive en el
  Release (no en git) y en `~/.cache` del consumidor; aceptable.
- **Config path:** `configPath()` cubre mac/Linux con el identifier
  `com.pepo.bridges` (mismo que `vault-path.sh`), validado solo en mac (entorno
  del equipo). El `BRIDGES_CONFIG` override cubre tests y casos raros.
- **`${CLAUDE_PLUGIN_ROOT}`:** se asume que Claude Code expone esa variable a los
  `mcpServers` del plugin (como en la doc de plugins). A verificar en el smoke test;
  si no, se usa ruta relativa al plugin por otro mecanismo soportado.
