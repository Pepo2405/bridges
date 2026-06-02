# Skill: bridges-docs

Claude Code skill que le enseña a documentar repositorios en el **vault de Bridges** de
forma estructurada (una carpeta por repo bajo `01 - Proyectos/`, wikilinks, índice).

Fuente de verdad versionada acá. `SKILL.md` tiene las instrucciones; `scripts/vault-path.sh`
resuelve dónde está el vault en disco (lee `lastVault` de la config de la app, o `$BRIDGES_VAULT`).

## Instalación (distribución actual: copia personal)

```bash
cp -R skills/bridges-docs ~/.claude/skills/bridges-docs
chmod +x ~/.claude/skills/bridges-docs/scripts/vault-path.sh
```

Queda disponible en **cualquier repo** donde abras Claude Code. Para usarla: pedí
"documentá este repo en Bridges" estando dentro del repo de código.

> ⚠️ **Esta distribución es temporal.** La copia manual no tiene updates centralizados:
> al cambiar la skill hay que recopiarla en cada máquina. Migrar a:
> - **Plugin + marketplace** (instalación/updates con `/plugin`), o
> - **Repo Bridges + script de symlink** (`ln -s` a `~/.claude/skills`, updates por `git pull`).
>
> La fuente ya vive en `skills/bridges-docs/`, lista para empaquetar como plugin.
