// Preguntas de uso interno (título de la solicitud y email de contacto).
// Módulo puro y con extensiones explícitas: lo prueba `node --test` y lo usan
// tanto el builder (cliente) como el servidor.
import {
  INTERNAL_FIELD_TYPES,
  INTERNAL_ROLES,
  SUBMIT,
  type Field,
  type FieldType,
  type FormDefinition,
  type InternalFields,
  type InternalRole,
  type Section,
} from "./definition.ts";
import { reachableFields, type Answers } from "./logic.ts";

/** Largo máximo del título guardado en `kyb_requests.subject_title`. */
export const SUBJECT_TITLE_MAX = 200;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

function findField(def: FormDefinition, id: string): Field | null {
  for (const s of def.sections) {
    for (const f of s.fields) if (f.id === id) return f;
  }
  return null;
}

/** ¿Puede la pregunta cumplir el rol? (existe en `def` y tiene un tipo compatible) */
function fitsRole(def: FormDefinition, role: InternalRole, id: string | undefined): Field | null {
  if (!id) return null;
  const field = findField(def, id);
  return field && INTERNAL_FIELD_TYPES[role].includes(field.type) ? field : null;
}

/**
 * Impone los invariantes de los roles internos, en el sitio:
 * - descarta los que apuntan a una pregunta borrada o de un tipo incompatible;
 * - una pregunta con rol es obligatoria siempre.
 *
 * El builder la corre tras cada cambio y el servidor al guardar, importar y
 * duplicar, así que borrar la pregunta, cambiarle el tipo o desmarcar
 * "Obligatoria" no deja la configuración en un estado inválido.
 */
export function normalizeInternalFields(def: FormDefinition): FormDefinition {
  const cfg = def.internalFields;
  if (!cfg) return def;
  const next: InternalFields = {};
  for (const role of INTERNAL_ROLES) {
    const field = fitsRole(def, role, cfg[role]);
    if (!field) continue;
    field.required = true;
    next[role] = field.id;
  }
  if (Object.keys(next).length > 0) def.internalFields = next;
  else delete def.internalFields;
  return def;
}

/** Asigna (o quita, con `null`) el rol a una pregunta. Un rol tiene una sola pregunta. */
export function setInternalRole(
  def: FormDefinition,
  role: InternalRole,
  fieldId: string | null,
): FormDefinition {
  const cfg: InternalFields = { ...(def.internalFields ?? {}) };
  if (fieldId) cfg[role] = fieldId;
  else delete cfg[role];
  def.internalFields = cfg;
  return normalizeInternalFields(def);
}

/** Rol interno de una pregunta, si lo tiene. */
export function internalRoleOf(
  cfg: InternalFields | undefined,
  fieldId: string,
): InternalRole | null {
  for (const role of INTERNAL_ROLES) {
    if (cfg?.[role] === fieldId) return role;
  }
  return null;
}

/** Rol que PUEDE tener una pregunta según su tipo (texto corto → título, email → contacto). */
export function internalRoleFor(type: FieldType): InternalRole | null {
  return INTERNAL_ROLES.find((r) => INTERNAL_FIELD_TYPES[r].includes(type)) ?? null;
}

/**
 * ¿La pregunta puede quedar sin responder aunque sea obligatoria? Pasa si ella
 * o su sección tienen `visibleIf`, o si una sección anterior puede saltar más
 * allá de la suya (o directo al envío). Es una heurística para el AVISO del
 * builder, no una regla: marcar una pregunta condicional está permitido.
 */
export function mayBeSkipped(sections: Section[], sectionIndex: number, field: Field): boolean {
  const section = sections[sectionIndex];
  if (!section) return false;
  if (field.visibleIf || section.visibleIf) return true;
  const indexOf = new Map(sections.map((s, i) => [s.id, i] as const));
  return sections.slice(0, sectionIndex).some((s) => {
    const targets = [...(s.next ?? []).map((r) => r.goTo), s.defaultGoTo];
    return targets.some(
      (t) => t === SUBMIT || (t != null && (indexOf.get(t) ?? -1) > sectionIndex),
    );
  });
}

export interface RequestSummary {
  subjectTitle: string | null;
  contactEmail: string | null;
}

/**
 * Título y email de contacto de una solicitud a partir de sus respuestas.
 *
 * `requestDef` es la definición contra la que se respondió (la copia congelada
 * o, sin ella, el formulario vivo). La configuración se toma primero de
 * `liveDef` (el formulario tal como está hoy) siempre que esa pregunta exista
 * en `requestDef`: la copia conserva los ids, así que marcar una pregunta hoy
 * vale también para las solicitudes anteriores. Si no, se usa la de la copia.
 *
 * Solo cuentan respuestas de preguntas que la persona recorrió.
 */
export function resolveRequestSummary(
  requestDef: FormDefinition,
  answers: Answers,
  liveDef?: FormDefinition | null,
): RequestSummary {
  const reached = new Set(reachableFields(requestDef, answers).map((f) => f.id));

  const answerOf = (role: InternalRole): string | null => {
    const field =
      fitsRole(requestDef, role, liveDef?.internalFields?.[role]) ??
      fitsRole(requestDef, role, requestDef.internalFields?.[role]);
    if (!field || !reached.has(field.id)) return null;
    const raw = answers[field.key];
    if (typeof raw !== "string") return null;
    const value = raw.trim().replace(/\s+/g, " ");
    return value || null;
  };

  const title = answerOf("title");
  const email = answerOf("contactEmail");
  return {
    subjectTitle: title ? title.slice(0, SUBJECT_TITLE_MAX) : null,
    contactEmail: email && email.length <= EMAIL_MAX && EMAIL_RE.test(email) ? email : null,
  };
}

/**
 * La definición que viaja al navegador del solicitante: sin la configuración
 * interna (roles y control de vencimiento). La pregunta marcada se ve como
 * cualquier otra obligatoria.
 */
export function publicDefinition(def: FormDefinition): FormDefinition {
  const hasExpiry = def.sections.some((s) => s.fields.some((f) => f.expiry));
  if (!def.internalFields && !hasExpiry) return def;
  const copy = { ...def };
  delete copy.internalFields;
  if (hasExpiry) {
    copy.sections = def.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        if (!f.expiry) return f;
        const rest = { ...f };
        delete rest.expiry;
        return rest;
      }),
    }));
  }
  return copy;
}
