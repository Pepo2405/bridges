/**
 * CLI de administración de vaults.
 *   bun run src/vaults.ts add <slug> [nombre]
 *   bun run src/vaults.ts list
 * Crea el vault, su carpeta de disco y un token admin (se imprime una vez).
 * Usa la misma DB que el server (BRIDGES_DB).
 */
import { createVault, listVaults, getVault } from "./db";
import { addToken } from "./auth";
import { ensureVaultDir, isValidSlug } from "./vault";

function usage(): never {
  console.log(`Uso:
  bun run src/vaults.ts add <slug> [nombre]
  bun run src/vaults.ts list`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    const [slug, ...nameParts] = rest;
    if (!slug) usage();
    if (!isValidSlug(slug)) {
      console.error(`slug inválido: "${slug}" (usá ^[a-z0-9][a-z0-9-]{0,63}$)`);
      process.exit(1);
    }
    if (getVault(slug)) {
      console.error(`el vault "${slug}" ya existe.`);
      process.exit(1);
    }
    const name = nameParts.join(" ").trim() || slug;
    createVault(slug, name);
    ensureVaultDir(slug);
    const token = addToken(slug, "admin", "admin");
    console.log(`vault "${slug}" (${name}) creado.\n\ntoken admin:\n\n  ${token}\n\nGuardalo ahora — no se vuelve a mostrar.`);
    break;
  }
  case "list": {
    const vaults = listVaults();
    for (const v of vaults) console.log(`${v.slug}\t${v.name}\tseq=${v.last_seq}\t${v.created_at}`);
    break;
  }
  default:
    usage();
}
