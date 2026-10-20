/**
 * `form` de la API: con qué formulario del sistema se llenó la solicitud
 * (`meta.system` de la definición congelada, ver lib/forms/system/). Quien
 * consume las respuestas elige con esto el contrato de claves y valores para
 * leerlas; una solicitud en curso conserva el de su formulario aunque el
 * sistema ya vaya por otra versión.
 *
 * `null` si el formulario no es del sistema.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import { systemFormMetaSchema } from "../forms/definition.ts";

export type PublicFormIdentity = { key: string; version: number };

export function publicFormIdentity(system: unknown): PublicFormIdentity | null {
  const parsed = systemFormMetaSchema.safeParse(system);
  return parsed.success ? { key: parsed.data.key, version: parsed.data.version } : null;
}

/**
 * Columna para el `select` de PostgREST que trae solo `meta.system` de la
 * definición congelada, sin el resto del jsonb (que es grande).
 */
export const FORM_SYSTEM_COLUMN = "form_system:form_definition->meta->system";
