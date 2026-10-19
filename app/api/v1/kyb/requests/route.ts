import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiGuard } from "@/lib/auth/apiGuard";
import { chooseRequestForm, createRequest } from "@/lib/kyb/service";
import { createServiceClient } from "@/lib/supabase/service";
import {
  claimIdempotency,
  hashBody,
  storeIdempotentResponse,
} from "@/lib/kyb/idempotency";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    external_ref: z.string().min(1, "external_ref es requerido").max(100),
    ttl_hours: z.number().int().positive().optional(),
    form_id: z.string().uuid().optional(),
    // Endpoint de webhook REGISTRADO (no una URL arbitraria) para el push.
    webhook_endpoint_id: z.string().uuid().optional(),
    // Redirect del navegador del usuario final tras enviar. Debe ser https.
    return_url: z.string().url().max(2048).optional(),
  })
  .strict();

/**
 * GET /api/v1/kyb/requests
 * Auth: Bearer <api_key>. Lista las solicitudes de ESTE cliente (aisladas por key).
 * Query: status?, external_ref?, limit? (def 20, máx 100), offset?.
 */
export async function GET(req: NextRequest) {
  const g = await apiGuard(req.headers.get("authorization"));
  if ("response" in g) return g.response;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const externalRef = searchParams.get("external_ref");
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 20, 1), 100);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);

  const supabase = createServiceClient();
  let query = supabase
    .from("kyb_requests")
    .select(
      "id, external_ref, status, decision, subject_title, contact_email, submitted_ip_country, created_at, submitted_at, decided_at",
      { count: "exact" },
    )
    .eq("api_key_id", g.keyId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq("status", status);
  if (externalRef) query = query.eq("external_ref", externalRef);

  const { data, count } = await query;
  return NextResponse.json({
    data: (data ?? []).map((r) => ({
      id: r.id,
      externalRef: r.external_ref,
      status: r.status,
      decision: r.decision,
      subjectTitle: r.subject_title ?? null,
      contactEmail: r.contact_email ?? null,
      createdAt: r.created_at,
      submittedAt: r.submitted_at,
      // País de la IP del último envío (ver GET /:id).
      submissionContext: { ipCountry: r.submitted_ip_country ?? null },
      decidedAt: r.decided_at,
    })),
    limit,
    offset,
    total: count ?? null,
  });
}

/**
 * POST /api/v1/kyb/requests
 * Auth: Bearer <api_key>. Crea una solicitud KYB y devuelve el link de invitación.
 */
export async function POST(req: NextRequest) {
  const g = await apiGuard(req.headers.get("authorization"), { failClosed: true });
  if ("response" in g) return g.response;

  const raw = await req.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { external_ref, ttl_hours, form_id, webhook_endpoint_id, return_url } =
    parsed.data;

  if (return_url && !return_url.startsWith("https://")) {
    return NextResponse.json(
      { error: "invalid_return_url", detail: "return_url debe ser https" },
      { status: 422 },
    );
  }

  // Idempotencia: si el cliente reintenta con la misma Idempotency-Key, no
  // duplicamos la solicitud (ni las verificaciones DIDIT pagadas).
  const idemKey = req.headers.get("idempotency-key")?.trim();
  if (idemKey) {
    const claim = await claimIdempotency(g.keyId, idemKey, hashBody(raw));
    if (claim.status === "replay") {
      return NextResponse.json(claim.body, { status: claim.httpStatus });
    }
    if (claim.status === "conflict") {
      return NextResponse.json({ error: claim.error }, { status: 409 });
    }
  }

  // Un 422 después del claim también se guarda: si no, la key quedaba "en
  // curso" para siempre y cada reintento recibía 409 en vez del error real.
  const reject = async (error: string) => {
    if (idemKey) await storeIdempotentResponse(g.keyId, idemKey, 422, { error });
    return NextResponse.json({ error }, { status: 422 });
  };

  // El endpoint de webhook debe pertenecer a esta key y estar habilitado.
  if (webhook_endpoint_id) {
    const supabase = createServiceClient();
    const { data: ep } = await supabase
      .from("webhook_endpoints")
      .select("id, enabled")
      .eq("id", webhook_endpoint_id)
      .eq("api_key_id", g.keyId)
      .maybeSingle();
    if (!ep || !ep.enabled) return reject("invalid_webhook_endpoint");
  }

  // El formulario sale de la org de la key: el `form_id` pedido solo si es
  // suyo y está publicado; sin `form_id`, su KYB_FORM_ID o el último publicado
  // de la org. Antes valía cualquier formulario del sistema.
  const choice = await chooseRequestForm({
    orgId: g.orgId,
    requestedId: form_id,
    keyDefaultId: g.defaultFormId,
  });
  if (!choice.ok) return reject(choice.error);

  const result = await createRequest({
    orgId: g.orgId,
    externalRef: external_ref,
    ttlHours: ttl_hours,
    form: { id: choice.formId, revision: choice.revision },
    // Congelada como en el intake público: si el formulario se edita después,
    // la solicitud sigue con lo que reporta su `form_revision`.
    formDefinition: choice.definition,
    apiKeyId: g.keyId,
    webhookEndpointId: webhook_endpoint_id ?? null,
    returnUrl: return_url ?? null,
  });

  const responseBody = {
    id: result.id,
    invitationUrl: result.invitationUrl,
    token: result.token,
    expiresAt: result.expiresAt,
    status: "created",
  };
  if (idemKey) {
    await storeIdempotentResponse(g.keyId, idemKey, 201, responseBody);
  }

  return NextResponse.json(responseBody, { status: 201 });
}
