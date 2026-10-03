import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DocPreview } from "@/components/admin/DocPreview";
import { KybCandidatePicker } from "@/components/admin/KybCandidatePicker";
import {
  AmlHits,
  CheckDoc,
  CuratedFields,
  KybDeclaredBlock,
  KybRegistryPeople,
  Meter,
  Warnings,
  type CheckImage,
} from "@/components/admin/checkParts";
import {
  amlToBadge,
  envelopeOf,
  fmt,
  nodeOf,
  RISK_FEATURES,
  scoreLabelKey,
  type AmlCheckRow,
  type Node,
} from "@/lib/didit/summary";

export type { AmlCheckRow, CheckImage };

export async function AmlCheckCard({
  check,
  image,
  refImages,
  sectionTitle,
  fieldLabel,
  requestId,
  superseded = false,
}: {
  check: AmlCheckRow;
  image?: CheckImage;
  /** Imágenes de referencia (p. ej. el documento contra el que se hizo el face match). */
  refImages?: CheckImage[];
  /** Sección y pregunta del formulario que dispararon esta verificación. */
  sectionTitle?: string;
  fieldLabel?: string;
  /** Necesario para las acciones de kyb_registry (picker / repetir búsqueda). */
  requestId?: string;
  /**
   * Hay un check más nuevo del mismo documento (una renovación aceptada): este
   * describe el documento anterior, no el que está hoy en las respuestas.
   */
  superseded?: boolean;
}) {
  const t = await getTranslations("admin");
  const tB = await getTranslations("builder");

  const feature = check.feature;
  const featureKey = feature ? `didit_${feature}` : null;
  const title = featureKey && tB.has(featureKey) ? tB(featureKey) : t("amlResult");
  const node = nodeOf(feature, check.result);
  const risk = feature ? RISK_FEATURES.has(feature) : false;

  const cf = (k: string) => t(`checkFields.${k}`);

  // Extras de kyb_registry que viven en la raíz del result (no en el nodo):
  // fase del ciclo, datos declarados, candidatos y marca de selección.
  const envl = envelopeOf(check.result);
  const isKyb = feature === "kyb_registry";
  const kybPhase = isKyb ? fmt(envl.phase) : "";
  const kybDeclared = isKyb ? (envl.declared as Node | undefined) : undefined;
  const kybSelected = isKyb ? (envl.selected as Node | undefined) : undefined;
  const kybCandidates = isKyb && Array.isArray(envl.candidates) ? envl.candidates : [];
  const kybBlocked = isKyb ? fmt(envl.autoSelectBlockedReason) : "";
  // Candidatos preliminares del ACK del search async: DIDIT puede adelantar
  // empresas con fetch_status pending antes de que la búsqueda resuelva.
  const kybSearchReg = isKyb
    ? (((envl.kyb_search as Node | undefined)?.kyb_registry ?? {}) as Node)
    : ({} as Node);
  const kybPreliminary =
    isKyb &&
    kybPhase === "search" &&
    check.status === "pending" &&
    Array.isArray(kybSearchReg.companies)
      ? (kybSearchReg.companies as Record<string, unknown>[])
      : [];
  // El picker solo aparece en candidate_selection y ANTES de cualquier intento
  // de select (un intento, aunque incierto, bloquea el ciclo: pudo facturarse).
  const showKybPicker =
    isKyb &&
    check.status === "pending" &&
    kybPhase === "candidate_selection" &&
    kybCandidates.length > 0 &&
    kybSelected?.select_attempted !== true &&
    Boolean(requestId);

  return (
    <Card className="mb-2 p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{title}</span>
        <StatusBadge status={amlToBadge(check.status)} />
        {superseded && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
            {t("checkSuperseded")}
          </span>
        )}
        <span className="ml-auto text-xs text-muted">{check.provider}</span>
      </div>

      {/* Fase del ciclo kyb_registry (search → candidate_selection | select → completed) */}
      {isKyb && check.status === "error" ? (
        <p className="mb-2 text-xs text-muted">{t("kybErrorRetry")}</p>
      ) : (
        isKyb &&
        kybPhase &&
        t.has(`kybPhase_${kybPhase}`) && (
          <p className="mb-2 text-xs text-muted">{t(`kybPhase_${kybPhase}`)}</p>
        )
      )}
      {/* Motivo del fallo (cualquier check didit en error guarda result.error) */}
      {check.status === "error" && fmt(envl.error) && (
        <p className="mb-2 rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">
          {fmt(envl.error)}
        </p>
      )}

      {/* Resultados preliminares mientras la búsqueda resuelve (solo lectura) */}
      {kybPreliminary.length > 0 && (
        <div className="mb-2">
          <p className="text-xs font-medium text-foreground">{t("kybPreliminary")}</p>
          <p className="mb-1 text-xs text-muted">{t("kybPreliminaryHint")}</p>
          <div className="space-y-1">
            {kybPreliminary.slice(0, 5).map((c, i) => {
              const cand = (c ?? {}) as Node;
              return (
                <div key={i} className="rounded-lg border border-border p-2 text-xs opacity-80">
                  <div className="font-medium text-foreground">{fmt(cand.name) || "—"}</div>
                  <div className="text-muted">
                    {[
                      fmt(cand.registration_number),
                      fmt(cand.type),
                      fmt(cand.status),
                      fmt(cand.fetch_status),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(sectionTitle || fieldLabel) && (
        <details className="mb-2 rounded-lg bg-surface-2 px-2 py-1">
          <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
            {t("validationTrigger")}
          </summary>
          <dl className="mt-1 space-y-0.5 text-xs">
            {sectionTitle && (
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted">{t("section")}:</dt>
                <dd className="min-w-0 break-words text-foreground">{sectionTitle}</dd>
              </div>
            )}
            {fieldLabel && (
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted">{t("question")}:</dt>
                <dd className="min-w-0 break-words text-foreground">{fieldLabel}</dd>
              </div>
            )}
          </dl>
        </details>
      )}

      <div className="flex flex-wrap gap-3">
        {image && <CheckDoc doc={image} cf={cf} labelKey="imageUsed" />}
        {/* `basis-72` y no `flex-1`: `flex-1` es base 0, y con base 0 la columna
            SIEMPRE cabe en la línea, así que `flex-wrap` nunca la baja —solo la
            comprime, hasta dejarla inservible—. Con base real envuelve. */}
        <div className="min-w-0 grow basis-72">
          {typeof check.score === "number" && (
            <Meter value={check.score} risk={risk} label={cf(scoreLabelKey(feature))} />
          )}
          <CuratedFields feature={feature} node={node} cf={cf} />
          {refImages && refImages.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                {cf("refImage")}
              </summary>
              <div className="mt-1 flex flex-wrap gap-2">
                {refImages.map((im, idx) => (
                  <DocPreview key={idx} path={im.path} filename={im.filename} url={im.url} />
                ))}
              </div>
            </details>
          )}
          {feature === "aml_screening" && node && <AmlHits node={node} />}
          {isKyb && kybDeclared && <KybDeclaredBlock declared={kybDeclared} node={node} cf={cf} t={t} />}
          {isKyb && node && <KybRegistryPeople node={node} cf={cf} />}
          {isKyb && envl.reason === "no_candidates" && (
            <p className="mt-2 text-xs text-muted">{t("kybNoCandidates")}</p>
          )}
          {isKyb && envl.reason === "none_matched" && (
            <p className="mt-2 text-xs text-muted">{t("kybNoneMatchedInfo")}</p>
          )}
          {isKyb && envl.reason === "superseded" && (
            <p className="mt-2 text-xs text-muted">{t("kybSuperseded")}</p>
          )}
          {showKybPicker && kybBlocked && t.has(`kybBlocked_${kybBlocked}`) && (
            <p className="mt-2 text-xs text-muted">{t(`kybBlocked_${kybBlocked}`)}</p>
          )}
          {isKyb && fmt(envl.select_error) && (
            <p className="mt-2 text-xs text-danger">{fmt(envl.select_error)}</p>
          )}
          {/* Intento de select sin confirmación: pudo facturarse — sin reintentos */}
          {isKyb &&
            check.status === "pending" &&
            kybSelected?.select_attempted === true &&
            kybSelected.billing_state === "unknown" && (
              <div className="mt-2 rounded-lg bg-warning/10 px-2 py-1 text-xs text-warning">
                {t("kybAttemptedInfo")}
              </div>
            )}
          {showKybPicker && requestId && (
            <KybCandidatePicker
              checkId={check.id}
              requestId={requestId}
              candidates={kybCandidates
                .map((c) => {
                  const cand = (c ?? {}) as Node;
                  return {
                    kyb_response_id: String(cand.kyb_response_id ?? ""),
                    name: fmt(cand.name),
                    registration_number: fmt(cand.registration_number),
                    status: fmt(cand.status),
                    type: fmt(cand.type),
                    fetch_status: fmt(cand.fetch_status),
                    match_reason: fmt(cand.match_reason),
                  };
                })
                .filter((c) => c.kyb_response_id)}
            />
          )}
          {node && <Warnings node={node} />}
        </div>
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
          {t("rawResponse")}
        </summary>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap break-words text-muted">
          {JSON.stringify(check.result, null, 2)}
        </pre>
      </details>
    </Card>
  );
}
