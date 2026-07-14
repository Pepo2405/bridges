# Bridges como plugin de Claude Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empaquetar Bridges como plugin+marketplace de Claude Code: MCP read-only con resolución de vault zero-config y `list_vaults`, skill `bridges-docs`, command `/bridges`, agente `doc-writer`, y distribución del MCP como binario compilado vía GitHub Release + launcher (sin Bun en el consumidor).

**Architecture:** El repo `forge` se vuelve plugin (`.claude-plugin/`). El MCP existente gana un módulo puro `config.ts` (lee `bridges.json`) y una función `resolveVaultDir()` con cascada (`.bridges` del repo → `BRIDGES_VAULT_DIR` → `lastVault` → HTTP). El plugin declara el MCP vía un `launch.sh` que baja/cachea un binario `bun build --compile` publicado en el GitHub Release del tag `mcp-v*`.

**Tech Stack:** Bun (runtime + `bun:test` + `bun build --compile` + `bun:sqlite`), `@modelcontextprotocol/sdk`, zod, TypeScript, POSIX sh, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-14-bridges-claude-plugin-design.md`

## Global Constraints

- **Runtime del MCP:** Bun. Baseline de tests: `cd mcp && bun test`. Tests con `bun:test` (`import { test, expect, describe } from "bun:test"`).
- **El MCP sigue read-only:** no se agregan tools de escritura. `list_vaults` no expone `token`.
- **Config dir de la app:** identifier `com.pepo.bridges` (NO `com.pxsol.bridges`). macOS: `~/Library/Application Support/com.pepo.bridges/bridges.json`; Linux: `${XDG_CONFIG_HOME:-~/.config}/com.pepo.bridges/bridges.json`.
- **`default` de vault:** `lastVault`, con fallback a la primera `connection` con `vault` (misma lógica que `skills/bridges-docs/scripts/vault-path.sh`).
- **Consumidor sin Bun:** el `command` del MCP es `launch.sh` (POSIX sh + curl), nunca `bun run`.
- **Targets de binario v1:** `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`. Windows fuera de v1.
- **Nombre del plugin y del marketplace:** ambos `bridges`. Repo: `SoPxsol/forge`.
- **Commits:** frecuentes, uno por task. Todo el trabajo en la rama actual `docs/bridges-plugin-spec` (o una rama de feature dedicada); NO tocar `main` directo.

## File Structure

- `mcp/src/config.ts` (crear) — localiza/parsea `bridges.json`; `VaultConn`, `configPath`, `readVaults`, `defaultVaultDir`, `formatVaults`.
- `mcp/src/config.test.ts` (crear) — tests de `readVaults`/`defaultVaultDir`/`formatVaults` con fixture vía `BRIDGES_CONFIG`.
- `mcp/src/bridges.ts` (modificar) — `resolveVaultDir()` (cascada + lee `.bridges` de cwd), reemplaza el `const VAULT_DIR = process.env...`.
- `mcp/src/bridges.test.ts` (crear) — tests de `resolveVaultDir()`.
- `mcp/src/index.ts` (modificar) — registra la tool `list_vaults`.
- `.claude-plugin/plugin.json` (crear) — manifiesto del plugin + `mcpServers`.
- `.claude-plugin/marketplace.json` (crear) — catálogo con 1 plugin.
- `.claude-plugin/launch.sh` (crear) — launcher del binario del MCP.
- `.github/workflows/mcp-release.yml` (crear) — buildea binarios por plataforma al taggear `mcp-v*` y los sube al Release.
- `commands/bridges.md` (crear) — command `/bridges`.
- `agents/doc-writer.md` (crear) — subagente documentador.
- Skill global `forge-docs` (modificar, fuera del repo) — nota de deprecación.

---

### Task 1: `config.ts` — leer `bridges.json`

**Files:**
- Create: `mcp/src/config.ts`
- Test: `mcp/src/config.test.ts`

**Interfaces:**
- Consumes: nada (módulo puro; sólo `node:fs`, `node:os`, `node:path`).
- Produces:
  - `type VaultConn = { name: string; path: string; serverUrl: string | null; isDefault: boolean }`
  - `function configPath(): string | null`
  - `function readVaults(): VaultConn[]` — nunca lanza; `[]` si no hay config o no parsea; nunca incluye `token`.
  - `function defaultVaultDir(): string | null` — `lastVault ?? primera connection con vault`.
  - `function formatVaults(vaults: VaultConn[]): string` — texto para la tool.

- [ ] **Step 1: Write the failing test**

Create `mcp/src/config.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaults, defaultVaultDir, formatVaults } from "./config";

let dir: string;
let cfg: string;

function writeCfg(obj: unknown) {
  writeFileSync(cfg, JSON.stringify(obj), "utf8");
  process.env.BRIDGES_CONFIG = cfg;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridges-cfg-"));
  cfg = join(dir, "bridges.json");
});
afterEach(() => {
  delete process.env.BRIDGES_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe("readVaults", () => {
  test("mapea connections, marca el default y no expone token", () => {
    writeCfg({
      connections: [
        { vault: "/v/pxsol", name: "PxSol", serverUrl: "http://s", token: "SECRET", openedAt: "x" },
        { vault: "/v/otro", serverUrl: null, openedAt: "y" },
      ],
      lastVault: "/v/otro",
    });
    const vaults = readVaults();
    expect(vaults).toEqual([
      { name: "PxSol", path: "/v/pxsol", serverUrl: "http://s", isDefault: false },
      { name: "otro", path: "/v/otro", serverUrl: null, isDefault: true },
    ]);
    expect(JSON.stringify(vaults)).not.toContain("SECRET");
  });

  test("cae a [] si el config no existe o es JSON inválido", () => {
    process.env.BRIDGES_CONFIG = join(dir, "no-existe.json");
    expect(readVaults()).toEqual([]);
    writeFileSync(cfg, "{ no json", "utf8");
    process.env.BRIDGES_CONFIG = cfg;
    expect(readVaults()).toEqual([]);
  });
});

describe("defaultVaultDir", () => {
  test("usa lastVault", () => {
    writeCfg({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    expect(defaultVaultDir()).toBe("/v/a");
  });
  test("cae a la primera connection si no hay lastVault", () => {
    writeCfg({ connections: [{ vault: "/v/a", openedAt: "x" }] });
    expect(defaultVaultDir()).toBe("/v/a");
  });
  test("null si no hay vaults", () => {
    writeCfg({ connections: [] });
    expect(defaultVaultDir()).toBeNull();
  });
});

describe("formatVaults", () => {
  test("marca el default y lista la ruta", () => {
    const out = formatVaults([
      { name: "PxSol", path: "/v/pxsol", serverUrl: null, isDefault: false },
      { name: "otro", path: "/v/otro", serverUrl: null, isDefault: true },
    ]);
    expect(out).toContain("- PxSol\n  /v/pxsol");
    expect(out).toContain("- otro (default)\n  /v/otro");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && bun test src/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write minimal implementation**

Create `mcp/src/config.ts`:

```ts
/** Lee la config de la app Bridges (bridges.json) para enumerar vaults y resolver
 *  el default. Módulo puro y read-only; nunca lanza y nunca expone tokens. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type VaultConn = {
  name: string;
  path: string;
  serverUrl: string | null;
  isDefault: boolean;
};

type RawConn = { vault?: string; name?: string; serverUrl?: string | null; token?: string; openedAt?: string };
type RawCfg = { connections?: RawConn[]; lastVault?: string };

/** Ruta del bridges.json. Prioridad: BRIDGES_CONFIG (test/override) → macOS → Linux.
 *  Identifier de la app Tauri: com.pepo.bridges (igual que vault-path.sh). */
export function configPath(): string | null {
  if (process.env.BRIDGES_CONFIG) return process.env.BRIDGES_CONFIG;
  const home = homedir();
  const candidates = [
    join(home, "Library", "Application Support", "com.pepo.bridges", "bridges.json"),
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "com.pepo.bridges", "bridges.json"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      // sigue probando
    }
  }
  return null;
}

function readCfg(): RawCfg | null {
  const p = configPath();
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawCfg;
  } catch {
    return null;
  }
}

export function readVaults(): VaultConn[] {
  const cfg = readCfg();
  if (!cfg?.connections) return [];
  return cfg.connections
    .filter((c): c is RawConn & { vault: string } => typeof c.vault === "string")
    .map((c) => ({
      name: c.name ?? basename(c.vault),
      path: c.vault,
      serverUrl: c.serverUrl ?? null,
      isDefault: c.vault === cfg.lastVault,
    }));
}

export function defaultVaultDir(): string | null {
  const cfg = readCfg();
  if (!cfg) return null;
  if (cfg.lastVault) return cfg.lastVault;
  return cfg.connections?.find((c) => c.vault)?.vault ?? null;
}

export function formatVaults(vaults: VaultConn[]): string {
  return vaults.map((v) => `- ${v.name}${v.isDefault ? " (default)" : ""}\n  ${v.path}`).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && bun test src/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/src/config.ts mcp/src/config.test.ts
git commit -m "feat(mcp): config.ts para enumerar vaults de bridges.json"
```

---

### Task 2: `resolveVaultDir()` — cascada de resolución en `bridges.ts`

**Files:**
- Modify: `mcp/src/bridges.ts` (constantes `VAULT_DIR`/`USE_LOCAL` al tope del archivo)
- Test: `mcp/src/bridges.test.ts` (crear)

**Interfaces:**
- Consumes: `defaultVaultDir` y `readVaults` de `./config` (Task 1).
- Produces:
  - `function resolveVaultDir(cwd?: string): string | null` — exportada y testeable. Cascada: `.bridges` de `cwd` → `BRIDGES_VAULT_DIR` → `defaultVaultDir()`. `null` si nada resuelve (fuerza HTTP).
  - `type BridgesMarker = { vault?: string; folder?: string }`
  - `function readMarker(cwd?: string): BridgesMarker | null` — lee/parsea `.bridges` de `cwd`; `null` si no existe o no parsea.

- [ ] **Step 1: Write the failing test**

Create `mcp/src/bridges.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultDir, readMarker } from "./bridges";

let repo: string;   // cwd simulado del consumidor
let cfgDir: string; // dir del bridges.json

function writeConfig(obj: unknown) {
  const p = join(cfgDir, "bridges.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  process.env.BRIDGES_CONFIG = p;
}
function writeMarker(obj: unknown) {
  writeFileSync(join(repo, ".bridges"), JSON.stringify(obj), "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bridges-repo-"));
  cfgDir = mkdtempSync(join(tmpdir(), "bridges-cfg-"));
  delete process.env.BRIDGES_VAULT_DIR;
});
afterEach(() => {
  delete process.env.BRIDGES_CONFIG;
  delete process.env.BRIDGES_VAULT_DIR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("readMarker", () => {
  test("lee y parsea .bridges", () => {
    writeMarker({ vault: "PxSol", folder: "01 - Proyectos/x" });
    expect(readMarker(repo)).toEqual({ vault: "PxSol", folder: "01 - Proyectos/x" });
  });
  test("null si no existe o es inválido", () => {
    expect(readMarker(repo)).toBeNull();
    writeFileSync(join(repo, ".bridges"), "{ nope", "utf8");
    expect(readMarker(repo)).toBeNull();
  });
});

describe("resolveVaultDir cascada", () => {
  test("1) .bridges por name gana", () => {
    writeConfig({ connections: [{ vault: "/v/pxsol", name: "PxSol", openedAt: "x" }], lastVault: "/v/pxsol" });
    writeMarker({ vault: "PxSol" });
    expect(resolveVaultDir(repo)).toBe("/v/pxsol");
  });
  test("1b) .bridges matchea por basename del path", () => {
    writeConfig({ connections: [{ vault: "/vaults/equipo", openedAt: "x" }], lastVault: "/vaults/equipo" });
    writeMarker({ vault: "equipo" });
    expect(resolveVaultDir(repo)).toBe("/vaults/equipo");
  });
  test("2) .bridges con vault inexistente cae al default", () => {
    writeConfig({ connections: [{ vault: "/v/a", name: "A", openedAt: "x" }], lastVault: "/v/a" });
    writeMarker({ vault: "NoExiste" });
    expect(resolveVaultDir(repo)).toBe("/v/a");
  });
  test("3) BRIDGES_VAULT_DIR gana sobre el default cuando no hay .bridges", () => {
    writeConfig({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    process.env.BRIDGES_VAULT_DIR = "/env/dir";
    expect(resolveVaultDir(repo)).toBe("/env/dir");
  });
  test("4) sin .bridges ni env usa lastVault", () => {
    writeConfig({ connections: [{ vault: "/v/a", openedAt: "x" }], lastVault: "/v/a" });
    expect(resolveVaultDir(repo)).toBe("/v/a");
  });
  test("5) null si nada resuelve (fuerza HTTP)", () => {
    process.env.BRIDGES_CONFIG = join(cfgDir, "no.json");
    expect(resolveVaultDir(repo)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && bun test src/bridges.test.ts`
Expected: FAIL — `resolveVaultDir`/`readMarker` no exportadas.

- [ ] **Step 3: Write minimal implementation**

En `mcp/src/bridges.ts`, agregar imports al tope (junto a los existentes):

```ts
import { readFileSync } from "node:fs";            // ya está
import { join, normalize, sep, basename } from "node:path";  // + basename
import { defaultVaultDir, readVaults } from "./config";       // nuevo
```

Reemplazar el bloque de constantes actual:

```ts
// ANTES:
const VAULT_DIR = process.env.BRIDGES_VAULT_DIR;
```

por la resolución con cascada:

```ts
export type BridgesMarker = { vault?: string; folder?: string };

/** Lee el marcador .bridges del repo consumidor. null si no existe o no parsea. */
export function readMarker(cwd: string = process.cwd()): BridgesMarker | null {
  try {
    return JSON.parse(readFileSync(join(cwd, ".bridges"), "utf8")) as BridgesMarker;
  } catch {
    return null;
  }
}

/** Cascada: .bridges (por name o basename) → BRIDGES_VAULT_DIR → lastVault. null → HTTP. */
export function resolveVaultDir(cwd: string = process.cwd()): string | null {
  const marker = readMarker(cwd);
  if (marker?.vault) {
    const hit = readVaults().find((v) => v.name === marker.vault || basename(v.path) === marker.vault);
    if (hit) return hit.path;
    console.error(`[bridges-mcp] .bridges nombra un vault desconocido: "${marker.vault}"; uso el default.`);
  }
  if (process.env.BRIDGES_VAULT_DIR) return process.env.BRIDGES_VAULT_DIR;
  return defaultVaultDir();
}

// Raíz del vault resuelta una vez al arrancar el proceso (cwd = repo consumidor).
const VAULT_DIR = resolveVaultDir() ?? undefined;
```

`USE_LOCAL`, `BASE`, `TOKEN` y el resto del archivo quedan igual (siguen leyendo `VAULT_DIR`, que ahora puede venir de la cascada). `VAULT_DIR` sigue siendo `string | undefined`, así que `USE_LOCAL = !!VAULT_DIR && ...` no cambia.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && bun test src/bridges.test.ts && bun test`
Expected: PASS (bridges.test 8 tests + toda la suite del MCP verde — sin regresiones en `localIndex.test.ts`/`graph.test.ts`).

- [ ] **Step 5: Type-check**

Run: `cd mcp && bun run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/bridges.ts mcp/src/bridges.test.ts
git commit -m "feat(mcp): resolveVaultDir con cascada .bridges → env → lastVault"
```

---

### Task 3: Tool `list_vaults` en `index.ts`

**Files:**
- Modify: `mcp/src/index.ts` (import + un `server.registerTool` nuevo, antes del bloque `const transport = ...`)

**Interfaces:**
- Consumes: `readVaults`, `formatVaults` de `./config` (Task 1).
- Produces: la tool MCP `list_vaults` (sin argumentos).

- [ ] **Step 1: Agregar el import**

En `mcp/src/index.ts`, junto a los imports existentes:

```ts
import { readVaults, formatVaults } from "./config";
```

- [ ] **Step 2: Registrar la tool**

Insertar antes de `const transport = new StdioServerTransport();`:

```ts
server.registerTool(
  "list_vaults",
  {
    title: "Listar los vaults de Bridges configurados",
    description:
      "Devuelve los vaults que el usuario tiene configurados en la app de Bridges " +
      "(nombre, ruta local y cuál es el default). Read-only, no expone tokens. Usalo " +
      "para saber a qué vault leer/escribir cuando el repo no tiene .bridges o hay ambigüedad.",
    inputSchema: {},
  },
  async () => {
    const vaults = readVaults();
    if (!vaults.length) {
      return { content: [{ type: "text", text: "No hay vaults configurados en la app de Bridges." }] };
    }
    return { content: [{ type: "text", text: `${vaults.length} vault(s):\n\n${formatVaults(vaults)}` }] };
  },
);
```

- [ ] **Step 3: Type-check**

Run: `cd mcp && bun run typecheck`
Expected: sin errores (el `typecheck` valida la firma de `server.registerTool` y el uso de `readVaults`/`formatVaults`).

> El arranque real del server (habla stdio y bloquea) se verifica en el smoke
> manual final, no acá — importar `index.ts` cuelga a propósito en `server.connect`.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): tool list_vaults (read-only, sin tokens)"
```

---

### Task 4: Manifiestos del plugin (`plugin.json` + `marketplace.json`)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: `launch.sh` (Task 5) como `command` — el path se declara acá; el archivo se crea en Task 5.
- Produces: repo instalable como plugin `bridges@bridges`.

- [ ] **Step 1: Crear `plugin.json`**

```json
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

- [ ] **Step 2: Crear `marketplace.json`**

```json
{
  "name": "bridges",
  "owner": { "name": "Bridges — PXSOL" },
  "plugins": [
    {
      "name": "bridges",
      "source": "./",
      "description": "MCP read-only del vault + skill bridges-docs + /bridges + agente doc-writer."
    }
  ]
}
```

- [ ] **Step 3: Validar JSON**

Run: `for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do bun -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f OK')"; done`
Expected: ambos `OK`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(plugin): manifiestos plugin.json + marketplace.json (bridges)"
```

---

### Task 5: Launcher + workflow de release del binario del MCP

**Files:**
- Create: `.claude-plugin/launch.sh`
- Create: `.github/workflows/mcp-release.yml`

**Interfaces:**
- Consumes: `plugin.json` (Task 4) declara este `launch.sh` como `command`.
- Produces: `launch.sh` que resuelve/baja/ejecuta `bridges-mcp-<plat>` del Release del tag `mcp-v<version>`.

- [ ] **Step 1: Crear `launch.sh`**

```sh
#!/bin/sh
# Launcher del MCP de Bridges: resuelve el binario compilado para esta plataforma
# (cache en ~/.cache/bridges-mcp/<version>/), lo baja del GitHub Release si falta,
# y lo ejecuta hablando stdio. El consumidor no necesita Bun.
set -eu

VERSION="0.1.0"                 # mantener sincronizado con plugin.json / tag mcp-v<VERSION>
REPO="SoPxsol/forge"
TAG="mcp-v${VERSION}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) case "$arch" in arm64) plat="darwin-arm64" ;; x86_64) plat="darwin-x64" ;; *) plat="" ;; esac ;;
  Linux)  case "$arch" in x86_64) plat="linux-x64" ;; *) plat="" ;; esac ;;
  *) plat="" ;;
esac
if [ -z "$plat" ]; then
  echo "[bridges-mcp] plataforma no soportada: $os/$arch" >&2
  exit 1
fi

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/bridges-mcp/${VERSION}"
bin="${cache_dir}/bridges-mcp-${plat}"

if [ "${BRIDGES_MCP_DRYRUN:-0}" = "1" ]; then
  echo "plat=${plat} bin=${bin} url=https://github.com/${REPO}/releases/download/${TAG}/bridges-mcp-${plat}"
  exit 0
fi

if [ ! -x "$bin" ]; then
  mkdir -p "$cache_dir"
  url="https://github.com/${REPO}/releases/download/${TAG}/bridges-mcp-${plat}"
  echo "[bridges-mcp] descargando binario ${plat} (${TAG})..." >&2
  if ! curl -fsSL "$url" -o "$bin"; then
    echo "[bridges-mcp] falló la descarga de $url" >&2
    rm -f "$bin"
    exit 1
  fi
  chmod +x "$bin"
fi

exec "$bin"
```

- [ ] **Step 2: Hacerlo ejecutable + verificar dry-run**

```bash
chmod +x .claude-plugin/launch.sh
BRIDGES_MCP_DRYRUN=1 .claude-plugin/launch.sh
```

Expected (en mac arm64): `plat=darwin-arm64 bin=.../.cache/bridges-mcp/0.1.0/bridges-mcp-darwin-arm64 url=https://github.com/SoPxsol/forge/releases/download/mcp-v0.1.0/bridges-mcp-darwin-arm64`

- [ ] **Step 3: Crear el workflow de release**

Create `.github/workflows/mcp-release.yml`:

```yaml
name: mcp-release
on:
  push:
    tags: ["mcp-v*"]
permissions:
  contents: write
jobs:
  build:
    strategy:
      matrix:
        include:
          - { runner: macos-14, target: bun-darwin-arm64, out: bridges-mcp-darwin-arm64 }
          - { runner: macos-13, target: bun-darwin-x64,   out: bridges-mcp-darwin-x64 }
          - { runner: ubuntu-latest, target: bun-linux-x64, out: bridges-mcp-linux-x64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: cd mcp && bun install --frozen-lockfile || bun install
      - name: Compile
        run: |
          cd mcp
          bun build --compile --target=${{ matrix.target }} ./src/index.ts --outfile ${{ matrix.out }}
          ./${{ matrix.out }} --help >/dev/null 2>&1 || true
      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          files: mcp/${{ matrix.out }}
```

- [ ] **Step 4: Lint YAML**

Run: `bun -e "const y=require('fs').readFileSync('.github/workflows/mcp-release.yml','utf8'); if(!y.includes('bun build --compile')) throw new Error('falta el compile'); console.log('workflow OK')"`
Expected: `workflow OK`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/launch.sh .github/workflows/mcp-release.yml
git commit -m "feat(plugin): launch.sh + workflow de release del binario del MCP"
```

---

### Task 6: Command `/bridges`

**Files:**
- Create: `commands/bridges.md`

**Interfaces:**
- Consumes: las tools MCP (`search_vault`, `read_note`, `list_vaults`) y la skill `bridges-docs`.
- Produces: el slash-command `/bridges`.

- [ ] **Step 1: Crear `commands/bridges.md`**

```markdown
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
```

- [ ] **Step 2: Verificar frontmatter**

Run: `head -5 commands/bridges.md`
Expected: bloque `---` con `description:` y `argument-hint:`.

- [ ] **Step 3: Commit**

```bash
git add commands/bridges.md
git commit -m "feat(plugin): command /bridges (buscar|abrir|vaults|documentar)"
```

---

### Task 7: Agente `doc-writer`

**Files:**
- Create: `agents/doc-writer.md`

**Interfaces:**
- Consumes: la skill `bridges-docs` y las tools MCP de lectura.
- Produces: el subagente `doc-writer`.

- [ ] **Step 1: Crear `agents/doc-writer.md`**

```markdown
---
name: doc-writer
description: Documenta y mantiene repos dentro del vault de Bridges siguiendo las convenciones de bridges-docs (estructura "01 - Proyectos/{repo}/", wikilinks, índice). Escribe .md en el vault; read-only sobre el código del repo. Invocalo cuando haya que documentar el repo actual en Bridges o actualizar sus docs.
tools: Read, Grep, Glob, Bash, Write, Edit
---

Sos el documentador del vault de Bridges. Tu trabajo:

1. Resolvé el vault y la carpeta destino: si el repo tiene `.bridges`, usá su
   `vault`/`folder`; si no, usá la tool `list_vaults` (o `bash skills/.../vault-path.sh`)
   y la convención `01 - Proyectos/{basename-repo}/`.
2. Explorá el repo (read-only) para entender qué hace, su stack y sus piezas.
3. Escribí/actualizá los `.md` en el vault siguiendo la skill **`bridges-docs`**:
   estructura de carpeta del proyecto, `[[wikilinks]]` a notas relacionadas y el
   índice del vault. La app de Bridges sincroniza los `.md` sola.
4. Antes de sobrescribir una nota existente, leela y preservá lo que siga válido —
   documentás, no vacías.

NO modificás el código del repo. NO borrás notas (eso es acción del owner en la app).
```

- [ ] **Step 2: Verificar frontmatter**

Run: `head -4 agents/doc-writer.md`
Expected: `---` con `name: doc-writer` y `description:`.

- [ ] **Step 3: Commit**

```bash
git add agents/doc-writer.md
git commit -m "feat(plugin): agente doc-writer para documentar en el vault"
```

---

### Task 8: Deprecar la skill global `forge-docs`

**Files:**
- Modify: la skill global `forge-docs` (fuera del repo; localizar con el paso 1).

**Interfaces:**
- Consumes: nada.
- Produces: nota de deprecación que apunta a `bridges-docs` del plugin.

- [ ] **Step 1: Localizar la skill**

Run: `ls ~/.claude/skills/forge-docs/SKILL.md 2>/dev/null || find ~/.claude -maxdepth 4 -type d -name forge-docs 2>/dev/null`
Expected: la ruta del `SKILL.md` de `forge-docs`.

Si no aparece (la skill vino de otro lado), reportarlo y saltar el task — no inventar rutas.

- [ ] **Step 2: Agregar el aviso de deprecación**

Insertar al inicio del cuerpo del `SKILL.md` (después del frontmatter):

```markdown
> **DEPRECADA.** Esta skill fue reemplazada por `bridges-docs`, distribuida en el
> plugin `bridges` (repo `SoPxsol/forge`). Instalá el plugin
> (`/plugin install bridges@bridges`) y usá `bridges-docs` / `/bridges documentar`.
> Se retira en un paso posterior.
```

- [ ] **Step 3: Verificar**

Run: `head -20 <ruta-del-SKILL.md-de-forge-docs>`
Expected: el aviso de deprecación visible tras el frontmatter.

- [ ] **Step 4: Commit (si la skill vive en un repo con git; si es un archivo suelto en ~/.claude, no hay commit)**

Si aplica:
```bash
git -C <repo-de-la-skill> add <ruta-SKILL.md>
git -C <repo-de-la-skill> commit -m "docs(forge-docs): deprecar en favor de bridges-docs (plugin bridges)"
```
Si es un archivo suelto en `~/.claude/skills/`, dejar constancia en el reporte (no hay repo que commitear).

---

## Verificación final (smoke manual — STOP condition)

No automatizable; requiere publicar el Release y una máquina consumidora:

1. `git push` de la rama; abrir PR a `main` del repo `forge`; mergear.
2. Taggear y publicar el binario: `git tag mcp-v0.1.0 && git push origin mcp-v0.1.0` → esperar a que `mcp-release` suba los 3 binarios al Release.
3. En una máquina **sin Bun** con el vault sincronizado, en un repo con `.bridges`:
   - `/plugin marketplace add SoPxsol/forge`
   - `/plugin install bridges@bridges` → `/reload-plugins`
   - Verificar: el launcher baja y cachea el binario; `/bridges vaults` lista los vaults; `/bridges buscar <término>` devuelve hits rankeados; `/bridges documentar` escribe bajo el `folder`/vault correctos.
4. Confirmar que `${CLAUDE_PLUGIN_ROOT}` se expande en el `command` del MCP (riesgo del spec). Si no, ajustar el `command` al mecanismo soportado por la versión de Claude Code.
