import { NextRequest, NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/apiGuard";
import { createServiceClient } from "@/lib/supabase/service";
import { publicAmlChecks } from "@/lib/kyb/amlPublic";
import { loadRequestExpirations, publicExpirations } from "@/lib/kyb/expirations";
import { FORM_SYSTEM_COLUMN, publicFormIdentity } from "@/lib/kyb/apiForm";

export const runtime = "nodejs";

/**
 * GET /api/v1/kyb/requests/:id
 * Auth: Bearer <api_key>. Devuelve estado + resultado (decisión + AML) para
 * que el cliente consulte el avance. Aislado por cliente: cada key solo ve
 * las solicitudes que ella misma creó.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await apiGuard(req.headers.get("authorization"));
  if ("response" in g) return g.response;

  const { id } = await params;
  const supabase = createServiceClient();

  const { data: request } = await supabase
    .from("kyb_requests")
    .select(
      `id, external_ref, status, decision, decision_reason, corrections, form_id, form_revision, subject_title, contact_email, submitted_ip_country, created_at, submitted_at, decided_at, token_expires_at, ${FORM_SYSTEM_COLUMN}`,
    )
    .eq("id", id)
    .eq("api_key_id", g.keyId)
    .maybeSingle();

  if (!request) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [{ data: amlChecks }, expirations] = await Promise.all([
    supabase
      .from("aml_checks")
      .select("provider, feature, field_key, status, result, created_at, updated_at")
      .eq("request_id", id)
      // Las reemplazadas por una corrección se conservan, pero no son las
      // vigentes: antes se borraban, así que el contrato no las incluye.
      .is("superseded_at", null)
      .order("created_at", { ascending: false }),
    loadRequestExpirations(id),
  ]);

  return NextResponse.json({
    id: request.id,
    externalRef: request.external_ref,
    status: request.status,
    decision: request.decision,
    reason: request.decision_reason ?? null,
    corrections: request.corrections ?? null,
    formId: request.form_id ?? null,
    // Revisión del formulario con la que se creó la solicitud. `null` en
    // solicitudes anteriores a la migración 0018.
    formRevision: request.form_revision ?? null,
    // Formulario del sistema con el que se llenó (clave y versión), o `null`.
    form: publicFormIdentity(request.form_system),
    // Respuestas a las preguntas que el formulario marca como título y como
    // email de contacto. `null` si no hay marca o aún no se respondió.
    subjectTitle: request.subject_title ?? null,
    contactEmail: request.contact_email ?? null,
    expiresAt: request.token_expires_at ?? null,
    createdAt: request.created_at,
    submittedAt: request.submitted_at,
    // Datos del envío que no respondió el solicitante. `ipCountry`: país (ISO
    // alpha-2) de la IP del último envío; `null` antes de enviar, en envíos
    // anteriores a la migración 0034 o si no hubo dato.
    submissionContext: { ipCountry: request.submitted_ip_country ?? null },
    decidedAt: request.decided_at,
    // `result` es el blob crudo del proveedor: sale saneado, nunca directo.
    aml: publicAmlChecks(amlChecks),
    // Documentos con vencimiento controlado. Un vencido no cambia `status`.
    documentExpirations: publicExpirations(expirations),
  });
}
