# Instaladores cross-platform (GitHub Actions) — Design

**Fecha:** 2026-06-01
**Proyecto:** Bridges (app Tauri 2 — `client/src-tauri`; repo privado `Pepo2405/forge`)

## Contexto

Hoy el build de la app desktop es manual, arm64-only y sin firma; no hay CI
(`.github/workflows` no existe). Queremos que el repo ofrezca **instaladores
descargables para Linux, macOS y Windows** sin compilar a mano en cada plataforma.

Decisiones tomadas en brainstorming:
- **Descargas privadas:** el repo sigue privado; los Releases los bajan solo
  quienes tienen acceso al repo (logueados en GitHub). Sin costo ni exposición pública.
- **Sin firma:** no se firman ni notarizan los binarios. Funcionan con la advertencia
  del SO; se documenta el "cómo abrir". Se podrá agregar firma después sin rehacer el pipeline.
- **Trigger por tag** `v*` + disparo manual (`workflow_dispatch`).

## Arquitectura

Un único workflow `.github/workflows/release.yml` que corre en GitHub Actions usando
la action oficial **`tauri-apps/tauri-action`**, con una **matriz de 3 runners** que
compilan en paralelo y suben los assets al mismo Release:

| OS | Runner | Instaladores | Notas |
|---|---|---|---|
| macOS | `macos-latest` | `.dmg` **universal** | `args: --target universal-apple-darwin` (Intel + Apple Silicon en un solo dmg) |
| Windows | `windows-latest` | `.msi` (WiX) + `.exe` (NSIS) | targets default de Tauri |
| Linux | `ubuntu-22.04` | `.AppImage` + `.deb` | requiere deps de sistema (abajo) |

El `GITHUB_TOKEN` integrado del runner le da permiso a `tauri-action` para crear el
Release y subir assets en el repo privado. No hace falta PAT ni que `gh` local tenga acceso.

## Trigger

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch: {}
permissions:
  contents: write   # crear el release y subir assets
```

Flujo: `git tag v0.1.0 && git push origin v0.1.0` (por SSH) → el workflow compila los
3 OS y publica el Release `v0.1.0`. El disparo manual sirve para probar sin taggear
(en ese caso `tauri-action` usa la versión de `tauri.conf.json` como tag).

## Pasos por runner (job de la matriz)

1. `actions/checkout@v4`.
2. **Bun**: `oven-sh/setup-bun@v2`.
3. **Rust**: `dtolnay/rust-toolchain@stable`. En macOS, agregar ambos targets:
   `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
4. **Cache de Rust** (`swatinem/rust-cache@v2`) con `workspaces: ./client/src-tauri`
   para no recompilar dependencias en cada release.
5. **Linux only** (`if: matrix.os == 'ubuntu-22.04'`): `apt-get install -y`
   `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
   `build-essential curl wget file libssl-dev libxdo-dev`.
6. `bun install` en `./client` (instala las deps del front para que corra
   `beforeBuildCommand: "bun run build"`).
7. **`tauri-apps/tauri-action@v0`** con:
   - `projectPath: ./client`
   - `tagName: ${{ github.ref_name }}` (cuando viene de un tag) — `releaseName: "Bridges ${{ github.ref_name }}"`
   - `args: ${{ matrix.args }}` (solo macOS lleva `--target universal-apple-darwin`)
   - `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
   La action corre `bun run build` → `tauri build`, crea el Release (idempotente:
   el primer job lo crea, los demás suben al mismo) y sube los instaladores.

La matriz define `os` y `args` por plataforma; el resto de los pasos son condicionales
por `matrix.os`.

## Sin firma — cómo se documenta

No se configuran secrets de firma. Para dejar el pipeline listo para sumar firma más
adelante sin rehacerlo, se deja un comentario en el workflow indicando dónde irían los
secrets (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, etc. para macOS;
`WINDOWS_CERTIFICATE` para Windows).

### README — sección "Descargas / Instalación"
Se agrega al `README.md` una sección con:
- Link a la página de **Releases** del repo (privada: requiere login con acceso al repo).
- Tabla por OS con el instalador correspondiente.
- Pasos para abrir sin firma:
  - **macOS**: primera vez, click derecho → *Abrir* (o `xattr -cr /Applications/Bridges.app`
    si Gatekeeper lo marca como dañado).
  - **Windows**: en el aviso de SmartScreen, *Más info → Ejecutar de todos modos*.
  - **Linux**: `.AppImage` → `chmod +x` y ejecutar; o instalar el `.deb`.

## Versión

El nombre del Release sale del tag. La versión de la app vive en `tauri.conf.json`
(`version: 0.1.0`) y en `Cargo.toml`; el bump es manual al taggear. Se anota en el
README el recordatorio de alinear `tauri.conf.json` con el tag antes de publicar.

## Verificación

No es ejecutable localmente (corre en GitHub). Validación:
- **Local:** lint del YAML con `actionlint` si está disponible; si no, validar que el
  archivo parsea como YAML.
- **End-to-end (lo corre el usuario):** `git push origin v0.1.0` → pestaña **Actions**
  en verde → pestaña **Releases** muestra los assets descargables:
  `.dmg`, `.msi`, `.exe` (setup NSIS), `.AppImage`, `.deb`.
- Smoke test: descargar el `.dmg` y el `.AppImage`, abrir la app, confirmar que arranca
  y conecta a `forge.pepo.ar`.

## Fuera de alcance (YAGNI)

- **Auto-updater** (ítem aparte; el plan deja la puerta abierta pero no lo implementa).
- **Firma/notarización** (decisión explícita de shippear sin firmar por ahora).
- `.rpm` u otros formatos Linux más allá de AppImage + deb.
- Builds de Windows/Linux ARM (solo x64).
