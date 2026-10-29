"""Tests del plugin de Hermes generado (lo corre setup.test.ts con el python de Hermes).

Env: PLUGIN_FILE (el __init__.py generado, con CMD apuntando a un hook falso que imprime
`CTX:<source>:<basename del cwd>`), HOME y HERMES_HOME (temporales; HOME tiene code/<repos>).
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("bridges_memoria", os.environ["PLUGIN_FILE"])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
HOME = Path(os.environ["HOME"])


def transform(sid, tool, args, result="ok"):
    return plugin._on_transform_tool_result(tool_name=tool, args=args, result=result, session_id=sid)


def pre(sid, msg, history=None, parent=""):
    return plugin._on_pre_llm_call(session_id=sid, user_message=msg, conversation_history=history or [],
                                   parent_session_id=parent)


def events(session):
    p = plugin._log_path()
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()] if p.exists() else []
    return [r for r in rows if r.get("session") == session]


class T(unittest.TestCase):
    def test_tool_dentro_de_repo_inyecta_una_vez_por_sesion(self):
        r = transform("s1", "read_file", {"path": str(HOME / "code/gym-admin/src/a.ts")})
        self.assertEqual(r, "ok\n\n[Bridges · memoria del proyecto]\nCTX:startup:gym-admin")
        self.assertIsNone(transform("s1", "patch", {"path": str(HOME / "code/gym-admin/b.ts")}))
        self.assertIn("CTX:startup:gym-admin", transform("s2", "terminal", {"workdir": str(HOME / "code/gym-admin")}))

    def test_cd_en_el_comando(self):
        r = transform("s3", "terminal", {"command": "cd ~/code/pxsol/pxsol-blanco && git status"})
        self.assertIn("CTX:startup:pxsol-blanco", r)

    def test_fuera_de_repos_o_tools_de_bridges_no_toca(self):
        self.assertIsNone(transform("s4", "read_file", {"path": str(HOME / "code/sin-bridges/x.md")}))
        self.assertIsNone(transform("s4", "read_file", {"path": "/etc/hosts"}))
        self.assertIsNone(transform("s4", "mcp__bridges__save_decision", {"cwd": str(HOME / "code/gym-admin")}))
        self.assertIsNone(transform("s4", "read_file", {"path": str(HOME / "code/gym-admin/a")}, result={"no": "str"}))

    def test_mensaje_que_nombra_un_repo(self):
        r = pre("s5", "dale, sigamos con Gym Admin")
        self.assertEqual(r, {"context": "CTX:startup:gym-admin"})
        self.assertIsNone(pre("s5", "y en gym-admin qué más?"))  # ya inyectado en esta sesión
        self.assertIsNone(pre("s5b", "hola, qué tal"))
        self.assertIn("CTX:startup:pxsol-blanco", pre("s6", "mirá ~/code/pxsol/pxsol-blanco/README.md")["context"])

    def test_nombres_de_una_palabra_necesitan_contexto(self):
        self.assertIsNone(pre("a1", "guardalo en Bridges, la memoria"))  # nombre del vault: nunca
        self.assertIsNone(pre("a2", "forge ahead with the plan"))
        self.assertIsNone(pre("a3", "goblin mode activado"))
        self.assertIsNone(pre("a4", "se aflojó el bulón de la rueda"))
        self.assertEqual(pre("a5", "sigamos con el repo forge"), {"context": "CTX:startup:forge"})
        self.assertEqual(pre("a6", "mirá `goblin`"), {"context": "CTX:startup:goblin"})
        self.assertEqual(pre("a7", "en el proyecto Bulón, los turnos"), {"context": "CTX:startup:bulon"})
        # Caso real (telemetría del 29/10): "proyecto" habla de goblin, no del bulón.
        self.assertEqual(pre("a8", "se aflojó el bulón de la rueda del auto, y quiero retomar el proyecto goblin"),
                         {"context": "CTX:startup:goblin"})

    def test_resultado_json_sigue_siendo_json(self):
        r = transform("s13", "patch", {"path": str(HOME / "code/goblin/a")}, result='{"success": true, "diff": "x"}')
        self.assertEqual(json.loads(r), {"success": True, "diff": "x", "bridges_memoria": "CTX:startup:goblin"})
        # JSON que no es objeto: no se toca y el proyecto queda pendiente para la próxima tool
        self.assertIsNone(transform("s14", "search_files", {"path": str(HOME / "code/goblin")}, result="[1, 2]"))
        self.assertIn("CTX:startup:goblin", transform("s14", "read_file", {"path": str(HOME / "code/goblin/a")}))

    def test_compactacion_reinyecta_con_pedido_de_bitacora_una_sola_vez(self):
        transform("s7", "read_file", {"path": str(HOME / "code/gym-admin/a")})
        hist = [{"role": "user", "content": "[CONTEXT COMPACTION — REFERENCE ONLY] resumen..."},
                {"role": "assistant", "content": "ok"}]
        self.assertEqual(pre("s7", "sigamos", hist), {"context": "CTX:compact:gym-admin"})
        self.assertIsNone(pre("s7", "sigamos", hist + [{"role": "user", "content": "x"}]))

    def test_compactacion_en_sesion_rotada_usa_el_resumen(self):
        hist = [{"role": "user", "content": [{"type": "text", "text":
                 "[CONTEXT COMPACTION] trabajábamos en ~/code/pxsol/pxsol-blanco"}]}]
        self.assertEqual(pre("s8", "seguí", hist), {"context": "CTX:compact:pxsol-blanco"})

    def test_compactacion_vieja_de_una_sesion_retomada_no_cuenta(self):
        hist = [{"role": "user", "content": "[CONTEXT COMPACTION] en ~/code/gym-admin"}]
        hist += [{"role": "user", "content": f"m{i}"} for i in range(20)]
        self.assertIsNone(pre("s9", "hola", hist))

    def test_subagentes_se_saltean(self):
        self.assertIsNone(pre("child", "en gym-admin", parent="padre"))
        self.assertIsNone(transform("child", "read_file", {"path": str(HOME / "code/gym-admin/a")}))

    def test_comando_roto_no_inyecta_ni_rompe_y_queda_registrado(self):
        old = plugin.CMD
        plugin.CMD = ["/no/existe/bridges"]
        try:
            self.assertIsNone(transform("s10", "read_file", {"path": str(HOME / "code/goblin/a")}))
        finally:
            plugin.CMD = old
        ev = events("s10")
        self.assertEqual([e["event"] for e in ev], ["error"])
        self.assertEqual(ev[0]["error"], "FileNotFoundError")

    def test_telemetria_inject_y_used(self):
        pre("t1", "vamos con gym-admin")
        transform("t1", "read_file", {"path": str(HOME / "code/gym-admin/x")})
        transform("t1", "read_file", {"path": str(HOME / "code/gym-admin/y")})
        ev = events("t1")
        self.assertEqual([e["event"] for e in ev], ["inject", "used"])  # "used" una sola vez
        self.assertEqual(ev[0]["trigger"], "message")
        self.assertEqual(ev[0]["match"], "name:gym-admin")
        self.assertEqual(ev[0]["project"], "Gym-Admin|")
        self.assertGreater(ev[0]["chars"], 0)
        self.assertNotIn("vamos", json.dumps(ev))  # no guarda el texto del mensaje
        transform("t2", "terminal", {"workdir": str(HOME / "code/goblin")})
        self.assertEqual(events("t2")[0]["trigger"], "tool:terminal")

    def test_apagado_por_env(self):
        os.environ["BRIDGES_MEMORIA_OFF"] = "1"
        try:
            self.assertIsNone(pre("off", "vamos con gym-admin"))
            self.assertIsNone(transform("off", "read_file", {"path": str(HOME / "code/gym-admin/x")}))
        finally:
            del os.environ["BRIDGES_MEMORIA_OFF"]
        self.assertEqual(events("off"), [])

    def test_reporte_con_umbrales(self):
        old = os.environ.get("HERMES_HOME")
        with tempfile.TemporaryDirectory() as d:
            os.environ["HERMES_HOME"] = d
            try:
                now = time.time()
                rows = [{"ts": now, "event": "inject", "session": f"r{i}", "project": "Goblin|", "trigger": "message",
                         "match": "name:goblin", "ms": 30 + i, "chars": 400} for i in range(5)]
                rows += [{"ts": now, "event": "inject", "session": "r0", "project": "Px|x", "trigger": "tool:patch",
                          "match": "path", "ms": 3000, "chars": 400},
                         {"ts": now, "event": "used", "session": "r0", "project": "Goblin|"},
                         {"ts": now, "event": "error", "session": "r9", "error": "timeout"},
                         {"ts": now - 40 * 86400, "event": "inject", "session": "viejo", "project": "X|",
                          "trigger": "message", "ms": 1, "chars": 1}]
                p = plugin._log_path()
                p.parent.mkdir(parents=True)
                p.write_text("\n".join(json.dumps(r) for r in rows) + "\nbasura\n", encoding="utf-8")
                out = plugin.report(14)
                self.assertIn("Inyecciones: 6 en 5 sesiones", out)
                self.assertIn("Errores: 1 (timeout)", out)
                self.assertIn("Latencia p95: 3000 ms", out)
                self.assertIn("Ruido (inyectado por mensaje y nunca usado en la sesión): 80% de 5", out)
                self.assertIn("name:goblin x4", out)
                self.assertIn("ruido 80% > 30%", out)
                self.assertIn("latencia p95 3000 ms > 2000", out)
                # sin datos: alerta de que no anda
                p.write_text("", encoding="utf-8")
                self.assertIn("0 inyecciones", plugin.report(14))
            finally:
                if old is None:
                    del os.environ["HERMES_HOME"]
                else:
                    os.environ["HERMES_HOME"] = old

    def test_register(self):
        hooks = {}

        class Ctx:
            def register_hook(self, name, fn):
                hooks[name] = fn

        plugin.register(Ctx())
        self.assertEqual(sorted(hooks), ["pre_llm_call", "transform_tool_result"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
