# Skill: forge-docs

Claude Code skill que le enseña a documentar repositorios en el **vault de Forge** de
forma estructurada (una carpeta por repo bajo `01 - Proyectos/`, wikilinks, índice).

Fuente de verdad versionada acá. `SKILL.md` tiene las instrucciones; `scripts/vault-path.sh`
resuelve dónde está el vault en disco (lee `lastVault` de la config de la app, o `$FORGE_VAULT`).

## Instalación (distribución actual: copia personal)

```bash
cp -R skills/forge-docs ~/.claude/skills/forge-docs
chmod +x ~/.claude/skills/forge-docs/scripts/vault-path.sh
```

Queda disponible en **cualquier repo** donde abras Claude Code. Para usarla: pedí
"documentá este repo en Forge" estando dentro del repo de código.

> ⚠️ **Esta distribución es temporal.** La copia manual no tiene updates centralizados:
> al cambiar la skill hay que recopiarla en cada máquina. Migrar a:
> - **Plugin + marketplace** (instalación/updates con `/plugin`), o
> - **Repo Forge + script de symlink** (`ln -s` a `~/.claude/skills`, updates por `git pull`).
>
> La fuente ya vive en `skills/forge-docs/`, lista para empaquetar como plugin.
