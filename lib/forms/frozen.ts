/**
 * Lectura del formulario CONGELADO de una solicitud (`kyb_requests.form_definition`).
 *
 * La copia congelada es lo que el solicitante llenó y contra lo que se valida y
 * se verifica. Si existe pero no pasa el schema, caer al formulario vivo o al
 * publicado por defecto validaría y verificaría contra preguntas distintas, sin
 * que nadie se entere. Por eso falla: el error se ve y se corrige el código.
 *
 * Solo una solicitud SIN copia (anteriores a 0007 y las creadas por API antes de
 * que la congelaran) se resuelve contra el formulario vivo.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import { formDefinitionSchema, type FormDefinition } from "./definition.ts";

export class FrozenDefinitionError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `El formulario congelado de la solicitud no se puede leer (${issues.slice(0, 3).join("; ")}).`,
    );
    this.name = "FrozenDefinitionError";
    this.issues = issues;
  }
}

/**
 * La definición congelada, o `null` si la solicitud no tiene copia. Lanza
 * {@link FrozenDefinitionError} si la copia existe y no pasa el schema.
 */
export function parseFrozenDefinition(snapshot: unknown): FormDefinition | null {
  if (snapshot == null) return null;
  const parsed = formDefinitionSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data;
  throw new FrozenDefinitionError(
    parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`),
  );
}
