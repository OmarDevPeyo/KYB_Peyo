import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAnalyst } from "@/lib/auth/admin";
import {
  clientAllowsTranslation,
  translatableLocales,
  translateAnswers,
} from "@/lib/i18n-ai/answers";
import { ArrowLeft, FileText } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button, buttonClass } from "@/components/ui/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { AnswerField, AnswerValue } from "@/components/admin/answerParts";
import { IpCountryField } from "@/components/admin/IpCountryField";
import { DocumentsPanel } from "@/components/admin/DocumentsPanel";
import { formatBytes, type DocGroup, type DocRow } from "@/components/admin/docParts";
import {
  AmlCheckCard,
  type AmlCheckRow,
  type CheckImage,
} from "@/components/admin/AmlCheckCard";
import { decideAction, rerunVerificationsAction } from "@/app/admin/actions";
import { RequestChangesPanel } from "@/components/admin/RequestChangesPanel";
import { RunKybRegistryButton } from "@/components/admin/RunKybRegistryButton";
import { extractKybDeclared } from "@/lib/didit/verify";
import { isTerminal, createSignedDocUrls } from "@/lib/kyb/service";
import type { KybCorrections, KybStatus } from "@/lib/kyb/types";
import { resolveRequestDefinition } from "@/lib/forms/store";
import { countryName } from "@/lib/forms/countries";
import { declaredCountries, ipCountryMismatch } from "@/lib/kyb/ipCountry";
import { isAnswered } from "@/lib/forms/logic";
import { resolveText, type Field } from "@/lib/forms/definition";
import { fileRefsOf, isLongAnswer } from "@/lib/forms/answers";
import { dropForeignFileRefs } from "@/lib/kyb/storagePaths";
import { formatCost } from "@/lib/i18n-ai/pricing";
import { ExpirationList, type ExpirationItem } from "@/components/admin/ExpirationList";
import { todayUtc } from "@/lib/forms/expiry";
import { EXPIRATION_COLUMNS } from "@/lib/kyb/expirations";
import { RENEWAL_COLUMNS, type RenewalRow } from "@/lib/kyb/renewals";
import { RenewalCard } from "@/components/admin/RenewalCard";

export const dynamic = "force-dynamic";
// Las acciones de este detalle pueden llamar a DIDIT (re-verificar, seleccionar
// candidato KYB); las búsquedas registrales tardan hasta ~90s.
export const maxDuration = 180;

export default async function RequestDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tr?: string }>;
}) {
  // Guard propio: el del layout corre en paralelo con esta página.
  const viewer = await requireAnalyst();
  const t = await getTranslations("admin");
  const tCommon = await getTranslations("common");
  const tReport = await getTranslations("report");
  const tExp = await getTranslations("expirations");
  const { id } = await params;
  const { tr } = await searchParams;
  const supabase = await createServerSupabase();

  const { data: request } = await supabase
    .from("kyb_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!request) notFound();

  // Solo el admin necesita ver de qué org es (un miembro solo ve la suya).
  const orgName =
    viewer.role === "admin"
      ? (((
          await supabase
            .from("organizations")
            .select("name")
            .eq("id", request.org_id as string)
            .maybeSingle()
        ).data?.name as string | undefined) ?? null)
      : null;

  const [
    { data: formRow },
    { data: docs },
    { data: aml },
    { data: diditCharges },
    { data: expirations },
    { data: renewals },
  ] = await Promise.all([
    supabase.from("kyb_form_responses").select("data").eq("request_id", id).maybeSingle(),
    supabase
      .from("kyb_documents")
      .select("id, doc_type, filename, storage_path, mime, size, uploaded_at, renewal_id")
      .eq("request_id", id)
      // Sin `order` Postgres devuelve un orden arbitrario: dentro de cada
      // pregunta los archivos deben salir en el orden en que se subieron.
      .order("uploaded_at", { ascending: true }),
    supabase
      .from("aml_checks")
      .select("id, provider, status, result, created_at, feature, field_key, score, superseded_at")
      .eq("request_id", id)
      .order("created_at", { ascending: false }),
    // Costo DIDIT, solo para el admin (es la tarifa del proveedor a la
    // plataforma). Sale del registro de cargos: incluye los checks que una
    // corrección ya borró.
    viewer.role === "admin"
      ? supabase.from("didit_charges").select("amount, source").eq("request_id", id)
      : Promise.resolve({ data: null }),
    // Documentos con vencimiento controlado (lib/kyb/expirations.ts).
    supabase
      .from("document_expirations")
      .select(EXPIRATION_COLUMNS)
      .eq("request_id", id)
      .order("created_at"),
    // Rondas de renovación (columnas explícitas: el hash del token no se expone).
    supabase
      .from("document_renewals")
      .select(RENEWAL_COLUMNS)
      .eq("request_id", id)
      .order("round", { ascending: false }),
  ]);
  const diditCost = diditCharges?.length
    ? {
        amount: diditCharges.reduce((n, c) => n + (c.amount == null ? 0 : Number(c.amount)), 0),
        count: diditCharges.length,
        estimated: diditCharges.some((c) => c.amount != null && c.source === "tariff"),
        pending: diditCharges.filter((c) => c.amount == null).length,
      }
    : null;

  // Sin archivos de otras solicitudes (filas anteriores al saneo al escribir).
  const formData = dropForeignFileRefs(
    (formRow?.data as Record<string, unknown>) ?? {},
    id,
  );
  const status = request.status as KybStatus;
  const closed = isTerminal(status);
  // Solo se puede decidir/pedir correcciones sobre una solicitud ya enviada y
  // aún abierta (no mientras el solicitante ya está corrigiendo).
  const canDecide = status === "submitted" || status === "under_review";
  const corrections = (request as { corrections?: KybCorrections | null })
    .corrections;
  const locale = await getLocale();
  // Definición congelada del request (lo que el solicitante realmente llenó).
  const definition = await resolveRequestDefinition(
    (request as { form_definition?: unknown }).form_definition,
    (request as { form_id?: string | null }).form_id,
    request.org_id as string,
  );

  // País de la IP con que se envió (0034). Se avisa si no coincide con ninguno
  // de los países que declaró; el legacy no tiene preguntas país y no avisa.
  const ipCountry = (request.submitted_ip_country as string | null) ?? null;
  const declared = definition ? declaredCountries(definition, formData) : [];
  const ipWarning = ipCountryMismatch(ipCountry, declared)
    ? t("ipCountryMismatch", {
        declared: declared.map((c) => countryName(c, locale)).join(", "),
      })
    : null;

  // Validación registral (kyb_registry): ciclo manual del analista.
  const hasKybField = Boolean(
    definition?.sections.some((s) =>
      s.fields.some(
        (f) => f.review?.provider === "didit" && f.review.feature === "kyb_registry",
      ),
    ),
  );
  // Datos declarados que enviaría el ciclo (misma función que el run real):
  // alimentan el tooltip del botón para que el analista vea qué se mandará.
  const kybDeclared = hasKybField && definition ? extractKybDeclared(definition, formData) : null;
  // Bloqueado mientras hay búsqueda en curso o un select en vuelo/incierto.
  // (Una fila pending en candidate_selection NO bloquea: un run nuevo la
  // supersede — equivale a "repetir búsqueda".)
  const kybCycleLocked = (aml ?? []).some((c) => {
    if (c.feature !== "kyb_registry" || c.status !== "pending") return false;
    const res = (c.result ?? {}) as {
      phase?: string;
      selected?: { select_attempted?: boolean };
    };
    return (
      res.phase === "search" ||
      res.phase === "select" ||
      Boolean(res.selected?.select_attempted)
    );
  });

  // Firma una sola vez las URLs de todos los archivos (documentos + campos
  // file/selfie del formulario) para mostrar miniaturas inline.
  const answerRefs = definition
    ? definition.sections.flatMap((s) =>
        s.fields
          .filter((f) => f.type === "file" || f.type === "selfie")
          .flatMap((f) => fileRefsOf(formData[f.key])),
      )
    : [];
  const signedUrls = await createSignedDocUrls(
    [...(docs ?? []).map((d) => d.storage_path), ...answerRefs.map((r) => r.path)],
    id,
  );

  // Campo por key (imágenes de referencia) y origen (sección/pregunta) por key.
  const fieldByKey = new Map<string, Field>();
  const triggerByKey = new Map<string, { section: string; question: string }>();
  if (definition) {
    for (const s of definition.sections) {
      const sectionTitle = resolveText(s.title, locale);
      for (const f of s.fields) {
        fieldByKey.set(f.key, f);
        triggerByKey.set(f.key, {
          section: sectionTitle,
          question: resolveText(f.label, locale) || f.key,
        });
      }
    }
  }
  const imageForKey = (key: string): CheckImage | undefined => {
    const ref = fileRefsOf(formData[key])[0];
    return ref
      ? { filename: ref.filename, path: ref.path, url: signedUrls[ref.path] }
      : undefined;
  };

  // ---------- Documentos agrupados por pregunta ----------
  // `kyb_documents.doc_type` guarda la key del campo que pidió el archivo (lo
  // escribe `ApplicantForm` al subir), así que el join documento→pregunta es por
  // key. Lo que no matchea —definición cambiada tras el envío, o el legacy
  // "general"— cae en un grupo final: nada se pierde de vista.
  //
  // Fecha y tamaño se formatean AQUÍ, no en el panel cliente: `i18n/request.ts`
  // no fija `timeZone`, así que hacerlo en el navegador daría una hora distinta
  // a la del SSR y rompería la hidratación.
  const fmtDocDate = (v: unknown): string | null => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? null
      : new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(d);
  };
  // Renovaciones: un archivo que ya no está en las respuestas es la versión
  // anterior de un documento renovado; uno subido en una ronda abierta o
  // rechazada se rotula con su ronda.
  const renewalRows = (renewals ?? []) as unknown as RenewalRow[];
  const renewalById = new Map(renewalRows.map((r) => [r.id, r] as const));
  const renewedKeys = new Set(
    renewalRows.filter((r) => r.state === "accepted").flatMap((r) => r.keys),
  );
  const currentPaths = new Set(
    Object.values(formData).flatMap((v) => fileRefsOf(v).map((r) => r.path)),
  );
  // Correcciones: un archivo enviado que ya no está en las respuestas es la
  // versión anterior de una pregunta que se volvió a pedir (se conserva).
  const lastSubmitAt = request.submitted_at
    ? new Date(request.submitted_at as string).getTime()
    : null;
  const docTag = (d: {
    doc_type: string;
    storage_path: string;
    renewal_id?: string | null;
    uploaded_at?: string | null;
  }) => {
    if (currentPaths.has(d.storage_path)) return null;
    const round = d.renewal_id ? renewalById.get(d.renewal_id) : undefined;
    if (round && round.state !== "accepted") {
      return tExp("docTagRenewal", {
        round: round.round,
        state: tExp(`renewalState_${round.state}`),
      });
    }
    if (round || renewedKeys.has(d.doc_type)) return tExp("docTagPrevious");
    const uploadedAt = d.uploaded_at ? new Date(d.uploaded_at).getTime() : null;
    return lastSubmitAt != null && uploadedAt != null && uploadedAt <= lastSubmitAt
      ? tExp("docTagPrevious")
      : null;
  };

  const toDocRow = (d: {
    id: string;
    doc_type: string;
    filename: string;
    storage_path: string;
    mime: string | null;
    size: number | null;
    uploaded_at: string | null;
    renewal_id?: string | null;
  }): DocRow => ({
    id: d.id,
    filename: d.filename,
    path: d.storage_path,
    mime: d.mime ?? null,
    url: signedUrls[d.storage_path],
    sizeLabel: formatBytes(d.size, locale),
    uploadedAt: d.uploaded_at ?? null,
    uploadedAtLabel: fmtDocDate(d.uploaded_at),
    tag: docTag(d),
  });

  const docList = docs ?? [];
  const docsByType = new Map<string, typeof docList>();
  for (const d of docList) {
    const list = docsByType.get(d.doc_type);
    if (list) list.push(d);
    else docsByType.set(d.doc_type, [d]);
  }
  const docGroups: DocGroup[] = [];
  // `triggerByKey` se llenó recorriendo la definición en orden y un Map conserva
  // el orden de inserción: iterarlo da el mismo orden que secciones/campos.
  for (const [key, trigger] of triggerByKey) {
    const list = docsByType.get(key);
    if (!list?.length) continue;
    docsByType.delete(key);
    docGroups.push({
      key,
      question: trigger.question,
      section: trigger.section,
      docs: list.map(toDocRow),
    });
  }
  const orphanDocs = Array.from(docsByType.values()).flat();
  if (orphanDocs.length > 0) {
    docGroups.push({
      key: "__other__",
      question: null,
      section: null,
      docs: orphanDocs.map(toDocRow),
    });
  }

  // ---------- Traducción de respuestas (texto libre) ----------
  // Se gatea con el opt-in del cliente DUEÑO de la solicitud: el consentimiento
  // es sobre el dato, no sobre quién lo mira, así que un analista tampoco puede
  // mandar a un proveedor externo lo que el cliente no habilitó. Los intakes
  // públicos (`/forms/[id]`) no tienen API key y quedan permitidos: los recibe
  // la org dueña del formulario, en su propio panel.
  const ownerKeyId = (request as { api_key_id?: string | null }).api_key_id ?? null;
  const trLocales = translatableLocales(definition);
  const trTarget = tr && trLocales.includes(tr) ? tr : null;
  const trAllowed = ownerKeyId ? await clientAllowsTranslation(ownerKeyId) : true;

  let answerTranslations: Record<string, string> | undefined;
  if (trTarget && trAllowed) {
    try {
      const out = await translateAnswers(id, definition, formData, trTarget, {
        actor: viewer.email,
        orgId: request.org_id as string,
      });
      answerTranslations = out.byKey;
    } catch (e) {
      console.error(
        "[i18n-ai] answers translation failed",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <Link
        href="/admin"
        // `-ml-3` compensa el padding del botón para que el texto siga alineado
        // con el `<h1>` de abajo.
        className={buttonClass({ variant: "quiet", size: "sm", className: "-ml-3" })}
      >
        <ArrowLeft size={16} aria-hidden />
        {tCommon("back")}
      </Link>

      <header className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* El estado es un atributo de la solicitud, no una acción: vive junto
              al título y deja el lado derecho libre para lo accionable. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* La respuesta a la pregunta marcada como título; sin ella, la ref. */}
            <h1 className="font-display text-2xl font-bold text-foreground">
              {request.subject_title || request.external_ref}
            </h1>
            <StatusBadge status={request.status} />
            {/* El admin ve solicitudes de todas las orgs: de quién es y un
                atajo a la pestaña de esa org. */}
            {orgName && (
              <Link
                href={`/admin?org=${request.org_id}`}
                className="rounded-md bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand hover:underline"
              >
                {orgName}
              </Link>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {request.subject_title ? `${t("refShort")} ${request.external_ref} · ` : ""}ID:{" "}
            {request.id}
          </p>
          {request.contact_email && (
            <p className="mt-0.5 text-sm">
              <span className="text-muted">{t("contactEmail")}: </span>
              <a
                href={`mailto:${request.contact_email}`}
                className="text-brand hover:underline"
              >
                {request.contact_email}
              </a>
            </p>
          )}
        </div>
        {/* `outline` y no `primary`: las acciones primarias de la página
            (Aprobar/Rechazar) son success/danger y están más abajo. */}
        <Link
          href={`/admin/requests/${id}/report`}
          className={buttonClass({ variant: "outline", size: "sm" })}
        >
          <FileText size={16} aria-hidden />
          {tReport("open")}
        </Link>
      </header>

      {/* AML */}
      <Section title={t("amlResult")}>
        <div className="mb-2 flex flex-wrap items-start gap-2">
          <form action={rerunVerificationsAction.bind(null, id)}>
            <Button type="submit" variant="outline" size="sm">
              {t("reverify")}
            </Button>
          </form>
          {/* Validación registral: ciclo manual (search ~90s, se cobra si hay candidatos; el select
              facturable queda detrás del picker o del match exacto) */}
          {hasKybField && (
            <RunKybRegistryButton
              requestId={id}
              disabled={kybCycleLocked}
              declared={
                kybDeclared
                  ? {
                      name: kybDeclared.name,
                      registrationNumber: kybDeclared.registrationNumber ?? null,
                      country: kybDeclared.country ?? null,
                    }
                  : null
              }
            />
          )}
        </div>
        {diditCost && (
          <p className="mb-2 text-xs text-muted">
            {t("diditCost", {
              amount: `${diditCost.estimated ? "≈ " : ""}${formatCost(diditCost.amount)}`,
              count: diditCost.count,
            })}
            {diditCost.estimated && <> · {t("diditCostEstimated")}</>}
            {diditCost.pending > 0 && <> · {t("diditCostPending", { count: diditCost.pending })}</>}
          </p>
        )}
        {(aml ?? []).length === 0 && (
          <p className="text-sm text-muted">{t("noChecks")}</p>
        )}
        {(aml ?? []).map((c, i) => {
          // `aml` viene del más nuevo al más viejo: un check con otro más nuevo
          // del mismo documento describe la versión anterior (renovación). Uno
          // con `superseded_at` es de una respuesta que se volvió a pedir.
          const superseded =
            Boolean(c.superseded_at) ||
            (c.feature === "id_verification" &&
              (aml ?? [])
                .slice(0, i)
                .some((n) => n.feature === c.feature && n.field_key === c.field_key));
          const image =
            c.field_key && !superseded ? imageForKey(c.field_key) : undefined;
          const field = c.field_key ? fieldByKey.get(c.field_key) : undefined;
          const trigger = c.field_key ? triggerByKey.get(c.field_key) : undefined;
          const refImages = (field?.review?.refKeys ?? [])
            .map((k) => imageForKey(k))
            .filter((im): im is CheckImage => Boolean(im));
          return (
            <AmlCheckCard
              key={i}
              check={c as AmlCheckRow}
              image={image}
              refImages={refImages}
              sectionTitle={trigger?.section}
              fieldLabel={trigger?.question}
              requestId={id}
              superseded={superseded}
            />
          );
        })}
      </Section>

      {/* Vencimientos: visibles en cualquier estado, para ver un documento ya
          vencido antes de aprobar. */}
      {(expirations ?? []).length > 0 && (
        <Section title={tExp("detailTitle")}>
          <Card className="overflow-hidden">
            <ExpirationList
              items={(expirations ?? []) as unknown as ExpirationItem[]}
              today={todayUtc()}
            />
          </Card>
          {(status === "approved" || (renewals ?? []).length > 0) && (
            <div className="mt-3">
              <RenewalCard
                requestId={id}
                renewals={(renewals ?? []) as unknown as RenewalRow[]}
                expirations={(expirations ?? []) as unknown as ExpirationItem[]}
                today={todayUtc()}
                approved={status === "approved"}
              />
            </div>
          )}
        </Section>
      )}

      {/* Documentos */}
      <Section title={t("documents")}>
        {docGroups.length === 0 ? (
          <p className="text-sm text-muted">{t("noDocuments")}</p>
        ) : (
          <DocumentsPanel groups={docGroups} />
        )}
      </Section>

      {/* Formulario */}
      <Section
        title={t("form")}
        action={
          trLocales.length > 0 ? (
            trAllowed ? (
              <div className="flex items-center gap-2 text-xs">
                {trTarget ? (
                  <Link href={`/admin/requests/${id}`} className="text-brand hover:underline">
                    {t("showOriginal")}
                  </Link>
                ) : null}
                {trLocales
                  .filter((l) => l !== trTarget)
                  .map((l) => (
                    <Link
                      key={l}
                      href={`/admin/requests/${id}?tr=${l}`}
                      className="text-brand hover:underline"
                    >
                      {t("translateAnswersTo", { locale: l.toUpperCase() })}
                    </Link>
                  ))}
                {trTarget && <span className="text-muted">{t("translatedNote")}</span>}
              </div>
            ) : (
              <span className="text-xs text-muted" title={t("translateDisabledHint")}>
                {t("translateDisabled")}
              </span>
            )
          ) : undefined
        }
      >
        {definition ? (
          <div className="space-y-4">
            {definition.sections.map((s, si) => {
              const fields = s.fields.filter((f) => f.type !== "note");
              if (fields.length === 0) return null;
              const answered = fields.filter((f) => isAnswered(formData[f.key]));
              const empty = fields.filter((f) => !isAnswered(formData[f.key]));

              // Sección totalmente sin responder (típico de ramas no tomadas):
              // colapsada entera, con bg distinto, para no ensuciar la vista.
              if (answered.length === 0) {
                return (
                  <details
                    key={si}
                    className="rounded-xl border border-border bg-surface-2 p-4"
                  >
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                      {resolveText(s.title, locale)} ·{" "}
                      {t("unanswered", { count: empty.length })}
                    </summary>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                      {empty.map((f) => (
                        <FieldRow
                          key={f.id}
                          field={f}
                          value={formData[f.key]}
                          locale={locale}
                          signedUrls={signedUrls}
                          translated={answerTranslations?.[f.key]}
                        />
                      ))}
                    </dl>
                  </details>
                );
              }

              return (
                <Card key={si} className="p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    {resolveText(s.title, locale)}
                  </h3>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    {answered.map((f) => (
                      <FieldRow
                        key={f.id}
                        field={f}
                        value={formData[f.key]}
                        locale={locale}
                        signedUrls={signedUrls}
                        translated={answerTranslations?.[f.key]}
                      />
                    ))}
                  </dl>
                  {empty.length > 0 && (
                    <details className="mt-3 rounded-lg bg-surface-2 p-2">
                      <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                        {t("unanswered", { count: empty.length })}
                      </summary>
                      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                        {empty.map((f) => (
                          <FieldRow
                            key={f.id}
                            field={f}
                            value={formData[f.key]}
                            locale={locale}
                            signedUrls={signedUrls}
                            translated={answerTranslations?.[f.key]}
                          />
                        ))}
                      </dl>
                    </details>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="p-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {Object.entries(formData).map(([k, v]) => (
                <AnswerField key={k} className="border-b border-border pb-2" label={k}>
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </AnswerField>
              ))}
            </dl>
          </Card>
        )}

        {/* Lo que no respondió el solicitante pero llegó con el envío. Antes de
            enviar no hay nada que mostrar. */}
        {request.submitted_at && (
          <Card className="mt-4 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t("submissionData")}
            </h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <IpCountryField
                code={ipCountry}
                locale={locale}
                label={t("ipCountry")}
                unknown={t("ipCountryUnknown")}
                warning={ipWarning}
                hint={t("ipCountryHint")}
              />
            </dl>
          </Card>
        )}
      </Section>

      {/* Decisión */}
      {canDecide && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-start gap-3">
            <form action={decideAction.bind(null, id, "approved")}>
              <Button variant="success">{t("approve")}</Button>
            </form>
            <form action={decideAction.bind(null, id, "rejected")} className="flex flex-col gap-2">
              <textarea
                name="reason"
                rows={2}
                className="w-64 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground outline-none focus:border-brand"
                placeholder={t("rejectReason")}
              />
              <Button variant="danger">{t("reject")}</Button>
            </form>
          </div>
          {definition && (
            <RequestChangesPanel
              requestId={id}
              fields={definition.sections.flatMap((s) =>
                s.fields
                  .filter((f) => f.type !== "note")
                  .map((f) => ({
                    key: f.key,
                    label: resolveText(f.label, locale) || f.key,
                    section: resolveText(s.title, locale),
                  })),
              )}
            />
          )}
        </div>
      )}
      {status === "changes_requested" && corrections && (
        <Card className="mt-6 p-4">
          <p className="text-sm font-medium text-foreground">
            {t("awaitingCorrections", { round: corrections.round })}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {corrections.fields.map((f) => (
              <li key={f.key}>
                <strong className="text-foreground">
                  {triggerByKey.get(f.key)?.question ?? f.key}
                </strong>
                {f.note ? ` — ${f.note}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {closed && (
        <p className="mt-6 text-sm text-muted">
          {t("decision")}:{" "}
          <strong className="text-foreground">
            {request.decision ?? request.status}
          </strong>
          {request.decision_reason ? (
            <span className="mt-1 block text-foreground">
              {request.decision_reason}
            </span>
          ) : null}
        </p>
      )}
    </main>
  );
}

/** Fila label/valor de una respuesta del formulario. */
function FieldRow({
  field,
  value,
  locale,
  signedUrls,
  translated,
}: {
  field: Field;
  value: unknown;
  locale: string;
  signedUrls: Record<string, string>;
  /** Traducción del texto libre, si se pidió. */
  translated?: string;
}) {
  return (
    <AnswerField
      className="border-b border-border pb-2"
      label={resolveText(field.label, locale) || field.key}
      long={isLongAnswer(field, value)}
      footer={
        // El original queda como valor principal: es el registro de lo que
        // declaró el solicitante. La traducción es una ayuda de lectura.
        translated ? (
          <p className="mt-1 text-xs italic leading-relaxed text-muted">{translated}</p>
        ) : null
      }
    >
      <AnswerValue field={field} value={value} locale={locale} signedUrls={signedUrls} />
    </AnswerField>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  /** Control opcional alineado a la derecha del encabezado. */
  action?: React.ReactNode;
}) {
  if (action) {
    return (
      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
            {title}
          </h2>
          <div className="ml-auto">{action}</div>
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}
