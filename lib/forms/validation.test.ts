import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field } from "./definition.ts";
import { buildZod, choiceProblem, isCountryCode, toggleChoice } from "./validation.ts";

const choice = (type: Field["type"], required = true, exclusive?: string): Field => ({
  id: type,
  key: type,
  type,
  label: type,
  required,
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    ...(exclusive ? [{ value: exclusive, label: "Ninguna", exclusive: true }] : []),
  ],
});
const country: Field = { id: "c", key: "country", type: "country", label: "País", required: true };
const number = (validation: Field["validation"]): Field => ({
  id: "n",
  key: "n",
  type: "number",
  label: "n",
  required: true,
  validation,
});

const ok = (f: Field, value: unknown) => buildZod([f]).safeParse({ [f.key]: value }).success;

test("single_choice y dropdown solo aceptan valores de sus opciones", () => {
  for (const type of ["single_choice", "dropdown"] as const) {
    assert.equal(ok(choice(type), "a"), true);
    assert.equal(ok(choice(type), "zzz"), false);
    assert.equal(choiceProblem(choice(type), "zzz"), "invalid_option");
  }
});

test("una elección opcional vacía sigue pasando", () => {
  assert.equal(ok(choice("dropdown", false), ""), true);
  assert.equal(ok(choice("dropdown", false), undefined), true);
  assert.equal(ok(choice("multiple_choice", false), []), true);
});

test("multiple_choice: cada valor de las opciones y sin repetidos", () => {
  const f = choice("multiple_choice");
  assert.equal(ok(f, ["a", "b"]), true);
  assert.equal(ok(f, ["a", "zzz"]), false);
  assert.equal(ok(f, ["a", "a"]), false);
});

test("la opción excluyente va sola", () => {
  const f = choice("multiple_choice", true, "none");
  assert.equal(ok(f, ["none"]), true);
  assert.equal(choiceProblem(f, ["none", "a"]), "exclusive");
  assert.equal(ok(f, ["none", "a"]), false);
});

test("país: solo un alpha-3 del selector", () => {
  assert.equal(ok(country, "BOL"), true);
  assert.equal(ok(country, "BO"), false);
  assert.equal(ok(country, "Bolivia"), false);
  assert.equal(isCountryCode("USA"), true);
  assert.equal(isCountryCode("XXX"), false);
});

test("una pregunta de elección sin opciones no se controla", () => {
  const f: Field = { id: "x", key: "x", type: "dropdown", label: "x", required: true };
  assert.equal(choiceProblem(f, "lo que sea"), null);
});

test("number con integer rechaza decimales", () => {
  assert.equal(ok(number({ integer: true, min: 1 }), "12"), true);
  assert.equal(ok(number({ integer: true, min: 1 }), "1.5"), false);
  assert.equal(ok(number({ min: 1 }), "1.5"), true);
});

test("toggleChoice: marcar la excluyente deja solo esa, y marcar otra la quita", () => {
  const f = choice("multiple_choice", true, "none");
  assert.deepEqual(toggleChoice(f, ["a", "b"], "none", true), ["none"]);
  assert.deepEqual(toggleChoice(f, ["none"], "a", true), ["a"]);
  assert.deepEqual(toggleChoice(f, ["a"], "b", true), ["a", "b"]);
  assert.deepEqual(toggleChoice(f, ["a", "b"], "a", false), ["b"]);
});
