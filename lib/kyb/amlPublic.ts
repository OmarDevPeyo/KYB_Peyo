/**
 * Saneado de `aml_checks.result` antes de que salga de la app.
 *
 * Esa columna guarda la respuesta CRUDA del proveedor más algunos campos
 * nuestros. Uno de ellos, `search_token`, es el único secreto que autentica el
 * callback sin firma de DIDIT (app/api/webhooks/didit/kyb-search): publicarlo
 * le permitía al propio cliente leer el token de su solicitud y falsificar el
 * resultado registral que el analista estaba por aprobar.
 *
 * Este módulo es el ÚNICO camino por el que `result` sale hacia afuera —la ruta
 * pública y el webhook saliente lo comparten a propósito—. Antes cada uno
 * serializaba por su cuenta, y por eso la fuga pasó desapercibida en los dos.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */

/**
 * Claves que nunca salen de la app. Se filtran a CUALQUIER profundidad: el blob
 * del proveedor cambia de forma sin avisar, así que un campo nuestro que acabe
 * anidado ahí dentro tiene que seguir sin publicarse.
 *
 * Añadir algo a `result` que no deba ver el cliente significa añadirlo también
 * a esta lista.
 */
export const INTERNAL_RESULT_KEYS: readonly string[] = ["search_token"];

/** Tope de recursión: `result` es JSON de una BD (acíclico), esto es un cinturón. */
const MAX_DEPTH = 20;

function stripInternal(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => stripInternal(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_RESULT_KEYS.includes(key)) continue;
    out[key] = stripInternal(v, depth + 1);
  }
  return out;
}

/** Fila de `aml_checks` tal como la proyectan los dos llamadores. */
export type AmlCheckRow = {
  provider?: unknown;
  /** Control de DIDIT (`aml_screening`, `id_verification`, `kyb_registry`…). */
  feature?: unknown;
  /** Pregunta del formulario de la que es el control. */
  field_key?: unknown;
  status?: unknown;
  result?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

/**
 * Copia las filas dejando `result` sin claves internas. Conserva el resto del
 * objeto tal cual: el contrato público no cambia, solo deja de llevar secretos.
 */
export function publicAmlChecks<T extends AmlCheckRow>(
  rows: T[] | null | undefined,
): T[] {
  return (rows ?? []).map((row) => ({ ...row, result: stripInternal(row.result) }));
}
