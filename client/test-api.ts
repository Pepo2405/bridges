// Test de integración del cliente API contra un server real en :4321.
import { BridgesApi } from "./src/lib/api";

const api = new BridgesApi("http://localhost:4321");
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const h = await api.health();
check("health ok", h.ok === true);

const sync0 = await api.sync(0);
check("sync since 0 trae docs", sync0.documents.length >= 3);
check("sync devuelve last_seq", typeof sync0.last_seq === "number");

const path = `test/integ-${sync0.last_seq}.md`;
const created = await api.create({ path, content: "# Integ\n\nhola", author: "test" });
check("create devuelve doc", "ok" in created && created.doc.path === path);
const id = "ok" in created ? created.doc.id : "";

const upd = await api.update(id, { path, content: "# Integ v2", base_version: 1, author: "test" });
check("update ok con base_version correcto", "ok" in upd && upd.doc.version === 2);

const stale = await api.update(id, { path, content: "x", base_version: 1, author: "test" });
check("update con base_version viejo -> conflict", "conflict" in stale);
check("conflict trae server.version=2", "conflict" in stale && stale.server.version === 2);

const dupe = await api.create({ path, content: "x" });
check("create con path existente -> conflict", "conflict" in dupe);

const hits = await api.search("Integ");
check("search encuentra el doc", hits.some((x) => x.id === id));

const incremental = await api.sync(upd && "ok" in upd ? upd.doc.seq - 1 : 0);
check("sync incremental trae solo lo nuevo", incremental.documents.length >= 1);

const del = await api.remove(id, "test");
check("delete marca deleted=1", del.deleted === 1);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
