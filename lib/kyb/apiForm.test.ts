import { test } from "node:test";
import assert from "node:assert/strict";
import { publicFormIdentity } from "./apiForm.ts";

test("publicFormIdentity: clave y versión del formulario del sistema", () => {
  assert.deepEqual(publicFormIdentity({ key: "globalflow-kyb-empresas", version: 2 }), {
    key: "globalflow-kyb-empresas",
    version: 2,
  });
});

test("publicFormIdentity: null si no es del sistema o no se entiende", () => {
  assert.equal(publicFormIdentity(null), null);
  assert.equal(publicFormIdentity(undefined), null);
  assert.equal(publicFormIdentity({ key: "x" }), null);
  assert.equal(publicFormIdentity("globalflow"), null);
});
