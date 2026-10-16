import { test } from "node:test";
import assert from "node:assert/strict";
import { revisionAfterSave, sameJson } from "./revision.ts";

const def = {
  version: 1,
  title: { es: "KYB", en: "KYB" },
  sections: [{ id: "s1", fields: [{ key: "legal_name", type: "short_text", required: true }] }],
};

test("sameJson no depende del orden de las claves (jsonb las reordena)", () => {
  const reordered = {
    sections: [{ fields: [{ required: true, type: "short_text", key: "legal_name" }], id: "s1" }],
    title: { en: "KYB", es: "KYB" },
    version: 1,
  };
  assert.equal(sameJson(def, reordered), true);
});

test("sameJson trata una clave undefined como ausente", () => {
  assert.equal(sameJson({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(sameJson({ a: 1, b: null }, { a: 1 }), false);
});

test("sameJson ve un cambio en un arreglo, también de orden", () => {
  assert.equal(sameJson([1, 2], [2, 1]), false);
  assert.equal(sameJson([1, 2], [1, 2, 3]), false);
  assert.equal(sameJson({ a: [] }, { a: {} }), false);
});

test("guardar un cambio sobre uno publicado abre una revisión", () => {
  const after = structuredClone(def);
  after.sections[0].fields[0].required = false;
  assert.equal(revisionAfterSave({ status: "published", version: 4, before: def, after }), 5);
});

test("sin revisión previa, la primera es 1", () => {
  const after = { ...def, title: { es: "KYB empresas", en: "KYB" } };
  assert.equal(revisionAfterSave({ status: "published", version: null, before: def, after }), 1);
});

test("guardar igual (o solo renombrar) no abre revisión", () => {
  assert.equal(
    revisionAfterSave({ status: "published", version: 4, before: def, after: structuredClone(def) }),
    null,
  );
});

test("en borrador o archivado no se toca la revisión", () => {
  const after = { ...def, sections: [] };
  assert.equal(revisionAfterSave({ status: "draft", version: 4, before: def, after }), null);
  assert.equal(revisionAfterSave({ status: "archived", version: 4, before: def, after }), null);
});
