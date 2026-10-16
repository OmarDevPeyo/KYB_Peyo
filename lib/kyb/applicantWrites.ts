/**
 * Qué puede escribir el solicitante con su link (`/f/<token>`).
 *
 * El link es un bearer: quien lo tiene, sin login, guarda el borrador, sube y
 * quita archivos y envía. Una vez enviada la solicitud, lo que llenó es
 * evidencia del expediente. La página ya muestra «recibido», pero los Server
 * Actions se pueden invocar a mano por POST, así que la regla vive acá y la
 * aplica cada action.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import type { KybStatus } from "./types.ts";

/**
 * Estados en que la solicitud espera al solicitante: todavía no envió, o se la
 * devolvieron para corregir. Fuera de estos (enviada, en revisión, decidida,
 * vencida) el link no escribe nada.
 */
export const PRE_SUBMIT_STATUSES: KybStatus[] = ["created", "in_progress", "changes_requested"];

export function acceptsApplicantWrites(status: KybStatus): boolean {
  return PRE_SUBMIT_STATUSES.includes(status);
}

/**
 * ¿Puede el solicitante quitar este archivo?
 *
 * Solo lo que subió después del último envío. Lo anterior ya formó parte de un
 * envío: en una ronda de correcciones se conserva aunque la respuesta se vuelva
 * a pedir (el formulario ni siquiera lo muestra, así que borrarlo solo pasa
 * invocando el action a mano).
 *
 * - `submittedAt`: último envío de la solicitud, o null si nunca envió.
 * - `uploadedAt`: cuándo se registró el archivo, o null si no tiene fila (una
 *   subida por signed URL que nunca se confirmó, que no es evidencia de nada).
 */
export function canApplicantDeleteDocument(input: {
  submittedAt: string | null;
  uploadedAt: string | null;
}): boolean {
  if (!input.submittedAt || !input.uploadedAt) return true;
  return new Date(input.uploadedAt).getTime() > new Date(input.submittedAt).getTime();
}
