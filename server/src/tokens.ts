/**
 * CLI de administración de tokens.
 *   bun run src/tokens.ts add <nombre> <viewer|editor|admin>
 *   bun run src/tokens.ts list
 *   bun run src/tokens.ts revoke <nombre>
 * Usa la misma DB que el server (FORGE_DB), así que en Coolify se corre dentro
 * del contenedor apuntando al volumen.
 */
import { addToken, listTokens, revokeToken, ROLES, type Role } from "./auth";

function usage(): never {
  console.log(`Uso:
  bun run src/tokens.ts add <nombre> <${ROLES.join("|")}>
  bun run src/tokens.ts list
  bun run src/tokens.ts revoke <nombre>`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    const [name, role] = rest;
    if (!name || !role) usage();
    try {
      const token = addToken(name, role as Role);
      console.log(`token creado para "${name}" (${role}):\n\n  ${token}\n\nGuardalo ahora — no se vuelve a mostrar.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }
  case "list": {
    const tokens = listTokens();
    if (!tokens.length) {
      console.log("(sin tokens — la auth está desactivada salvo que exista FORGE_TOKEN)");
      break;
    }
    for (const t of tokens) console.log(`${t.name}\t${t.role}\t${t.created_at}`);
    break;
  }
  case "revoke": {
    const [name] = rest;
    if (!name) usage();
    console.log(revokeToken(name) ? `token "${name}" revocado.` : `no existe el token "${name}".`);
    break;
  }
  default:
    usage();
}
