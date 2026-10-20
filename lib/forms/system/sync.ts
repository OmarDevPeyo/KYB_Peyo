import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { refreshFormRequestsSummary } from "@/lib/kyb/service";
import {
  SYSTEM_FORMS,
  findSystemForm,
  planSystemFormSync,
  storedDefinition,
  type InstalledSystemForm,
} from "./index";

/**
 * Escritura de los formularios del sistema (la decisión está en ./index.ts).
 *
 * Corre desde la app desplegada —el cron /api/cron/sync-system-forms y la
 * acción de admin «Instalar»—, no desde `release.yml`: ahí correría antes del
 * deploy, con el código viejo, que no entiende los tipos nuevos (p. ej.
 * `naics`) y guardaría o validaría otra cosa.
 */

type Row = InstalledSystemForm & {
  id: string;
  org_id: string;
  system_key: string;
};

const COLUMNS = "id, org_id, system_key, system_version, version, status, definition";

/** Aplica el plan a una fila con compare-and-set sobre la revisión. */
async function applySync(row: Row): Promise<"updated" | "unchanged" | "conflict"> {
  const form = findSystemForm(row.system_key);
  if (!form) return "unchanged"; // clave que el código ya no conoce: no se toca
  const patch = planSystemFormSync(row, form);
  if (!patch) return "unchanged";

  const supabase = createServiceClient();
  let update = supabase
    .from("forms")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  update = row.version == null ? update.is("version", null) : update.eq("version", row.version);
  const { data, error } = await update.select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) return "conflict";

  // Como `saveForm`: si cambió qué pregunta da el título o el email, se
  // recalculan sus solicitudes. Un fallo no deshace la sincronización.
  const before = (row.definition as { internalFields?: unknown } | null)?.internalFields;
  if (JSON.stringify(before ?? null) !== JSON.stringify(patch.definition.internalFields ?? null)) {
    try {
      await refreshFormRequestsSummary(row.id, patch.definition);
    } catch (e) {
      console.error(`[system-forms] no se pudo recalcular el título form=${row.id}`, e);
    }
  }
  return "updated";
}

export interface SyncReport {
  updated: string[];
  unchanged: number;
  conflicts: string[];
}

/** Deja al día todas las instalaciones de los formularios del sistema. */
export async function syncSystemForms(): Promise<SyncReport> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("forms")
    .select(COLUMNS)
    .in(
      "system_key",
      SYSTEM_FORMS.map((f) => f.key),
    );
  if (error) throw new Error(error.message);

  const report: SyncReport = { updated: [], unchanged: 0, conflicts: [] };
  for (const row of (data ?? []) as Row[]) {
    const result = await applySync(row);
    if (result === "updated") report.updated.push(row.id);
    else if (result === "conflict") report.conflicts.push(row.id);
    else report.unchanged++;
  }
  return report;
}

/**
 * Instala un formulario del sistema en una organización, publicado. Si ya está
 * instalado, lo deja al día. Devuelve el id del formulario.
 */
export async function installSystemForm(
  key: string,
  orgId: string,
): Promise<{ id: string; created: boolean; updated: boolean }> {
  const form = findSystemForm(key);
  if (!form) throw new Error(`Formulario del sistema desconocido: ${key}`);
  const supabase = createServiceClient();

  const { data: existing, error: readError } = await supabase
    .from("forms")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("system_key", key)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (existing) {
    const result = await applySync(existing as Row);
    if (result === "conflict") {
      throw new Error("El formulario cambió mientras se sincronizaba. Reintentá.");
    }
    return { id: (existing as Row).id, created: false, updated: result === "updated" };
  }

  const { data, error } = await supabase
    .from("forms")
    .insert({
      org_id: orgId,
      name: form.name,
      status: "published",
      source: "manual",
      definition: storedDefinition(form),
      version: 1,
      system_key: form.key,
      system_version: form.version,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, created: true, updated: false };
}
