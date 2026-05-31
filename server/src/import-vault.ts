// Importa todos los .md de un vault de Obsidian al server Forge vía la API.
// Uso: bun run src/import-vault.ts "/ruta/al/vault" [http://localhost:4321] [--token <tok>]
// El vault destino sale del token (--token o env FORGE_TOKEN).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const tokIdx = args.indexOf("--token");
const TOKEN = (tokIdx >= 0 ? args.splice(tokIdx, 2)[1] : undefined) ?? process.env.FORGE_TOKEN ?? null;

const SRC = args[0];
const SERVER = (args[1] ?? "http://localhost:4321").replace(/\/$/, "");
if (!SRC) {
  console.error('Falta la ruta del vault. Ej: bun run src/import-vault.ts "/Users/pepo/Documents/PxSol-Vault"');
  process.exit(1);
}

const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const SKIP_DIRS = new Set([".obsidian", ".git", "node_modules", ".trash"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (entry.toLowerCase().endsWith(".md")) acc.push(full);
  }
  return acc;
}

const files = walk(SRC).sort();
console.log(`${files.length} archivos .md en ${SRC}\n`);

let created = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  const path = relative(SRC, file).split("\\").join("/");
  const content = readFileSync(file, "utf8");
  try {
    const r = await fetch(`${SERVER}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ path, content, author: "pxsol-import" }),
    });
    if (r.status === 201) {
      created++;
      console.log(`  + ${path}`);
    } else if (r.status === 409) {
      skipped++;
      console.log(`  = ${path} (ya existe)`);
    } else {
      failed++;
      console.log(`  ! ${path} -> HTTP ${r.status}: ${await r.text()}`);
    }
  } catch (e) {
    failed++;
    console.log(`  ! ${path} -> ${e}`);
  }
}

console.log(`\n${created} creados, ${skipped} ya existían, ${failed} fallaron`);
