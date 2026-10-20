import { test } from "node:test";
import assert from "node:assert/strict";
import { FrozenDefinitionError, parseFrozenDefinition } from "./frozen.ts";

const valid = {
  version: 1,
  title: { es: "KYB", en: "KYB" },
  sections: [
    { id: "s1", title: "Empresa", fields: [{ id: "f1", key: "legal_name", type: "short_text", label: "Razón social" }] },
  ],
};

test("sin copia congelada devuelve null (la solicitud usa el formulario vivo)", () => {
  assert.equal(parseFrozenDefinition(null), null);
  assert.equal(parseFrozenDefinition(undefined), null);
});

test("una copia válida se devuelve parseada, con los defaults de Zod", () => {
  const def = parseFrozenDefinition(valid);
  assert.equal(def?.sections[0].fields[0].key, "legal_name");
  assert.equal(def?.defaultLocale, "es");
  assert.equal(def?.sections[0].fields[0].required, false);
});

test("una copia que existe y no pasa el schema falla, sin caer a otro formulario", () => {
  const broken = {
    ...valid,
    sections: [{ ...valid.sections[0], fields: [{ ...valid.sections[0].fields[0], type: "desconocido" }] }],
  };
  assert.throws(() => parseFrozenDefinition(broken), (e: unknown) => {
    assert.ok(e instanceof FrozenDefinitionError);
    assert.match(e.issues[0], /sections\.0\.fields\.0\.type/);
    return true;
  });
});

test("una copia que no es un objeto también falla", () => {
  assert.throws(() => parseFrozenDefinition("v1"), FrozenDefinitionError);
});
