import { getLocale, getTranslations } from "next-intl/server";
import { getRequestByToken } from "@/lib/kyb/service";
import { resolveRenewal } from "@/lib/kyb/renewals";
import { expiryStatus, todayUtc } from "@/lib/forms/expiry";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveRequestDefinition } from "@/lib/forms/store";
import { reachableSections } from "@/lib/forms/logic";
import { publicDefinition } from "@/lib/forms/internalFields";
import { emptyForm } from "@/lib/forms/schema";
import type { KybCorrections } from "@/lib/kyb/types";
import { AppHeader } from "@/components/AppHeader";
import { Card } from "@/components/ui/Card";
import { ApplicantForm } from "./ApplicantForm";
import KybForm from "./KybForm";

export const dynamic = "force-dynamic";
// Margen para el trabajo en segundo plano (`after` → runVerifications) que
// corre tras responder el submit de este route (verificaciones DIDIT/AML).
// La validación registral (kyb_registry, ~90s) NO corre aquí: es un ciclo
// manual del analista desde el panel.
export const maxDuration = 60;

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center p-8">
        <Card className="w-full p-8 text-center">
          <h1 className="font-display text-2xl font-bold text-foreground">
            {title}
          </h1>
          <p className="mt-2 text-muted">{body}</p>
        </Card>
      </main>
    </>
  );
}

export default async function FormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("form");
  const req = await getRequestByToken(token);

  if (!req) {
    // ¿Link de renovación? Tiene su propio token (document_renewals).
    const renewal = await resolveRenewal(token);
    if (!renewal) return <Notice title={t("invalidTitle")} body={t("invalidBody")} />;
    if (!renewal.ok) {
      const key =
        renewal.reason === "received"
          ? "renewalReceived"
          : renewal.reason === "expired"
            ? "renewalExpired"
            : "renewalInvalid";
      return <Notice title={t(`${key}Title`)} body={t(`${key}Body`)} />;
    }
    const locale = await getLocale();
    const today = todayUtc();
    const fmt = (d: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
        new Date(`${d}T00:00:00Z`),
      );
    // Nota en la pregunta del documento (cuándo venció o vence) y en sus
    // acompañantes: la fecha de vencimiento nueva o el reverso.
    const notes = renewal.renewal.fields.flatMap((f) =>
      f.keys.map((key) => ({
        key,
        note:
          key !== f.fieldKey
            ? t(f.marker === "date_field" ? "renewalNoteDate" : "renewalNoteBack")
            : f.expiresOn
              ? t(
                  expiryStatus(f.expiresOn, today) === "expired"
                    ? "renewalNoteExpired"
                    : "renewalNoteExpiring",
                  { date: fmt(f.expiresOn) },
                )
              : t("renewalNoteNoDate"),
      })),
    );
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">
          <ApplicantForm
            token={token}
            definition={publicDefinition(renewal.renewalDef)}
            locale={locale}
            initialAnswers={renewal.renewal.answers ?? {}}
            mode="correction"
            corrections={notes}
            anchorSectionId={renewal.renewalDef.sections[0]?.id}
            flow="renewal"
          />
        </main>
      </>
    );
  }
  if (req.status === "expired") {
    return <Notice title={t("expiredTitle")} body={t("expiredBody")} />;
  }
  if (["submitted", "under_review", "approved", "rejected"].includes(req.status)) {
    return <Notice title={t("receivedTitle")} body={t("receivedBody")} />;
  }

  const supabase = createServiceClient();
  const [{ data: draftRow }, { data: docs }] = await Promise.all([
    supabase
      .from("kyb_form_responses")
      .select("data")
      .eq("request_id", req.id)
      .maybeSingle(),
    supabase
      .from("kyb_documents")
      .select("id, doc_type, filename, uploaded_at, storage_path")
      .eq("request_id", req.id)
      .order("uploaded_at", { ascending: true }),
  ]);

  const savedData = (draftRow?.data as Record<string, unknown>) ?? {};

  // Modo corrección: el analista/cliente devolvió la solicitud para corregir
  // preguntas puntuales. Se resuelve la definición CONGELADA (lo que el
  // solicitante llenó) y se arranca en la 1ª pregunta marcada (el "anchor").
  if (req.status === "changes_requested") {
    const corrections =
      (req as { corrections?: KybCorrections | null }).corrections ?? null;
    const definition = await resolveRequestDefinition(
      (req as { form_definition?: unknown }).form_definition,
      (req as { form_id?: string | null }).form_id,
      req.org_id,
    );
    if (definition && corrections?.fields?.length) {
      const locale = await getLocale();
      const marked = new Set(corrections.fields.map((f) => f.key));
      const reach = reachableSections(definition, savedData);
      const anchor =
        reach.find((s) => s.fields.some((f) => marked.has(f.key))) ?? reach[0];
      return (
        <>
          <AppHeader />
          <main className="mx-auto w-full max-w-2xl flex-1 p-6">
            <ApplicantForm
              token={token}
              // Sin la configuración interna (título/email): el solicitante no la ve.
              definition={publicDefinition(definition)}
              locale={locale}
              initialAnswers={savedData}
              returnUrl={(req as { return_url?: string | null }).return_url ?? undefined}
              mode="correction"
              corrections={corrections.fields}
              anchorSectionId={anchor?.id}
            />
          </main>
        </>
      );
    }
    // Sin definición/correcciones válidas: no debería ocurrir (requestChanges lo
    // rechaza en legacy), pero por seguridad mostramos el aviso genérico.
    return <Notice title={t("receivedTitle")} body={t("receivedBody")} />;
  }

  // Formulario dinámico: la definición de la solicitud (la congelada al
  // crearla, o el formulario asignado/publicado si no tiene). Es la misma contra
  // la que se validan el autosave y el envío: mostrar el formulario vivo hacía
  // que, tras editarlo, el solicitante viera preguntas que el envío rechazaba o
  // descartaba. Si no hay ninguna, fallback al legacy.
  const definition = await resolveRequestDefinition(
    (req as { form_definition?: unknown }).form_definition,
    (req as { form_id?: string | null }).form_id,
    req.org_id,
  );
  if (definition) {
    const locale = await getLocale();
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">
          <ApplicantForm
            token={token}
            definition={publicDefinition(definition)}
            locale={locale}
            initialAnswers={savedData}
            returnUrl={(req as { return_url?: string | null }).return_url ?? undefined}
          />
        </main>
      </>
    );
  }

  return (
    <KybForm
      token={token}
      initialData={{ ...emptyForm, ...savedData }}
      initialDocs={(docs ?? []).map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        filename: d.filename,
        uploaded_at: d.uploaded_at,
        storagePath: d.storage_path ?? "",
      }))}
      returnUrl={(req as { return_url?: string | null }).return_url ?? undefined}
    />
  );
}
