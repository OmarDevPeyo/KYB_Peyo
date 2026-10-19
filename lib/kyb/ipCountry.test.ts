import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, FieldType, FormDefinition } from "../forms/definition.ts";
import { declaredCountries, ipCountryMismatch, normalizeIpCountry } from "./ipCountry.ts";

/** Se ejecuta con `npm test` (node --test --experimental-strip-types). */

const field = (key: string, type: FieldType, extra: Partial<Field> = {}): Field => ({
  id: key,
  key,
  type,
  label: key,
  required: false,
  ...extra,
});

const form = (fields: Field[]): FormDefinition => ({
  version: 1,
  title: "Form",
  locales: ["es"],
  defaultLocale: "es",
  sections: [{ id: "s1", title: "s1", fields }],
});

test("normalizeIpCountry acepta solo un alpha-2 del catálogo", () => {
  assert.equal(normalizeIpCountry("BO"), "BO");
  assert.equal(normalizeIpCountry(" bo "), "BO");
  // Códigos que no son un país, o que no tienen la forma de un alpha-2.
  assert.equal(normalizeIpCountry("XX"), null);
  assert.equal(normalizeIpCountry("BOL"), null);
  assert.equal(normalizeIpCountry(""), null);
  assert.equal(normalizeIpCountry(null), null);
  assert.equal(normalizeIpCountry(undefined), null);
});

test("declaredCountries pasa las respuestas país a alpha-2, sin repetir", () => {
  const def = form([
    field("incorporation_country", "country"),
    field("registered_address.country", "country"),
    field("issuing_country", "country"),
    field("city", "short_text"),
  ]);
  const declared = declaredCountries(def, {
    incorporation_country: "BOL",
    "registered_address.country": "BOL",
    issuing_country: "ARG",
    city: "PE", // no es una pregunta país: no cuenta aunque parezca un código
  });
  assert.deepEqual(declared.sort(), ["AR", "BO"]);
});

test("declaredCountries ignora respuestas de preguntas que el solicitante no vio", () => {
  const def = form([
    field("has_branch", "boolean"),
    field("branch_country", "country", {
      visibleIf: { field: "has_branch", op: "eq", value: true },
    }),
  ]);
  // Llenó el país de la sucursal y después dijo que no tiene: quedó en la base
  // pero no es algo que haya declarado.
  assert.deepEqual(declaredCountries(def, { has_branch: false, branch_country: "PER" }), []);
  assert.deepEqual(declaredCountries(def, { has_branch: true, branch_country: "PER" }), ["PE"]);
});

test("declaredCountries descarta valores que no son un alpha-3 conocido", () => {
  const def = form([field("country", "country")]);
  assert.deepEqual(declaredCountries(def, { country: "ZZZ" }), []);
  assert.deepEqual(declaredCountries(def, { country: 42 }), []);
  assert.deepEqual(declaredCountries(def, {}), []);
});

test("ipCountryMismatch avisa solo cuando hay con qué comparar y no coincide", () => {
  assert.equal(ipCountryMismatch("BO", ["AR", "PE"]), true);
  assert.equal(ipCountryMismatch("BO", ["AR", "BO"]), false);
  // Sin países declarados, o sin país de IP, no hay nada que comparar.
  assert.equal(ipCountryMismatch("BO", []), false);
  assert.equal(ipCountryMismatch(null, ["AR"]), false);
});
