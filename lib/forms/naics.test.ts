import { test } from "node:test";
import assert from "node:assert/strict";
import { NAICS_2022 } from "./naics-2022.ts";
import { formatNaics, isNaicsCode, naicsTitle, searchNaics } from "./naics.ts";

test("el catálogo trae los 1.012 códigos de 6 dígitos, sin repetidos y traducidos", () => {
  assert.equal(NAICS_2022.length, 1012);
  assert.equal(new Set(NAICS_2022.map((e) => e[0])).size, 1012);
  for (const [code, en, es] of NAICS_2022) {
    assert.match(code, /^\d{6}$/);
    assert.ok(en && es, code);
  }
});

test("isNaicsCode: existe en NAICS 2022", () => {
  assert.equal(isNaicsCode("541511"), true);
  assert.equal(isNaicsCode("541510"), false);
  assert.equal(isNaicsCode(541511), false);
});

test("título y respuesta legible por idioma", () => {
  assert.equal(naicsTitle("522110", "en"), "Commercial Banking");
  assert.equal(naicsTitle("522110", "es"), "Banca comercial");
  assert.equal(formatNaics("522110", "es"), "522110 · Banca comercial");
  assert.equal(formatNaics("000000", "es"), "000000");
});

test("búsqueda por prefijo de código", () => {
  const codes = searchNaics("5415").map((e) => e[0]);
  assert.ok(codes.length > 0);
  assert.ok(codes.every((c) => c.startsWith("5415")));
  assert.ok(codes.includes("541511"));
});

test("búsqueda por palabras, sin tildes y en los dos idiomas", () => {
  assert.ok(searchNaics("programacion medida").some((e) => e[0] === "541511"));
  assert.ok(searchNaics("custom programming").some((e) => e[0] === "541511"));
  assert.deepEqual(searchNaics("   "), []);
});
