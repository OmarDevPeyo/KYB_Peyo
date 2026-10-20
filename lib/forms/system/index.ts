/**
 * Formularios del sistema: definidos en el código e instalados por la app en
 * una organización (ver 0035 y ./sync.ts). Este módulo decide QUÉ escribir; la
 * escritura vive en ./sync.ts.
 *
 * Extensiones explícitas y sin alias `@/`: se prueba con `node --test`.
 */
import { formDefinitionSchema, type FormDefinition } from "../definition.ts";
import { normalizeFormDefinition } from "../normalize.ts";
import { sameJson } from "../revision.ts";
import {
  GLOBALFLOW_KYB_FORM,
  GLOBALFLOW_KYB_KEY,
  GLOBALFLOW_KYB_VERSION,
} from "./globalflow-kyb.ts";

export interface SystemForm {
  key: string;
  /** Versión del contrato: sube cuando cambian claves, opciones o ramas. */
  version: number;
  /** Nombre interno con el que aparece en el panel. */
  name: string;
  definition: FormDefinition;
}

export const SYSTEM_FORMS: readonly SystemForm[] = [
  {
    key: GLOBALFLOW_KYB_KEY,
    version: GLOBALFLOW_KYB_VERSION,
    name: "GlobalFlow · KYB empresas",
    definition: GLOBALFLOW_KYB_FORM,
  },
];

export function findSystemForm(key: string): SystemForm | undefined {
  return SYSTEM_FORMS.find((f) => f.key === key);
}

/**
 * La definición tal como se guarda: pasada por el schema (defaults de Zod) y
 * normalizada, igual que la guarda `saveForm`. Así comparar contra la fila no
 * da diferencias por un default.
 */
export function storedDefinition(form: SystemForm): FormDefinition {
  return normalizeFormDefinition(formDefinitionSchema.parse(form.definition));
}

/** Fila instalada de un formulario del sistema (lo que lee la sincronización). */
export interface InstalledSystemForm {
  definition: unknown;
  /** Revisión (`forms.version`): la base del compare-and-set. */
  version: number | null;
  system_version: number | null;
  status: string;
}

export interface SystemFormPatch {
  definition: FormDefinition;
  system_version: number;
  /** Revisión nueva: cada cambio sobre uno publicado abre una (ver revision.ts). */
  version: number;
  status: "published";
}

/**
 * Qué escribir para dejar la fila al día con el código, o `null` si ya lo
 * está. Compara con `sameJson` (jsonb reordena las claves) contra la fila
 * pasada por el mismo parse + normalizado.
 */
export function planSystemFormSync(
  row: InstalledSystemForm,
  form: SystemForm,
): SystemFormPatch | null {
  const want = storedDefinition(form);
  const parsed = formDefinitionSchema.safeParse(row.definition);
  const have = parsed.success ? normalizeFormDefinition(parsed.data) : row.definition;
  if (
    sameJson(have, want) &&
    row.system_version === form.version &&
    row.status === "published"
  ) {
    return null;
  }
  return {
    definition: want,
    system_version: form.version,
    version: (row.version ?? 0) + 1,
    status: "published",
  };
}
