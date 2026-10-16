/**
 * Revisión de un formulario al guardarlo (`forms.version`, ver 0018).
 *
 * El cliente de la API fija su mapeo de campos contra `form_revision`, y cada
 * solicitud congela la definición con la que se creó. Si un formulario
 * PUBLICADO se editaba en su lugar sin subir la revisión, dos solicitudes con
 * la misma revisión podían haber visto preguntas distintas. Por eso guardar un
 * cambio sobre uno publicado abre una revisión nueva. En un borrador no: ahí
 * la revisión sube al publicar.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */

/**
 * Igualdad profunda de dos valores JSON, sin importar el orden de las claves.
 *
 * Hace falta porque la definición guardada vuelve de Postgres como `jsonb`,
 * que reordena las claves: comparar con `JSON.stringify` daba distinto aunque
 * nada hubiera cambiado. Una clave con `undefined` cuenta como ausente, igual
 * que al serializar.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  const defined = (o: object) =>
    Object.entries(o).filter(([, v]) => v !== undefined) as [string, unknown][];
  const ea = defined(a);
  const eb = new Map(defined(b));
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && sameJson(v, eb.get(k)));
}

/**
 * Revisión que corresponde después de guardar, o `null` si no cambia: el
 * formulario no está publicado, o la definición quedó igual (renombrar no es
 * una revisión).
 */
export function revisionAfterSave(input: {
  status: string;
  version: number | null;
  before: unknown;
  after: unknown;
}): number | null {
  if (input.status !== "published") return null;
  if (sameJson(input.before, input.after)) return null;
  return (input.version ?? 0) + 1;
}
