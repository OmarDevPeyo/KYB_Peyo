import "server-only";
import { createHmac } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { generateToken } from "@/lib/tokens";
import { open } from "@/lib/crypto/secretBox";
import { safeWebhookFetch } from "@/lib/net/ssrfGuard";
import { sendAlert } from "@/lib/mail/alert";
import { publicAmlChecks } from "@/lib/kyb/amlPublic";
import { FORM_SYSTEM_COLUMN, publicFormIdentity } from "@/lib/kyb/apiForm";
import { SUBMISSION_CONTEXT_COLUMNS, webhookSubmissionContext } from "@/lib/kyb/submissionContext";

export type WebhookEvent =
  | "request.submitted"
  | "verification.completed"
  | "decision.made"
  | "changes.requested"
  | "request.expiring"
  | "request.expired"
  | "document.expired"
  | "document.renewed";

export interface NotifyOptions {
  /** Datos propios del evento, que se suman al payload (p. ej. `document`). */
  data?: Record<string, unknown>;
  /**
   * `false` = solo encolar, sin intento inmediato. Para barridos que pueden
   * encolar muchos eventos en una corrida: el drenado por minuto los entrega.
   */
  inline?: boolean;
}

/**
 * Espera (en minutos) DESPUÉS de cada intento fallido. El índice es
 * `attempts - 1`. Tabla fija y no fórmula: es más fácil de razonar y de
 * documentarle al cliente (docs/integracion-api-kyb.md §6).
 *
 *   1 → 1 min · 2 → 5 min · 3 → 15 min · 4 → 30 min · 5 → 1 h
 *   6 → 2 h   · 7 → 4 h   · 8 → 8 h    · 9 → 8 h    (≈24 h acumuladas)
 */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 480];
const MAX_ATTEMPTS = 10;

/** Ventana durante la cual una fila tomada por el drenador no se vuelve a tomar. */
const LEASE_MINUTES = 2;

/** Tope de filas por corrida del cron: acota la corrida al `maxDuration`. */
export const DRAIN_BATCH_SIZE = 20;

const TIMEOUT_MS = 5_000;

interface DeliveryRow {
  id: string;
  request_id: string | null;
  endpoint_id: string;
  event: string;
  event_id: string;
  payload: unknown;
  attempts: number;
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * Encola un webhook hacia el endpoint REGISTRADO del cliente y hace un intento
 * inmediato. Solo dispara si la solicitud referencia un `webhook_endpoint_id`
 * habilitado. **Nunca lanza.**
 *
 * El intento inline mantiene la latencia del camino feliz (la fila queda
 * `delivered` sin pasar por el cron), pero es best-effort: corre dentro del
 * `maxDuration` de la ruta que lo llamó. La garantía de entrega la da la cola,
 * que el cron drena hasta 24 h (ver `drainDueDeliveries`).
 */
export async function notifyClient(
  requestId: string,
  event: WebhookEvent,
  opts: NotifyOptions = {},
): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { data: req } = await supabase
      .from("kyb_requests")
      .select(
        `id, external_ref, status, decision, decision_reason, corrections, webhook_endpoint_id, form_revision, subject_title, contact_email, ${SUBMISSION_CONTEXT_COLUMNS}, created_at, submitted_at, decided_at, token_expires_at, ${FORM_SYSTEM_COLUMN}`,
      )
      .eq("id", requestId)
      .maybeSingle();
    if (!req?.webhook_endpoint_id) return; // sin endpoint registrado → no-op

    const { data: aml } = await supabase
      .from("aml_checks")
      .select("provider, feature, field_key, status, result, created_at, updated_at")
      .eq("request_id", requestId)
      // Mismo `aml[]` que GET /:id: sin las reemplazadas por una corrección.
      .is("superseded_at", null)
      .order("created_at", { ascending: false });

    const eventId = `evt_${generateToken(12)}`;

    // El payload se CONGELA acá. No se re-lee al reintentar: un `decision.made`
    // entregado seis horas tarde debe describir la decisión como fue, no el
    // estado actual. Es lo que hace que el dedupe por `event_id` sea coherente.
    const payload = {
      event,
      event_id: eventId,
      sent_at: new Date().toISOString(),
      id: req.id,
      external_ref: req.external_ref,
      status: req.status,
      decision: req.decision,
      reason: req.decision_reason ?? null,
      corrections: req.corrections ?? null,
      form_revision: req.form_revision ?? null,
      // Formulario del sistema con el que se llenó (ver GET /:id).
      form: publicFormIdentity(req.form_system),
      // Preguntas marcadas como título y email de contacto (ver GET /:id).
      subject_title: req.subject_title ?? null,
      contact_email: req.contact_email ?? null,
      expires_at: req.token_expires_at ?? null,
      created_at: req.created_at,
      submitted_at: req.submitted_at,
      // Desde dónde se envió por última vez (ver GET /:id).
      submission_context: webhookSubmissionContext(req),
      decided_at: req.decided_at,
      ...(opts.data ?? {}),
      // Saneado igual que en la API pública: este payload viaja a una URL de
      // terceros, así que es el último sitio donde puede escaparse un secreto.
      aml: publicAmlChecks(aml),
    };

    const { data: row } = await supabase
      .from("webhook_deliveries")
      .insert({
        request_id: req.id,
        endpoint_id: req.webhook_endpoint_id,
        event,
        event_id: eventId,
        payload,
        status: "pending",
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
      })
      .select("id, request_id, endpoint_id, event, event_id, payload, attempts")
      .single();

    if (row && opts.inline !== false) await attemptDelivery(row as DeliveryRow);
  } catch (e) {
    console.error(`[webhook] request=${requestId} no se pudo encolar:`, e);
  }
}

/**
 * Un intento de entrega. Lo comparten el encolado y el drenador.
 *
 * **La firma se recalcula en cada intento**, nunca se reusa: cubre
 * `timestamp + "." + body` y el receptor rechaza timestamps de más de 5 minutos
 * (anti-replay). Una firma guardada al encolar sería rechazada —con razón— por
 * cualquier reintento posterior. Por eso la fila guarda solo el body.
 *
 * - `event_id` es **constante** entre intentos → el receptor deduplica.
 * - `delivery_id` **cambia** en cada intento → trazabilidad.
 *
 * Nunca lanza.
 */
export async function attemptDelivery(row: DeliveryRow): Promise<boolean> {
  const supabase = createServiceClient();
  const attempt = row.attempts + 1;

  const fail = async (error: string, httpStatus?: number) => {
    const exhausted = attempt >= MAX_ATTEMPTS;
    await supabase
      .from("webhook_deliveries")
      .update({
        attempts: attempt,
        status: exhausted ? "failed" : "pending",
        last_error: error.slice(0, 500),
        last_status: httpStatus ?? null,
        next_attempt_at: exhausted
          ? minutesFromNow(0)
          : minutesFromNow(BACKOFF_MINUTES[attempt - 1] ?? 480),
      })
      .eq("id", row.id);

    if (exhausted) {
      console.error(
        `[webhook] delivery=${row.id} event=${row.event} agotada tras ${attempt} intentos: ${error}`,
      );
      await audit(row.request_id, "webhook_failed", {
        event: row.event,
        eventId: row.event_id,
        deliveryId: row.id,
        attempts: attempt,
        error,
      });
      await alertExhausted(row, error, attempt);
    }
    return false;
  };

  const { data: ep } = await supabase
    .from("webhook_endpoints")
    .select("url, secret_encrypted, enabled")
    .eq("id", row.endpoint_id)
    .maybeSingle();

  if (!ep || !ep.enabled) {
    return fail("endpoint ausente o deshabilitado");
  }

  let secret: string;
  try {
    secret = open(ep.secret_encrypted as string);
  } catch {
    return fail("no se pudo descifrar el secreto del endpoint");
  }

  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const deliveryId = `dlv_${generateToken(12)}`;

  try {
    const res = await safeWebhookFetch(ep.url as string, {
      body,
      headers: {
        "content-type": "application/json",
        "x-kyb-event": row.event,
        "x-kyb-event-id": row.event_id,
        "x-kyb-delivery-id": deliveryId,
        "x-kyb-timestamp": timestamp,
        "x-kyb-signature": `v1=${signature}`,
      },
      timeoutMs: TIMEOUT_MS,
    });

    if (!res.ok) return fail(`HTTP ${res.status}`, res.status);

    await supabase
      .from("webhook_deliveries")
      .update({
        attempts: attempt,
        status: "delivered",
        last_status: res.status,
        last_error: null,
        delivered_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    await audit(row.request_id, "webhook_delivered", {
      event: row.event,
      eventId: row.event_id,
      deliveryId,
      status: res.status,
      attempt,
    });
    return true;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Drena las entregas vencidas. Lo llama el cron por minuto.
 *
 * Toma un **lease** antes de intentar (empuja `next_attempt_at`), así dos
 * corridas solapadas no trabajan la misma fila y una corrida que muere a mitad
 * se recupera sola al vencer el lease. Eso vuelve la entrega *at-least-once*,
 * que es aceptable precisamente porque el receptor deduplica por `event_id`
 * — la misma propiedad que hace posible reintentar durante 24 h.
 */
export async function drainDueDeliveries(
  limit = DRAIN_BATCH_SIZE,
): Promise<{ attempted: number; delivered: number }> {
  const supabase = createServiceClient();

  const { data: due } = await supabase
    .from("webhook_deliveries")
    .select("id, request_id, endpoint_id, event, event_id, payload, attempts")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  const rows = (due ?? []) as DeliveryRow[];
  if (rows.length === 0) return { attempted: 0, delivered: 0 };

  await supabase
    .from("webhook_deliveries")
    .update({ next_attempt_at: minutesFromNow(LEASE_MINUTES) })
    .in(
      "id",
      rows.map((r) => r.id),
    );

  let delivered = 0;
  for (const row of rows) {
    if (await attemptDelivery(row)) delivered++;
  }
  return { attempted: rows.length, delivered };
}

/**
 * Reencola una entrega desde el panel: vuelve a `pending` con el contador en
 * cero. El `event_id` no cambia, así que el receptor la sigue deduplicando
 * contra los intentos anteriores si es que alguno llegó.
 */
export async function resendDelivery(deliveryId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("webhook_deliveries")
    .update({
      status: "pending",
      attempts: 0,
      last_error: null,
      last_status: null,
      next_attempt_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  return !error;
}

async function alertExhausted(row: DeliveryRow, error: string, attempts: number) {
  const supabase = createServiceClient();
  const { data: ep } = await supabase
    .from("webhook_endpoints")
    .select("url, api_key_id")
    .eq("id", row.endpoint_id)
    .maybeSingle();

  let client = ep?.api_key_id ? String(ep.api_key_id) : "desconocido";
  if (ep?.api_key_id) {
    const { data: key } = await supabase
      .from("api_keys")
      .select("label")
      .eq("id", ep.api_key_id)
      .maybeSingle();
    if (key?.label) client = String(key.label);
  }

  await sendAlert(`Webhook sin entregar tras ${attempts} intentos — ${client}`, [
    `No se pudo entregar un webhook tras ${attempts} intentos durante ~24 h.`,
    "",
    `Cliente:    ${client}`,
    `Evento:     ${row.event}`,
    `Event ID:   ${row.event_id}`,
    `Solicitud:  ${row.request_id ?? "—"}`,
    `Destino:    ${ep?.url ?? "—"}`,
    `Último error: ${error}`,
    "",
    "La entrega quedó en estado `failed`. Se puede reenviar desde el panel:",
    "Clientes API → <cliente> → Webhooks.",
  ]);
}

async function audit(
  requestId: string | null,
  action: string,
  metadata: Record<string, unknown>,
) {
  const supabase = createServiceClient();
  await supabase
    .from("audit_log")
    .insert({ request_id: requestId, actor: "system", action, metadata });
}
