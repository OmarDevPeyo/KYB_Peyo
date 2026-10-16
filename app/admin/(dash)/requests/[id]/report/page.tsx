import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { getAnalyst, requireAnalyst } from "@/lib/auth/admin";
import { ArrowLeft } from "lucide-react";
import { Brand } from "@/components/Brand";
import { Card } from "@/components/ui/Card";
import { buttonClass } from "@/components/ui/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DocPreview } from "@/components/admin/DocPreview";
import { AnswerField, AnswerValue } from "@/components/admin/answerParts";
import { ReportActions } from "@/components/admin/ReportActions";
import { ReportCheckBlock } from "@/components/admin/ReportCheckBlock";
import type { CheckImage } from "@/components/admin/checkParts";
import { ReportCover } from "@/components/admin/ReportCover";
import { ReportSectionHeader } from "@/components/admin/ReportSectionHeader";
import {
  amlToBadge,
  scorePct,
  subjectName,
  type AmlCheckRow,
} from "@/lib/didit/summary";
import { createSignedDocUrls } from "@/lib/kyb/service";
import { dropForeignFileRefs } from "@/lib/kyb/storagePaths";
import { resolveRequestDefinition } from "@/lib/forms/store";
import { isAnswered, reachableSections, visibleFields } from "@/lib/forms/logic";
import { resolveText, type Field } from "@/lib/forms/definition";
import { fileRefsOf, isLongAnswer } from "@/lib/forms/answers";

export const dynamic = "force-dynamic";

/**
 * Informe de verificación de una solicitud: solo las preguntas realmente
 * contestadas, con la verificación de DIDIT y su resumen justo debajo de la
 * pregunta que la disparó. Solo lectura y pensado para imprimirse a PDF (ver
 * el bloque `@media print` de globals.css).
 */
export default async function RequestReport({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Guard propio: el `getAnalyst()` de más abajo es solo para mostrar el email
  // del analista, y el del layout corre en paralelo con esta página.
  await requireAnalyst();
  const t = await getTranslations("admin");
  const tR = await getTranslations("report");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: request } = await supabase
    .from("kyb_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!request) notFound();

  const [{ data: formRow }, { data: docs }, { data: aml }, analyst] = await Promise.all([
    supabase.from("kyb_form_responses").select("data").eq("request_id", id).maybeSingle(),
    supabase
      .from("kyb_documents")
      .select("id, doc_type, filename, storage_path, mime, uploaded_at")
      .eq("request_id", id),
    supabase
      .from("aml_checks")
      .select("id, provider, status, result, created_at, feature, field_key, score")
      .eq("request_id", id)
      // El informe es la foto de lo vigente: las reemplazadas por una
      // corrección quedan en el panel, con su rótulo.
      .is("superseded_at", null)
      // En el informe cada verificación va bajo su pregunta: el orden natural
      // es cronológico ascendente, no el "más reciente primero" del panel.
      .order("created_at", { ascending: true }),
    getAnalyst(),
  ]);

  // Sin archivos de otras solicitudes (filas anteriores al saneo al escribir).
  const formData = dropForeignFileRefs(
    (formRow?.data as Record<string, unknown>) ?? {},
    id,
  );
  const checks = (aml ?? []) as AmlCheckRow[];
  const definition = await resolveRequestDefinition(
    (request as { form_definition?: unknown }).form_definition,
    (request as { form_id?: string | null }).form_id,
    request.org_id as string,
  );

  // Una sola firma para todos los archivos: los de las respuestas (cualquier
  // valor que sea un array de FileRef) y los de kyb_documents.
  const answerPaths = Object.values(formData).flatMap((v) =>
    fileRefsOf(v).map((r) => r.path),
  );
  const signedUrls = await createSignedDocUrls(
    [...(docs ?? []).map((d) => d.storage_path), ...answerPaths],
    id,
  );

  const fieldByKey = new Map<string, Field>();
  const questionByKey = new Map<string, string>();
  if (definition) {
    for (const s of definition.sections) {
      for (const f of s.fields) {
        fieldByKey.set(f.key, f);
        questionByKey.set(f.key, resolveText(f.label, locale) || f.key);
      }
    }
  }
  const imageForKey = (key: string): CheckImage | undefined => {
    const ref = fileRefsOf(formData[key])[0];
    return ref
      ? { filename: ref.filename, path: ref.path, url: signedUrls[ref.path] }
      : undefined;
  };

  // ---------- Qué preguntas entran al informe ----------
  // `reachableSections` (no `visibleSections`) respeta los saltos del flujo:
  // una rama que el solicitante nunca tomó no aparece. Sobre eso, solo lo
  // efectivamente contestado. Es el mismo criterio de la validación de envío.
  const groups = definition
    ? reachableSections(definition, formData)
        .map((s) => ({
          title: resolveText(s.title, locale),
          fields: visibleFields(s, formData).filter(
            (f) => f.type !== "note" && isAnswered(formData[f.key]),
          ),
        }))
        .filter((g) => g.fields.length > 0)
    : [];

  const shownKeys = new Set(groups.flatMap((g) => g.fields.map((f) => f.key)));

  // Verificaciones agrupadas por la pregunta que las disparó.
  const checksByKey = new Map<string, AmlCheckRow[]>();
  for (const c of checks) {
    if (!c.field_key) continue;
    const list = checksByKey.get(c.field_key);
    if (list) list.push(c);
    else checksByKey.set(c.field_key, [c]);
  }
  // Sin pregunta asociada o cuya pregunta no se muestra (p. ej. kyb_registry,
  // que es un ciclo manual del analista): van al final, nunca se pierden.
  const orphanChecks = checks.filter(
    (c) => !c.field_key || !shownKeys.has(c.field_key),
  );

  // Respuestas fuera del flujo alcanzado (borrador sin podar, o definición que
  // cambió después del envío). Se listan aparte en vez de desaparecer.
  const otherAnswers = Object.entries(formData).filter(
    ([k, v]) => !shownKeys.has(k) && isAnswered(v) && fieldByKey.get(k)?.type !== "note",
  );

  // Documentos que no cuelgan de ninguna pregunta mostrada.
  const orphanDocs = (docs ?? []).filter((d) => !shownKeys.has(d.doc_type));

  const counts = {
    passed: checks.filter((c) => c.status === "passed").length,
    flagged: checks.filter((c) => c.status === "flagged").length,
    pending: checks.filter((c) => c.status === "pending").length,
    error: checks.filter((c) => c.status === "error").length,
  };

  const fmtDate = (v: unknown): string => {
    if (typeof v !== "string" || !v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? "—"
      : new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(d);
  };

  const req = request as Record<string, unknown>;
  const externalRef = String(req.external_ref ?? id);
  // Respuestas a las preguntas marcadas en el formulario (0029_request_summary).
  const subjectTitle = typeof req.subject_title === "string" ? req.subject_title : null;
  const contactEmail = typeof req.contact_email === "string" ? req.contact_email : null;
  // Título del documento: la pregunta marcada como título; si no hay, el nombre
  // que traen las verificaciones; y si tampoco, la referencia de la solicitud.
  const subject = subjectTitle || subjectName(checks) || externalRef;

  return (
    <main className="print-doc mx-auto w-full max-w-3xl p-6">
      <div
        data-no-print
        className="mb-4 flex flex-wrap items-center justify-between gap-2"
      >
        <Link
          href={`/admin/requests/${id}`}
          className={buttonClass({ variant: "quiet", size: "sm", className: "-ml-3" })}
        >
          <ArrowLeft size={16} aria-hidden />
          {tCommon("back")}
        </Link>
        <ReportActions requestId={id} />
      </div>

      {/* Carátula a sangre, solo en el PDF. */}
      <ReportCover
        subject={subject}
        externalRef={externalRef}
        requestId={id}
        status={String(req.status)}
        checks={checks}
      />

      {/* Cabecera del documento. En pantalla es lo primero que se ve; en el PDF
          va después de la carátula, abriendo la página de datos. */}
      {/* Sin `break-before`: el `break-after` de la carátula ya abre esta página. */}
      {/* Con forma de card: en pantalla la carátula no se ve, así que esta
          cabecera es lo primero y necesita presencia propia. */}
      <header className="print-block mb-6 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <Brand size="md" />
        <h1 className="mt-3 font-display text-2xl font-bold text-foreground">
          {tR("title")}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <p className="font-display text-lg font-bold text-foreground">{subject}</p>
          <StatusBadge status={String(req.status)} />
        </div>
        <p className="mt-1 text-xs text-muted">
          {tR("requestLabel")}: {externalRef} · {id}
        </p>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-2">
          {definition && (
            <Meta label={tR("formUsed")}>
              {resolveText(definition.title, locale) || "—"}
              {typeof req.form_revision === "number" ? (
                <span className="text-muted"> · {tR("revision")} {req.form_revision}</span>
              ) : null}
            </Meta>
          )}
          {contactEmail ? (
            <Meta label={tR("contactEmail")}>
              <a href={`mailto:${contactEmail}`} className="text-brand hover:underline">
                {contactEmail}
              </a>
            </Meta>
          ) : null}
          <Meta label={tR("createdAt")}>{fmtDate(req.created_at)}</Meta>
          <Meta label={tR("submittedAt")}>{fmtDate(req.submitted_at)}</Meta>
          {req.decided_at ? (
            <Meta label={tR("decidedAt")}>{fmtDate(req.decided_at)}</Meta>
          ) : null}
          {req.decision ? (
            <Meta label={t("decision")}>
              <StatusBadge status={String(req.decision)} />
            </Meta>
          ) : null}
        </dl>
        {req.decision_reason ? (
          <p className="mt-2 text-sm text-foreground">
            <span className="text-muted">{tR("decisionReason")}: </span>
            {String(req.decision_reason)}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          {tR("generatedAt", {
            date: fmtDate(new Date().toISOString()),
            actor: analyst?.email ?? "—",
          })}
        </p>
      </header>

      {/* Resumen de verificaciones */}
      <ReportSection title={tR("checksSummary")} subject={subject}>
        {/* El recuento va ANTES de la tabla: primero el resumen, luego el
            detalle. `print-block` en la rejilla y no en las fichas porque Chrome
            ignora el break-inside de los descendientes de un grid. */}
        {checks.length > 0 && (
          <dl className="print-block mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CountTile label={tR("countPassed")} value={counts.passed} tone="text-success" />
            <CountTile label={tR("countFlagged")} value={counts.flagged} tone="text-danger" />
            <CountTile label={tR("countPending")} value={counts.pending} tone="text-warning" />
            <CountTile label={tR("countError")} value={counts.error} tone="text-danger" />
          </dl>
        )}
        {checks.length === 0 ? (
          <p className="text-sm text-muted">{t("noChecks")}</p>
        ) : (
          // Sin `print-block`: una tabla larga debe poder cortarse entre
          // páginas (el navegador repite el thead), no saltar entera.
          <Card className="print-overflow-visible overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">{tR("colCheck")}</th>
                  <th className="px-3 py-2 font-semibold">{tR("colQuestion")}</th>
                  <th className="px-3 py-2 font-semibold">{tR("colStatus")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{tR("colScore")}</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <SummaryRow
                    key={c.id}
                    check={c}
                    question={c.field_key ? questionByKey.get(c.field_key) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </ReportSection>

      {/* Respuestas contestadas, con su verificación debajo. En papel el bloque
          entero abre página; las secciones de dentro fluyen (ver abajo). */}
      <ReportSection title={tR("answers")} subject={subject} className="print-page">
        {groups.length === 0 && otherAnswers.length === 0 && (
          <p className="text-sm text-muted">{tR("noAnswers")}</p>
        )}
        {/* En papel las secciones del formulario ya no abren hoja cada una: se
            agrupan sin partirse (`print-group`) y solo los bloques grandes
            fuerzan página. */}
        <div className="space-y-6">
          {groups.map((g, gi) => (
            <section key={gi} className="print-group">
              {/* Sin `subject`: con varias secciones por hoja, repetir el nombre
                  junto a cada título deja de identificar la hoja y es ruido. La
                  identidad la lleva la banda `h2`, que sí abre página. */}
              <ReportSectionHeader as="h3" title={g.title} />
              <Card className="print-flat p-4">
                {/* `divide-y` y no `space-y-*` (no se mezclan): una línea entre
                    pares ancla la lectura mejor que 16px de aire. En impresión
                    `report-pairs` mueve el filete arriba (ver globals.css). */}
                <dl className="report-pairs divide-y divide-border">
                  {g.fields.map((f) => (
                    <AnswerField
                      key={f.id}
                      className="print-block py-3 first:pt-0 last:pb-0"
                      label={resolveText(f.label, locale) || f.key}
                      long={isLongAnswer(f, formData[f.key])}
                      footer={(checksByKey.get(f.key) ?? []).map((c) => (
                        <ReportCheckBlock
                          key={c.id}
                          check={c}
                          image={imageForKey(f.key)}
                          refImages={(f.review?.refKeys ?? [])
                            .map((k) => imageForKey(k))
                            .filter((im): im is CheckImage => Boolean(im))}
                        />
                      ))}
                    >
                      <AnswerValue
                        field={f}
                        value={formData[f.key]}
                        locale={locale}
                        signedUrls={signedUrls}
                      />
                    </AnswerField>
                  ))}
                </dl>
              </Card>
            </section>
          ))}
        </div>
      </ReportSection>

      {/* Verificaciones sin pregunta mostrada (típico: kyb_registry manual) */}
      {orphanChecks.length > 0 && (
        <ReportSection title={tR("otherChecks")} subject={subject} className="print-page">
          {orphanChecks.map((c) => (
            <div key={c.id} className="print-block">
              {c.field_key && (
                <p className="mt-2 text-xs text-muted">
                  {t("question")}: {questionByKey.get(c.field_key) ?? c.field_key}
                </p>
              )}
              <ReportCheckBlock
                check={c}
                image={c.field_key ? imageForKey(c.field_key) : undefined}
                refImages={(c.field_key
                  ? (fieldByKey.get(c.field_key)?.review?.refKeys ?? [])
                  : []
                )
                  .map((k) => imageForKey(k))
                  .filter((im): im is CheckImage => Boolean(im))}
              />
            </div>
          ))}
        </ReportSection>
      )}

      {/* Red de seguridad: nada contestado se pierde del informe */}
      {otherAnswers.length > 0 && (
        <ReportSection title={tR("otherAnswers")} subject={subject} className="print-page">
          <Card className="print-block print-flat p-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {otherAnswers.map(([k, v]) => {
                const field = fieldByKey.get(k);
                return (
                  <AnswerField
                    key={k}
                    className="border-b border-border pb-2"
                    label={questionByKey.get(k) ?? k}
                    long={
                      field ? isLongAnswer(field, v) : typeof v === "string" && v.length > 120
                    }
                  >
                    {field ? (
                      <AnswerValue
                        field={field}
                        value={v}
                        locale={locale}
                        signedUrls={signedUrls}
                      />
                    ) : typeof v === "object" ? (
                      JSON.stringify(v)
                    ) : (
                      String(v)
                    )}
                  </AnswerField>
                );
              })}
            </dl>
          </Card>
        </ReportSection>
      )}

      {orphanDocs.length > 0 && (
        <ReportSection title={tR("otherDocuments")} subject={subject} className="print-page">
          <div className="print-block flex flex-wrap gap-4 text-sm">
            {orphanDocs.map((d) => (
              <div key={d.id}>
                <DocPreview
                  path={d.storage_path}
                  filename={d.filename}
                  url={signedUrls[d.storage_path]}
                  mime={d.mime}
                />
                <p className="mt-1 text-xs text-muted">{d.doc_type}</p>
              </div>
            ))}
          </div>
        </ReportSection>
      )}

      <p className="mt-8 border-t border-border pt-3 text-xs text-muted">
        {tR("confidential")}
      </p>
    </main>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return <AnswerField label={label}>{children}</AnswerField>;
}

/** Métrica del resumen. Un 0 va en gris: un «0» rojo alarma sin motivo. */
function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  /** Clase de color completa: Tailwind necesita el literal en el fuente. */
  tone: string;
}) {
  return (
    // `flex-col-reverse`: el <dt> va primero en el DOM (lo exige <dl>) y el
    // número se pinta arriba.
    <div className="flex flex-col-reverse rounded-xl border border-border bg-surface px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd
        className={`font-display text-2xl font-bold tabular-nums ${
          value === 0 ? "text-muted" : tone
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

async function SummaryRow({
  check,
  question,
}: {
  check: AmlCheckRow;
  question?: string;
}) {
  const t = await getTranslations("admin");
  const tB = await getTranslations("builder");
  const featureKey = check.feature ? `didit_${check.feature}` : null;
  const title = featureKey && tB.has(featureKey) ? tB(featureKey) : t("amlResult");
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 text-foreground">{title}</td>
      <td className="px-3 py-2 text-muted">{question ?? check.field_key ?? "—"}</td>
      <td className="px-3 py-2">
        <StatusBadge status={amlToBadge(check.status)} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-foreground">
        {typeof check.score === "number" ? `${scorePct(check.score).toFixed(2)}%` : "—"}
      </td>
    </tr>
  );
}

function ReportSection({
  title,
  subject,
  children,
  className = "",
}: {
  title: string;
  /** Identifica la hoja cuando la sección abre página. */
  subject: string;
  children: React.ReactNode;
  /** Para el salto de página en impresión (`print-page`). */
  className?: string;
}) {
  return (
    <section className={`mb-6 ${className}`}>
      <ReportSectionHeader title={title} subject={subject} />
      {children}
    </section>
  );
}
