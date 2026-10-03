import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, FieldType, FormDefinition, Section } from "./definition.ts";
import {
  internalRoleFor,
  internalRoleOf,
  mayBeSkipped,
  normalizeInternalFields,
  publicDefinition,
  resolveRequestSummary,
  setInternalRole,
  SUBJECT_TITLE_MAX,
} from "./internalFields.ts";

const field = (id: string, type: FieldType, extra: Partial<Field> = {}): Field => ({
  id,
  key: `k_${id}`,
  type,
  label: id,
  required: false,
  ...extra,
});

const section = (id: string, fields: Field[], extra: Partial<Section> = {}): Section => ({
  id,
  title: id,
  fields,
  ...extra,
});

function form(sections: Section[], internalFields?: FormDefinition["internalFields"]): FormDefinition {
  return {
    version: 1,
    title: "Form",
    locales: ["es"],
    defaultLocale: "es",
    sections,
    ...(internalFields ? { internalFields } : {}),
  };
}

const base = () =>
  form([
    section("s1", [
      field("name", "short_text"),
      field("mail", "email"),
      field("notes", "long_text"),
    ]),
  ]);

test("setInternalRole marca la pregunta y la vuelve obligatoria", () => {
  const def = setInternalRole(base(), "title", "name");
  assert.deepEqual(def.internalFields, { title: "name" });
  assert.equal(def.sections[0].fields[0].required, true);
  assert.equal(internalRoleOf(def.internalFields, "name"), "title");
  assert.equal(internalRoleOf(def.internalFields, "mail"), null);
  assert.equal(internalRoleFor("short_text"), "title");
  assert.equal(internalRoleFor("email"), "contactEmail");
  assert.equal(internalRoleFor("long_text"), null);
});

test("setInternalRole con null quita el rol y deja la configuración vacía", () => {
  const def = setInternalRole(setInternalRole(base(), "title", "name"), "title", null);
  assert.equal(def.internalFields, undefined);
});

test("normalize descarta ids borrados y tipos incompatibles", () => {
  const def = base();
  def.internalFields = { title: "notes", contactEmail: "gone" };
  normalizeInternalFields(def);
  assert.equal(def.internalFields, undefined);
});

test("normalize vuelve a exigir 'Obligatoria' si alguien la desmarca", () => {
  const def = setInternalRole(base(), "contactEmail", "mail");
  def.sections[0].fields[1].required = false;
  normalizeInternalFields(def);
  assert.equal(def.sections[0].fields[1].required, true);
});

test("cambiar el tipo de la pregunta marcada le quita el rol", () => {
  const def = setInternalRole(base(), "title", "name");
  def.sections[0].fields[0].type = "number";
  normalizeInternalFields(def);
  assert.equal(def.internalFields, undefined);
});

test("mayBeSkipped: visibleIf en la pregunta o en la sección", () => {
  const f = field("a", "short_text", { visibleIf: { field: "x", op: "answered" } });
  const def = form([section("s1", [f]), section("s2", [field("b", "short_text")], { visibleIf: { field: "x", op: "answered" } })]);
  assert.equal(mayBeSkipped(def.sections, 0, f), true);
  assert.equal(mayBeSkipped(def.sections, 1, def.sections[1].fields[0]), true);
});

test("mayBeSkipped: un salto anterior que pasa por encima de la sección", () => {
  const target = field("t", "short_text");
  const def = form([
    section("s1", [field("q", "single_choice")], {
      next: [{ when: { field: "k_q", op: "eq", value: "x" }, goTo: "s3" }],
    }),
    section("s2", [target]),
    section("s3", [field("z", "short_text")]),
  ]);
  assert.equal(mayBeSkipped(def.sections, 1, target), true);
  // La sección destino del salto no se saltea por ese salto.
  assert.equal(mayBeSkipped(def.sections, 2, def.sections[2].fields[0]), false);
  assert.equal(mayBeSkipped(base().sections, 0, base().sections[0].fields[0]), false);
});

test("resolveRequestSummary toma las respuestas marcadas, recortadas", () => {
  const def = setInternalRole(setInternalRole(base(), "title", "name"), "contactEmail", "mail");
  const summary = resolveRequestSummary(def, { k_name: "  Pythas   Holdings ", k_mail: " ops@pythas.com " });
  assert.deepEqual(summary, { subjectTitle: "Pythas Holdings", contactEmail: "ops@pythas.com" });
});

test("resolveRequestSummary: sin marca, vacío, email inválido o título largo", () => {
  assert.deepEqual(resolveRequestSummary(base(), { k_name: "X" }), {
    subjectTitle: null,
    contactEmail: null,
  });
  const def = setInternalRole(setInternalRole(base(), "title", "name"), "contactEmail", "mail");
  assert.deepEqual(resolveRequestSummary(def, { k_name: "   ", k_mail: "no-es-email" }), {
    subjectTitle: null,
    contactEmail: null,
  });
  const long = resolveRequestSummary(def, { k_name: "a".repeat(500) });
  assert.equal(long.subjectTitle?.length, SUBJECT_TITLE_MAX);
});

test("resolveRequestSummary ignora preguntas de secciones no recorridas", () => {
  const def = form(
    [
      section("s1", [field("q", "single_choice")], {
        next: [{ when: { field: "k_q", op: "eq", value: "skip" }, goTo: "SUBMIT" }],
      }),
      section("s2", [field("name", "short_text")]),
    ],
    { title: "name" },
  );
  assert.equal(resolveRequestSummary(def, { k_q: "skip", k_name: "Viejo" }).subjectTitle, null);
  assert.equal(resolveRequestSummary(def, { k_q: "go", k_name: "Nuevo" }).subjectTitle, "Nuevo");
});

test("resolveRequestSummary usa la marca del formulario vivo sobre la copia vieja", () => {
  const snapshot = base(); // copia sin marca, de antes de configurar
  const live = setInternalRole(base(), "title", "name");
  assert.equal(
    resolveRequestSummary(snapshot, { k_name: "ACME" }, live).subjectTitle,
    "ACME",
  );
  // Si la pregunta marcada hoy no existe en la copia, vale la marca de la copia.
  const liveOther = form([section("s1", [field("new", "short_text")])], { title: "new" });
  const marked = setInternalRole(base(), "title", "name");
  assert.equal(resolveRequestSummary(marked, { k_name: "ACME" }, liveOther).subjectTitle, "ACME");
});

test("publicDefinition no deja la configuración interna", () => {
  const def = setInternalRole(base(), "title", "name");
  const pub = publicDefinition(def);
  assert.equal("internalFields" in pub, false);
  assert.equal(JSON.stringify(pub).includes("internalFields"), false);
  // No muta el original (el builder y el servidor lo siguen usando).
  assert.deepEqual(def.internalFields, { title: "name" });
});

test("publicDefinition quita la marca de vencimiento de las preguntas", () => {
  const def = form([
    section("s1", [
      field("doc", "file", { expiry: { source: "date_field", dateFieldId: "due" } }),
      field("due", "date"),
    ]),
  ]);
  const pub = publicDefinition(def);
  assert.equal(JSON.stringify(pub).includes("expiry"), false);
  assert.deepEqual(def.sections[0].fields[0].expiry, { source: "date_field", dateFieldId: "due" });
});
