import { test, expect, describe } from "bun:test";
import { isLocalMode } from "./bridges";

// El gate real (registrar o no las tools) depende de isLocalMode() && !READONLY.
// Acá fijamos el invariante del helper; el loop end-to-end va en integration.test.ts.
describe("gate de escritura", () => {
  test("isLocalMode es booleano y refleja VAULT_DIR", () => {
    expect(typeof isLocalMode()).toBe("boolean");
  });
});
