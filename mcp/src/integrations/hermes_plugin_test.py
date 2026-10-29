"""Tests del plugin de Hermes generado (lo corre setup.test.ts con el python de Hermes).

Env: PLUGIN_FILE (el __init__.py generado, con CMD apuntando a un hook falso que imprime
`CTX:<source>:<basename del cwd>`), HOME (home temporal con code/<repos>).
"""
import importlib.util
import json
import os
import sys
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

    def test_nombre_del_vault_no_dispara(self):
        self.assertIsNone(pre("s11", "guardalo en Bridges, la memoria del proyecto"))
        self.assertEqual(pre("s12", "sigamos con forge"), {"context": "CTX:startup:forge"})

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

    def test_comando_roto_no_inyecta_ni_rompe(self):
        old = plugin.CMD
        plugin.CMD = ["/no/existe/bridges"]
        try:
            self.assertIsNone(transform("s10", "read_file", {"path": str(HOME / "code/goblin/a")}))
        finally:
            plugin.CMD = old

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
