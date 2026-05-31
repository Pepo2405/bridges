/**
 * CLI de administración de tokens, scopeada por vault.
 *   bun run src/tokens.ts add <vault> <nombre> <viewer|editor|admin>
 *   bun run src/tokens.ts list <vault>
 *   bun run src/tokens.ts revoke <vault> <nombre>
 * Usa la misma DB que el server (FORGE_DB), así que en Coolify se corre dentro
 * del contenedor apuntando al volumen.
 */
import { addToken, listTokens, revokeToken, ROLES, type Role } from "./auth";
import { getVault } from "./db";

function usage(): never {
  console.log(`Uso:
  bun run src/tokens.ts add <vault> <nombre> <${ROLES.join("|")}>
  bun run src/tokens.ts list <vault>
  bun run src/tokens.ts revoke <vault> <nombre>`);
  process.exit(1);
}

function requireVault(vault: string | undefined): string {
  if (!vault) usage();
  if (!getVault(vault)) {
    console.error(`no existe el vault "${vault}". Crealo con: bun run src/vaults.ts add ${vault}`);
    process.exit(1);
  }
  return vault;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    const [vaultArg, name, role] = rest;
    const vault = requireVault(vaultArg);
    if (!name || !role) usage();
    try {
      const token = addToken(vault, name, role as Role);
      console.log(`token creado para "${name}" (${role}) en vault "${vault}":\n\n  ${token}\n\nGuardalo ahora — no se vuelve a mostrar.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }
  case "list": {
    const vault = requireVault(rest[0]);
    const tokens = listTokens(vault);
    if (!tokens.length) {
      console.log(`(sin tokens en "${vault}")`);
      break;
    }
    for (const t of tokens) console.log(`${t.name}\t${t.role}\t${t.created_at}`);
    break;
  }
  case "revoke": {
    const [vaultArg, name] = rest;
    const vault = requireVault(vaultArg);
    if (!name) usage();
    console.log(revokeToken(vault, name) ? `token "${name}" revocado en "${vault}".` : `no existe el token "${name}" en "${vault}".`);
    break;
  }
  default:
    usage();
}
