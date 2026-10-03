// Control de vencimiento de documentos (`field.expiry`).
// Módulo puro y con extensiones explícitas: lo prueba `node --test` y lo usan
// el builder (cliente), el servidor y la pantalla Vencimientos.
import type {
  Field,
  FieldExpiry,
  FormDefinition,
  LocalizedText,
} from "./definition.ts";
import { reachableFields, type Answers } from "./logic.ts";
import { firstFileRef, isBackSide } from "../didit/plan.ts";
import { nodeOf } from "../didit/summary.ts";

/** Ventana de "por vencer", en días. */
export const EXPIRY_SOON_DAYS = 30;

type Sections = Pick<FormDefinition, "sections">;

function fieldsOf(def: Sections): Field[] {
  return def.sections.flatMap((s) => s.fields);
}

function fieldById(def: Sections, id: string): Field | null {
  for (const s of def.sections) {
    for (const f of s.fields) if (f.id === id) return f;
  }
  return null;
}

// ------------------------------------------------------------
// Marca
// ------------------------------------------------------------

/**
 * ¿La fecha de este documento puede salir de DIDIT? Solo del anverso de una
 * pregunta etiquetada id_verification: el check se guarda con el key del
 * anverso (lib/didit/plan.ts).
 */
export function canUseDiditExpiry(field: Field): boolean {
  return (
    field.type === "file" &&
    field.review?.provider === "didit" &&
    field.review.feature === "id_verification" &&
    !isBackSide(field)
  );
}

/** ¿`marker` vale para `field` dentro de `def`? (la marca puede venir de otra definición) */
function markerFits(
  def: Sections,
  field: Field,
  marker: FieldExpiry | undefined,
): marker is FieldExpiry {
  if (!marker || field.type !== "file") return false;
  if (marker.source === "didit") return canUseDiditExpiry(field);
  const date = fieldById(def, marker.dateFieldId);
  return !!date && date.type === "date";
}

/** ¿La marca de la pregunta vale dentro de `def`? */
export function expiryMarkerOk(def: Sections, field: Field): boolean {
  return markerFits(def, field, field.expiry);
}

/**
 * Impone los invariantes de la marca, en el sitio:
 * - descarta la que ya no vale (la pregunta dejó de ser archivo, perdió la
 *   revisión DIDIT o se borró / cambió de tipo la pregunta de fecha);
 * - la pregunta de fecha enlazada es obligatoria siempre.
 *
 * Igual que `normalizeInternalFields`: el builder la corre tras cada cambio y
 * el servidor al guardar, importar y duplicar.
 */
export function normalizeExpiry<T extends Sections>(def: T): T {
  for (const f of fieldsOf(def)) {
    if (!f.expiry) continue;
    if (!expiryMarkerOk(def, f)) {
      delete f.expiry;
      continue;
    }
    if (f.expiry.source === "date_field") {
      const date = fieldById(def, f.expiry.dateFieldId);
      if (date) date.required = true;
    }
  }
  return def;
}

/** Pregunta de fecha → pregunta de archivo cuyo vencimiento da. */
export function expiryDateLinks(def: Sections): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const f of fieldsOf(def)) {
    if (f.expiry?.source === "date_field" && expiryMarkerOk(def, f)) {
      if (!out.has(f.expiry.dateFieldId)) out.set(f.expiry.dateFieldId, f);
    }
  }
  return out;
}

export type ExpiryWarning = "date_conditional" | "date_other_section";

/**
 * Avisos del builder por pregunta de archivo. Son heurísticas, no reglas: una
 * fecha condicional o en otra sección puede quedar sin responder aunque el
 * documento se suba, y entonces el vencimiento queda "sin fecha".
 */
export function expiryWarnings(def: Sections): Map<string, ExpiryWarning[]> {
  const out = new Map<string, ExpiryWarning[]>();
  def.sections.forEach((s, si) => {
    for (const f of s.fields) {
      if (f.expiry?.source !== "date_field" || !expiryMarkerOk(def, f)) continue;
      const dateId = f.expiry.dateFieldId;
      const dsi = def.sections.findIndex((x) => x.fields.some((g) => g.id === dateId));
      const date = fieldById(def, dateId);
      const codes: ExpiryWarning[] = [];
      if (date?.visibleIf) codes.push("date_conditional");
      if (dsi !== si) codes.push("date_other_section");
      if (codes.length) out.set(f.id, codes);
    }
  });
  return out;
}

/**
 * Huella de la configuración de vencimiento. Si cambia al guardar, se
 * recalculan las solicitudes del formulario (eso hace de backfill). Incluye key
 * y etiqueta porque se copian en `document_expirations`.
 */
export function expirySignature(def: Sections): string {
  return JSON.stringify(
    fieldsOf(def)
      .filter((f) => expiryMarkerOk(def, f))
      .map((f) => {
        const date =
          f.expiry?.source === "date_field" ? fieldById(def, f.expiry.dateFieldId) : null;
        return [f.id, f.key, f.label, f.expiry, date?.key ?? null];
      }),
  );
}

// ------------------------------------------------------------
// Fechas (todas como `YYYY-MM-DD`, en UTC)
// ------------------------------------------------------------

const YMD_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/;
const DMY_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Normaliza una fecha de vencimiento a `YYYY-MM-DD`, o `null` si no se puede
 * leer. DIDIT no garantiza el formato y la pregunta de fecha se guarda como
 * texto sin validar. Acepta ISO (con hora opcional) y día/mes/año; lo
 * ambiguo (`03/04/2027`) se lee como día/mes, el uso de la región.
 */
export function parseExpiryDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = YMD_RE.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = DMY_RE.exec(s))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Hoy en UTC, como `YYYY-MM-DD`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Días de `from` a `to` (negativo si `to` ya pasó). */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export type ExpiryStatus = "expired" | "expiring" | "valid" | "unknown";

/** Vence el día `expiresOn`: ese día todavía es vigente. */
export function expiryStatus(
  expiresOn: string | null | undefined,
  today: string,
  soonDays: number = EXPIRY_SOON_DAYS,
): ExpiryStatus {
  if (!expiresOn) return "unknown";
  if (expiresOn < today) return "expired";
  if (expiresOn <= addDays(today, soonDays)) return "expiring";
  return "valid";
}

// ------------------------------------------------------------
// Documentos controlados de una solicitud
// ------------------------------------------------------------

export interface TrackedField {
  field: Field;
  marker: FieldExpiry;
  dateField: Field | null;
}

/**
 * Preguntas de archivo de la solicitud cuyo vencimiento se controla.
 *
 * Manda la marca del formulario vivo para toda pregunta que siga existiendo en
 * él (por id): marcar hoy vale para las solicitudes viejas y DESMARCAR deja de
 * controlarlas. Si la pregunta ya no existe en el formulario vivo, se usa la
 * marca de la copia congelada. La marca tiene que valer contra `requestDef`
 * (la definición contra la que se respondió): de ahí salen keys y etiquetas.
 */
export function resolveTrackedFields(
  requestDef: FormDefinition,
  liveDef?: FormDefinition | null,
): TrackedField[] {
  const out: TrackedField[] = [];
  for (const field of fieldsOf(requestDef)) {
    if (field.type !== "file") continue;
    const live = liveDef ? fieldById(liveDef, field.id) : null;
    const marker = live ? live.expiry : field.expiry;
    if (!markerFits(requestDef, field, marker)) continue;
    out.push({
      field,
      marker,
      dateField:
        marker.source === "date_field" ? fieldById(requestDef, marker.dateFieldId) : null,
    });
  }
  return out;
}

/** Fila de aml_checks que hace falta para leer la fecha de DIDIT. */
export interface ExpiryCheck {
  id: string;
  feature: string | null;
  field_key: string | null;
  status: string;
  result: unknown;
  created_at: string;
}

/** Fila guardada en `document_expirations` (lo que el cálculo conserva). */
export interface StoredExpiration {
  field_id: string;
  marker_source: string;
  auto_expires_on: string | null;
  expires_on: string | null;
  override_expires_on: string | null;
  override_by: string | null;
  override_by_email: string | null;
  override_at: string | null;
  doc_path: string | null;
  check_id: string | null;
  expired_notified_at: string | null;
}

export interface ExpirationRow {
  field_id: string;
  field_key: string;
  field_label: LocalizedText;
  marker_source: FieldExpiry["source"];
  source: "didit" | "declared" | "analyst";
  auto_expires_on: string | null;
  expires_on: string | null;
  override_expires_on: string | null;
  override_by: string | null;
  override_by_email: string | null;
  override_at: string | null;
  doc_path: string;
  doc_filename: string;
  check_id: string | null;
  expired_notified_at: string | null;
}

/** Fecha de vencimiento que leyó DIDIT, del check más nuevo que la tenga. */
function diditExpiry(
  checks: ExpiryCheck[],
  fieldKey: string,
): { date: string; checkId: string } | null {
  const candidates = checks
    .filter(
      (c) => c.feature === "id_verification" && c.field_key === fieldKey && c.status !== "error",
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const c of candidates) {
    const date = parseExpiryDate(nodeOf("id_verification", c.result)?.expiration_date);
    if (date) return { date, checkId: c.id };
  }
  return null;
}

/**
 * Filas que `document_expirations` debe tener para una solicitud. Las filas
 * que no salgan acá se borran: un documento que la persona no recorrió o no
 * subió no tiene vencimiento.
 *
 * - La corrección del analista se mantiene mientras el documento sea el mismo.
 * - El aviso `document.expired` se rearma si cambia el documento o si la fecha
 *   deja de estar vencida.
 * - Si DIDIT reescribió el resultado (su webhook) y ya no se lee la fecha, se
 *   conserva la que se había leído de ese mismo check.
 */
export function computeExpirations(input: {
  requestDef: FormDefinition;
  liveDef?: FormDefinition | null;
  answers: Answers;
  checks: ExpiryCheck[];
  existing: StoredExpiration[];
  today: string;
}): ExpirationRow[] {
  const { requestDef, liveDef, answers, checks, existing, today } = input;
  const reached = new Set(reachableFields(requestDef, answers).map((f) => f.id));
  const prevById = new Map(existing.map((e) => [e.field_id, e] as const));

  const rows: ExpirationRow[] = [];
  for (const { field, marker, dateField } of resolveTrackedFields(requestDef, liveDef)) {
    if (!reached.has(field.id)) continue;
    const doc = firstFileRef(answers, field.key);
    if (!doc) continue;
    const prev = prevById.get(field.id);
    const sameDoc = prev?.doc_path === doc.path;

    let auto: string | null = null;
    let checkId: string | null = null;
    if (marker.source === "didit") {
      const read = diditExpiry(checks, field.key);
      if (read) {
        auto = read.date;
        checkId = read.checkId;
      } else if (
        prev &&
        sameDoc &&
        prev.marker_source === "didit" &&
        prev.auto_expires_on &&
        prev.check_id &&
        checks.some((c) => c.id === prev.check_id)
      ) {
        auto = prev.auto_expires_on;
        checkId = prev.check_id;
      }
    } else if (dateField && reached.has(dateField.id)) {
      auto = parseExpiryDate(answers[dateField.key]);
    }

    const keepOverride = !!prev?.override_expires_on && sameDoc;
    const override = keepOverride ? prev!.override_expires_on : null;
    const expiresOn = override ?? auto;

    let notified = prev?.expired_notified_at ?? null;
    if (
      prev &&
      (!sameDoc ||
        (expiresOn !== prev.expires_on && (expiresOn === null || expiresOn >= today)))
    ) {
      notified = null;
    }

    rows.push({
      field_id: field.id,
      field_key: field.key,
      field_label: field.label,
      marker_source: marker.source,
      source: override ? "analyst" : marker.source === "didit" ? "didit" : "declared",
      auto_expires_on: auto,
      expires_on: expiresOn,
      override_expires_on: override,
      override_by: keepOverride ? prev!.override_by : null,
      override_by_email: keepOverride ? prev!.override_by_email : null,
      override_at: keepOverride ? prev!.override_at : null,
      doc_path: doc.path,
      doc_filename: doc.filename,
      check_id: checkId,
      expired_notified_at: notified,
    });
  }
  return rows;
}

/** JSON con las claves ordenadas: jsonb no conserva el orden de las claves. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** ¿La fila guardada difiere de la calculada? (para escribir solo lo que cambió) */
export function expirationDiffers(
  desired: ExpirationRow,
  stored: Record<string, unknown> | undefined,
): boolean {
  if (!stored) return true;
  return (Object.keys(desired) as (keyof ExpirationRow)[]).some(
    (k) => stableJson(desired[k]) !== stableJson(stored[k]),
  );
}
