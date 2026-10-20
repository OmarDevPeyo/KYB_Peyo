import { test } from "node:test";
import assert from "node:assert/strict";
import { formDefinitionSchema, withoutSystemMeta } from "./definition.ts";

const base = {
  version: 1,
  title: "KYB",
  sections: [],
  meta: { system: { key: "globalflow-kyb-empresas", version: 1 }, i18n: { "title": { en: { source: "human" } } } },
};

test("meta.system se lee de la definición", () => {
  const def = formDefinitionSchema.parse(base);
  assert.deepEqual(def.meta?.system, { key: "globalflow-kyb-empresas", version: 1 });
});

test("meta.system exige clave y versión positiva", () => {
  assert.equal(formDefinitionSchema.safeParse({ ...base, meta: { system: { key: "", version: 1 } } }).success, false);
  assert.equal(formDefinitionSchema.safeParse({ ...base, meta: { system: { key: "k", version: 0 } } }).success, false);
});

test("withoutSystemMeta quita la marca y conserva el resto de meta", () => {
  const def = formDefinitionSchema.parse(base);
  const copy = withoutSystemMeta(def);
  assert.equal(copy.meta?.system, undefined);
  assert.deepEqual(copy.meta?.i18n, def.meta?.i18n);
  assert.deepEqual(def.meta?.system, { key: "globalflow-kyb-empresas", version: 1 }, "no muta el original");
});
