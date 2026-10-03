import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, FieldType, FormDefinition, Section } from "./definition.ts";
import {
  addDays,
  computeExpirations,
  expirationDiffers,
  expiryDateLinks,
  expirySignature,
  expiryStatus,
  expiryWarnings,
  normalizeExpiry,
  parseExpiryDate,
  proposedRenewalExpiry,
  renewalDefinition,
  renewalFieldKeys,
  resolveTrackedFields,
  type ExpiryCheck,
  type StoredExpiration,
} from "./expiry.ts";

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

const form = (sections: Section[]): FormDefinition => ({
  version: 1,
  title: "Form",
  locales: ["es"],
  defaultLocale: "es",
  sections,
});

const ID_REVIEW = { provider: "didit", feature: "id_verification" } as const;

/** Licencia con fecha declarada + carnet (anverso/reverso) con DIDIT. */
const base = () =>
  form([
    section("s1", [
      field("lic", "file", { expiry: { source: "date_field", dateFieldId: "lic_due" } }),
      field("lic_due", "date"),
      field("idf", "file", { label: "Carnet (anverso)", review: ID_REVIEW, expiry: { source: "didit" } }),
      field("idb", "file", { label: "Carnet (reverso)", review: ID_REVIEW }),
    ]),
  ]);

const file = (name: string) => [{ path: `req/${name}`, filename: name }];

const check = (id: string, fieldKey: string, date: unknown, created: string): ExpiryCheck => ({
  id,
  feature: "id_verification",
  field_key: fieldKey,
  status: "passed",
  result: { id_verification: { expiration_date: date } },
  created_at: created,
});

const stored = (over: Partial<StoredExpiration> & { field_id: string }): StoredExpiration => ({
  marker_source: "date_field",
  auto_expires_on: null,
  expires_on: null,
  override_expires_on: null,
  override_by: null,
  override_by_email: null,
  override_at: null,
  doc_path: null,
  check_id: null,
  expired_notified_at: null,
  ...over,
});

// ---------------- fechas ----------------

test("parseExpiryDate: ISO, con hora y día/mes/año", () => {
  assert.equal(parseExpiryDate("2027-05-01"), "2027-05-01");
  assert.equal(parseExpiryDate("2027-5-1"), "2027-05-01");
  assert.equal(parseExpiryDate("2027-05-01T00:00:00Z"), "2027-05-01");
  assert.equal(parseExpiryDate("2027/05/01"), "2027-05-01");
  assert.equal(parseExpiryDate("01/05/2027"), "2027-05-01");
  assert.equal(parseExpiryDate("1.5.2027"), "2027-05-01");
  assert.equal(parseExpiryDate(" 31-12-2030 "), "2030-12-31");
});

test("parseExpiryDate rechaza fechas imposibles y basura", () => {
  assert.equal(parseExpiryDate("2027-02-30"), null);
  assert.equal(parseExpiryDate("2027-13-01"), null);
  assert.equal(parseExpiryDate("1800-01-01"), null);
  assert.equal(parseExpiryDate("31/02/2027"), null);
  assert.equal(parseExpiryDate("mañana"), null);
  assert.equal(parseExpiryDate(""), null);
  assert.equal(parseExpiryDate(20270501), null);
  assert.equal(parseExpiryDate(null), null);
  assert.equal(parseExpiryDate("2028-02-29"), "2028-02-29");
});

test("expiryStatus: el día del vencimiento todavía es vigente", () => {
  const today = "2026-10-02";
  assert.equal(expiryStatus(null, today), "unknown");
  assert.equal(expiryStatus("2026-10-01", today), "expired");
  assert.equal(expiryStatus("2026-10-02", today), "expiring");
  assert.equal(expiryStatus(addDays(today, 30), today), "expiring");
  assert.equal(expiryStatus(addDays(today, 31), today), "valid");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

// ---------------- marca ----------------

test("normalizeExpiry exige la fecha enlazada y conserva las marcas válidas", () => {
  const def = normalizeExpiry(base());
  const [lic, due, idf] = def.sections[0].fields;
  assert.deepEqual(lic.expiry, { source: "date_field", dateFieldId: "lic_due" });
  assert.equal(due.required, true);
  assert.deepEqual(idf.expiry, { source: "didit" });
});

test("normalizeExpiry descarta marcas que dejaron de valer", () => {
  const def = base();
  const [lic, due, idf, idb] = def.sections[0].fields;
  due.type = "short_text"; // la fecha ya no es fecha
  delete idf.review; // sin DIDIT no hay de dónde leer la fecha
  idb.expiry = { source: "didit" }; // el reverso no tiene check propio
  normalizeExpiry(def);
  assert.equal(lic.expiry, undefined);
  assert.equal(idf.expiry, undefined);
  assert.equal(idb.expiry, undefined);

  const other = base();
  other.sections[0].fields[0].type = "short_text";
  normalizeExpiry(other);
  assert.equal(other.sections[0].fields[0].expiry, undefined);
});

test("expiryDateLinks y expiryWarnings", () => {
  const def = base();
  assert.equal(expiryDateLinks(def).get("lic_due")?.id, "lic");
  assert.equal(expiryWarnings(def).size, 0);

  def.sections[0].fields[1].visibleIf = { field: "k_idf", op: "answered" };
  assert.deepEqual(expiryWarnings(def).get("lic"), ["date_conditional"]);

  const split = form([
    section("s1", [field("lic", "file", { expiry: { source: "date_field", dateFieldId: "d" } })]),
    section("s2", [field("d", "date")]),
  ]);
  assert.deepEqual(expiryWarnings(split).get("lic"), ["date_other_section"]);
});

test("expirySignature cambia con la marca y con la etiqueta", () => {
  const a = base();
  const b = base();
  assert.equal(expirySignature(a), expirySignature(b));
  b.sections[0].fields[0].label = "Licencia";
  assert.notEqual(expirySignature(a), expirySignature(b));
  const c = base();
  delete c.sections[0].fields[2].expiry;
  assert.notEqual(expirySignature(a), expirySignature(c));
});

// ---------------- documentos controlados ----------------

test("resolveTrackedFields: manda el formulario vivo por id", () => {
  const snapshot = base();
  const live = base();
  delete live.sections[0].fields[0].expiry; // hoy la licencia no se controla
  live.sections[0].fields.push(field("new", "file", { expiry: { source: "didit" } }));

  const ids = resolveTrackedFields(snapshot, live).map((t) => t.field.id);
  assert.deepEqual(ids, ["idf"]);

  // Una pregunta borrada del vivo conserva la marca de la copia.
  const pruned = form([section("s1", [])]);
  assert.deepEqual(
    resolveTrackedFields(snapshot, pruned).map((t) => t.field.id),
    ["lic", "idf"],
  );

  // Una marca nueva en el vivo vale para solicitudes viejas sin marca.
  const old = base();
  delete old.sections[0].fields[0].expiry;
  assert.deepEqual(
    resolveTrackedFields(old, base()).map((t) => t.field.id),
    ["lic", "idf"],
  );
});

test("computeExpirations: fecha declarada y fecha de DIDIT (el check más nuevo que la tenga)", () => {
  const rows = computeExpirations({
    requestDef: base(),
    answers: { k_lic: file("lic.pdf"), k_lic_due: "2026-09-30", k_idf: file("idf.jpg") },
    checks: [
      check("c1", "k_idf", "2025-01-01", "2026-01-01T00:00:00Z"),
      check("c2", "k_idf", "ilegible", "2026-06-01T00:00:00Z"),
    ],
    existing: [],
    today: "2026-10-02",
  });
  assert.equal(rows.length, 2);
  const [lic, idf] = rows;
  assert.equal(lic.source, "declared");
  assert.equal(lic.expires_on, "2026-09-30");
  assert.equal(lic.doc_path, "req/lic.pdf");
  assert.equal(idf.source, "didit");
  assert.equal(idf.expires_on, "2025-01-01");
  assert.equal(idf.check_id, "c1");
});

test("computeExpirations omite documentos no subidos o no recorridos", () => {
  const def = base();
  def.sections[0].fields[0].visibleIf = { field: "k_idf", op: "answered" };
  const rows = computeExpirations({
    requestDef: def,
    answers: { k_lic: file("lic.pdf"), k_lic_due: "2026-09-30" },
    checks: [],
    existing: [],
    today: "2026-10-02",
  });
  assert.deepEqual(rows, []);
});

test("computeExpirations: la corrección vale mientras el documento sea el mismo", () => {
  const prev = stored({
    field_id: "lic",
    expires_on: "2027-01-01",
    override_expires_on: "2027-01-01",
    override_by: "u1",
    override_by_email: "a@x.com",
    override_at: "2026-10-01T00:00:00Z",
    doc_path: "req/lic.pdf",
  });
  const run = (doc: string) =>
    computeExpirations({
      requestDef: base(),
      answers: { k_lic: file(doc), k_lic_due: "2026-09-30" },
      checks: [],
      existing: [prev],
      today: "2026-10-02",
    })[0];

  const same = run("lic.pdf");
  assert.equal(same.source, "analyst");
  assert.equal(same.expires_on, "2027-01-01");
  assert.equal(same.auto_expires_on, "2026-09-30");
  assert.equal(same.override_by_email, "a@x.com");

  const renewed = run("lic-2.pdf");
  assert.equal(renewed.source, "declared");
  assert.equal(renewed.expires_on, "2026-09-30");
  assert.equal(renewed.override_expires_on, null);
});

test("computeExpirations rearma el aviso si cambia el documento o deja de estar vencido", () => {
  const prev = stored({
    field_id: "lic",
    expires_on: "2026-09-30",
    auto_expires_on: "2026-09-30",
    doc_path: "req/lic.pdf",
    expired_notified_at: "2026-10-01T03:00:00Z",
  });
  const run = (doc: string, due: string) =>
    computeExpirations({
      requestDef: base(),
      answers: { k_lic: file(doc), k_lic_due: due },
      checks: [],
      existing: [prev],
      today: "2026-10-02",
    })[0].expired_notified_at;

  assert.equal(run("lic.pdf", "2026-09-30"), "2026-10-01T03:00:00Z"); // sin cambios
  assert.equal(run("lic.pdf", "2026-09-15"), "2026-10-01T03:00:00Z"); // sigue vencido
  assert.equal(run("lic.pdf", "2027-09-30"), null); // ya no está vencido
  assert.equal(run("lic-2.pdf", "2026-09-30"), null); // documento nuevo
});

test("computeExpirations conserva la fecha de DIDIT si el webhook reescribió el check", () => {
  const prev = stored({
    field_id: "idf",
    marker_source: "didit",
    auto_expires_on: "2025-01-01",
    expires_on: "2025-01-01",
    doc_path: "req/idf.jpg",
    check_id: "c1",
  });
  const rows = computeExpirations({
    requestDef: base(),
    answers: { k_idf: file("idf.jpg") },
    checks: [{ ...check("c1", "k_idf", null, "2026-01-01T00:00:00Z"), result: { status: "Approved" } }],
    existing: [prev],
    today: "2026-10-02",
  });
  assert.equal(rows[0].expires_on, "2025-01-01");
  assert.equal(rows[0].check_id, "c1");
});

test("expirationDiffers ignora el orden de las claves del jsonb", () => {
  const [row] = computeExpirations({
    requestDef: base(),
    answers: { k_lic: file("lic.pdf"), k_lic_due: "2026-09-30" },
    checks: [],
    existing: [],
    today: "2026-10-02",
  });
  const fromDb: Record<string, unknown> = { ...row, id: "x", created_at: "t" };
  assert.equal(expirationDiffers(row, fromDb), false);
  assert.equal(expirationDiffers(row, { ...fromDb, expires_on: "2026-10-01" }), true);
  assert.equal(expirationDiffers(row, undefined), true);

  const labeled = { ...row, field_label: { es: "Licencia", en: "License" } };
  assert.equal(
    expirationDiffers(labeled, { ...fromDb, field_label: { en: "License", es: "Licencia" } }),
    false,
  );
});

// ---------------- renovación ----------------

test("renewalFieldKeys: archivo + fecha declarada, y anverso + reverso de DIDIT", () => {
  const answers = { k_lic: file("lic.pdf"), k_lic_due: "2026-09-30", k_idf: file("f.jpg"), k_idb: file("b.jpg") };
  const docs = renewalFieldKeys(base(), null, answers, ["lic", "idf", "lic", "idb", "nope"]);
  assert.deepEqual(docs, [
    { fieldId: "lic", fieldKey: "k_lic", marker: "date_field", keys: ["k_lic", "k_lic_due"] },
    { fieldId: "idf", fieldKey: "k_idf", marker: "didit", keys: ["k_idf", "k_idb"] },
  ]);
  // Sin reverso subido, solo el anverso.
  const front = renewalFieldKeys(base(), null, { k_idf: file("f.jpg") }, ["idf"]);
  assert.deepEqual(front[0].keys, ["k_idf"]);
});

test("renewalDefinition: una sección, obligatoria y sin condiciones ni marcas", () => {
  const def = base();
  def.sections[0].fields[1].visibleIf = { field: "k_lic", op: "answered" };
  def.internalFields = { title: "lic" };
  const out = renewalDefinition(def, ["k_lic_due", "k_lic"], "Renovar");
  assert.equal(out.sections.length, 1);
  assert.deepEqual(out.sections[0].fields.map((f) => f.key), ["k_lic", "k_lic_due"]);
  assert.ok(out.sections[0].fields.every((f) => f.required && !f.visibleIf && !f.expiry));
  assert.equal(out.internalFields, undefined);
  // No muta la definición original.
  assert.ok(def.sections[0].fields[0].expiry);
});

test("proposedRenewalExpiry: fecha declarada o leída por DIDIT del documento nuevo", () => {
  const lic = { fieldKey: "k_lic", marker: "date_field" as const, keys: ["k_lic", "k_lic_due"] };
  assert.equal(proposedRenewalExpiry(lic, { k_lic_due: "2028-01-31" }, null), "2028-01-31");
  assert.equal(proposedRenewalExpiry(lic, {}, null), null);

  const idf = { fieldKey: "k_idf", marker: "didit" as const, keys: ["k_idf"] };
  const checks = [
    { feature: "id_verification", fieldKey: "k_idf", status: "passed", result: { id_verification: { expiration_date: "2031-05-01" } } },
  ];
  assert.equal(proposedRenewalExpiry(idf, {}, checks), "2031-05-01");
  assert.equal(proposedRenewalExpiry(idf, {}, [{ ...checks[0], status: "error" }]), null);
  assert.equal(proposedRenewalExpiry(idf, {}, null), null);
});

test("computeExpirations: tras renovar, un check anterior al documento nuevo no cuenta", () => {
  const run = (uploaded: string | undefined) =>
    computeExpirations({
      requestDef: base(),
      answers: { k_idf: file("idf-2.jpg") },
      checks: [check("old", "k_idf", "2026-03-01", "2026-01-01T00:00:00Z")],
      existing: [],
      today: "2026-10-02",
      uploadedAt: uploaded ? new Map([["req/idf-2.jpg", uploaded]]) : undefined,
    })[0];
  assert.equal(run(undefined).expires_on, "2026-03-01");
  assert.equal(run("2026-10-01T00:00:00Z").expires_on, null);
  assert.equal(run("2025-12-31T00:00:00Z").expires_on, "2026-03-01");
});
