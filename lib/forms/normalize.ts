// Invariantes de la configuración interna de un formulario (roles internos y
// control de vencimiento). Puro: lo corren el builder tras cada cambio y el
// servidor al guardar, importar y duplicar.
import type { FormDefinition } from "./definition.ts";
import { normalizeExpiry } from "./expiry.ts";
import { normalizeInternalFields } from "./internalFields.ts";

export function normalizeFormDefinition(def: FormDefinition): FormDefinition {
  return normalizeExpiry(normalizeInternalFields(def));
}
