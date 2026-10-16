"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CalendarClock, EyeOff } from "lucide-react";
import {
  FIELD_TYPES,
  DIDIT_FEATURES,
  INTERNAL_ROLES,
  DIDIT_FEATURE_COMPAT,
  getLoc,
  isChoiceType,
  isDiditCompatible,
  KYB_COUNTRY_RES,
  newField,
  newSection,
  resolveText,
  setLoc,
  type Condition,
  type ConditionOp,
  type Field,
  type FieldExpiry,
  type FieldReview,
  type FieldType,
  type FormDefinition,
  type FormStatus,
  type InternalFields,
  type InternalRole,
  type LocalizedText,
  type Section,
} from "@/lib/forms/definition";
import {
  internalRoleFor,
  internalRoleOf,
  mayBeSkipped,
  setInternalRole,
} from "@/lib/forms/internalFields";
import {
  canUseDiditExpiry,
  expiryDateLinks,
  expiryWarnings,
  type ExpiryWarning,
} from "@/lib/forms/expiry";
import { normalizeFormDefinition } from "@/lib/forms/normalize";
import {
  applyTranslations,
  coverage,
  fieldPath,
  FORM_SCOPE,
  isMachineTranslated,
  markHuman,
  optionPath,
  PATH_TITLE,
  renameProvenance,
  sectionPath,
  type Coverage,
} from "@/lib/i18n-ai/walk";
import type { TranslateResult } from "@/lib/i18n-ai/provider";
import { formatCost, formatTokens } from "@/lib/i18n-ai/pricing";
import {
  FIELD_PRESETS,
  presetCategories,
  buildInsertFields,
  type FieldPreset,
  type PresetCategory,
} from "@/lib/forms/presets";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { DynamicForm } from "@/components/forms/DynamicForm";
import { ImageUpload } from "@/components/forms/ImageUpload";
import { archiveForm, saveForm, setFormStatus, deleteForm, formUsage } from "../../actions";
import { formActionError } from "../../formErrors";

// ---------- helpers de LocalizedText ----------
// `getLoc`/`setLoc` viven en lib/forms/definition.ts: los comparte el walker de
// traducción (lib/i18n-ai/walk.ts) para que "vacío en este locale" signifique lo
// mismo en el editor y en la medición de cobertura.

/**
 * Escribe un texto por edición MANUAL: además de `setLoc`, borra el rastro de
 * IA del path. Así el badge `auto` desaparece al corregir y un re-pase en modo
 * "solo faltantes" respeta lo que revisó una persona.
 */
function writeLoc(
  d: FormDefinition,
  path: string,
  locale: string,
  current: LocalizedText | undefined,
  value: string,
): Record<string, string> {
  markHuman(d, path, locale);
  return setLoc(current, locale, value, d.defaultLocale || "es");
}

/**
 * Marca visual de traducción automática sin revisar. `align="top"` para
 * textareas, donde centrar verticalmente quedaría flotando en el medio.
 */
function AutoTag({
  show,
  tip,
  align = "center",
}: {
  show: boolean;
  tip: string;
  align?: "center" | "top";
}) {
  if (!show) return null;
  return (
    <span
      title={tip}
      className={`pointer-events-none absolute right-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-wide text-warning uppercase ${
        align === "top" ? "top-2" : "top-1/2 -translate-y-1/2"
      }`}
    >
      auto
    </span>
  );
}

/** Reserva espacio a la derecha del input para que el badge no tape el texto. */
const autoPad = (auto: boolean) => (auto ? " pr-14" : "");

/**
 * Contexto i18n que bajan las tarjetas. Va junto a propósito: `src` debe ser el
 * MISMO locale de origen que usa lib/i18n-ai/walk.ts, o el indicador de
 * cobertura diría una cosa y el input mostraría otra.
 */
type I18nCtx = {
  /** Locale de origen del formulario (`def.defaultLocale`). */
  src: string;
  /** ¿El texto de este path lo puso la IA y nadie lo revisó? */
  isAuto: (path: string) => boolean;
};

/** Cierre automático del resumen de traducción. */
const TOAST_MS = 10_000;

/** Contabilidad que devuelve el endpoint por cada llamada (ver lib/i18n-ai/usage.ts). */
type Accounted = {
  inputTokens: number;
  outputTokens: number;
  inputPer1M: number | null;
  outputPer1M: number | null;
  cost: number | null;
  currency: string;
  model: string;
  provider: string;
};

/** Resumen de una corrida completa, para el popup de cierre. */
type RunSummary = {
  to: string;
  scopeLabel: string;
  sections: number;
  translated: number;
  requested: number;
  unanswered: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  inputPer1M: number | null;
  outputPer1M: number | null;
  currency: string;
  model: string;
  provider: string;
};

/** Alcance de la traducción: todo el formulario o solo la sección visible. */
const TRANSLATE_SCOPES = ["form", "section"] as const;
type TranslateScope = (typeof TRANSLATE_SCOPES)[number];

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-brand focus:ring-2 focus:ring-brand/30";
const smallInput =
  "rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground outline-none focus:border-brand";
// Selects con etiquetas largas (preguntas/opciones): acotados para no desbordar.
const smallSelect = `${smallInput} min-w-0 max-w-[12rem] truncate`;

export function FormBuilder({
  id,
  initialName,
  initialStatus,
  initialDef,
}: {
  id: string;
  initialName: string;
  initialStatus: FormStatus;
  initialDef: FormDefinition;
}) {
  const t = useTranslations("builder");
  // Los mensajes de rechazo de archivar/eliminar viven en "forms": son los
  // mismos que muestra la lista y no tiene sentido duplicarlos por namespace.
  const tForms = useTranslations("forms");
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [def, setDef] = useState<FormDefinition>(initialDef);
  const [status, setStatus] = useState(initialStatus);
  const [locale, setActiveLocale] = useState(def.defaultLocale || "es");
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerPresetId, setPickerPresetId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState(0);
  const [showTranslate, setShowTranslate] = useState(false);
  const [translateScope, setTranslateScope] = useState<TranslateScope>("form");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    // Por defecto la confirmación es destructiva (borrar sección/pregunta/form);
    // archivar la reusa con otro botón y sin el tono rojo.
    confirmLabel?: string;
    danger?: boolean;
    resolve: (v: boolean) => void;
  } | null>(null);
  function askConfirm(
    message: string,
    opts?: { confirmLabel?: string; danger?: boolean },
  ): Promise<boolean> {
    return new Promise((resolve) => setConfirmState({ message, ...opts, resolve }));
  }

  function update(mut: (d: FormDefinition) => void) {
    setDef((prev) => {
      const d = structuredClone(prev);
      mut(d);
      // Tras CUALQUIER cambio: borrar la pregunta marcada, cambiarle el tipo o
      // desmarcar "Obligatoria" no deja los roles internos ni el control de
      // vencimiento en un estado inválido.
      normalizeFormDefinition(d);
      return d;
    });
  }

  async function onSave() {
    setBusy(true);
    setMsg(null);
    const res = await saveForm(id, { name, definition: def });
    setBusy(false);
    setMsg(
      !res.ok
        ? res.error
        : res.revision
          ? t("savedRevision", { revision: res.revision })
          : t("saved"),
    );
    if (res.ok) router.refresh();
  }

  async function onTogglePublish() {
    const next = status === "published" ? "draft" : "published";
    const res = await setFormStatus(id, next);
    if (res.ok) {
      setStatus(next);
      // Avisar (sin bloquear) si se publica con locales a medio traducir:
      // `resolveText` cae al locale por defecto en silencio, así que un hueco
      // no se nota en pantalla pero sale a producción.
      const gaps = targetLocales
        .map((l) => ({ l, c: coverage(def, l) }))
        .filter((x) => x.c.missing > 0);
      if (next === "published" && gaps.length) {
        setMsg(
          `${t("published")} — ${gaps
            .map((g) => `${g.l.toUpperCase()} ${g.c.percent}% (${g.c.missing} ${t("coverageMissing")})`)
            .join(", ")}`,
        );
      } else setMsg(next === "published" ? t("published") : t("unpublished"));
    } else setMsg(res.error);
  }

  async function onArchive() {
    const next = status !== "archived";
    if (
      next &&
      !(await askConfirm(t("confirmArchive"), {
        confirmLabel: t("archive"),
        danger: false,
      }))
    ) {
      return;
    }
    setBusy(true);
    const res = await archiveForm(id, next);
    setBusy(false);
    if (!res.ok) {
      setMsg(formActionError(tForms, res));
      return;
    }
    // Desarchivar devuelve a borrador, no al estado publicado anterior.
    setStatus(next ? "archived" : "draft");
    setMsg(next ? t("archived") : t("unarchived"));
    router.refresh();
  }

  /**
   * Borrado definitivo. Consulta primero de qué depende el formulario para
   * poder rechazarlo con un motivo concreto y, si procede, decir en la
   * confirmación cuántas solicitudes van a quedar desvinculadas.
   */
  async function onDelete() {
    setBusy(true);
    const usage = await formUsage(id);
    setBusy(false);
    if (!usage.canDelete) {
      setMsg(
        usage.clients.length > 0
          ? tForms("errorAssignedToClient", { clients: usage.clients.join(", ") })
          : tForms("errorRequestsNoSnapshot", { count: usage.requestsWithoutSnapshot }),
      );
      return;
    }
    const question =
      usage.requests > 0
        ? t("confirmDeleteWithRequests", { count: usage.requests })
        : t("confirmDelete");
    if (!(await askConfirm(question))) return;

    setBusy(true);
    const res = await deleteForm(id);
    setBusy(false);
    if (!res.ok) {
      setMsg(formActionError(tForms, res));
      return;
    }
    router.push("/admin/forms");
  }

  // Índice de la sección visible; acotado por si se borró la última.
  const activeIdx = Math.min(Math.max(activeSection, 0), Math.max(def.sections.length - 1, 0));

  // ---------- Traducción con IA ----------
  /**
   * Manda una definición recortada al scope pedido: el endpoint solo necesita
   * esa sección para extraer textos y armar el contexto, así no viaja el
   * formulario entero (que puede pesar >100 KB) en cada una de las N llamadas.
   */
  function scopeDefinition(scope: string): FormDefinition {
    return {
      ...def,
      sections: scope === FORM_SCOPE ? [] : def.sections.filter((s) => s.id === scope),
    };
  }

  async function onTranslate(to: string, force: boolean, scope: TranslateScope) {
    setShowTranslate(false);
    setMsg(null);

    // "section" traduce solo la sección visible. "form" agrega FORM_SCOPE, que
    // cubre el título del formulario — no cuelga de ninguna sección.
    const active = def.sections[activeIdx];
    const scopes =
      scope === "section"
        ? active
          ? [active.id]
          : []
        : [FORM_SCOPE, ...def.sections.map((s) => s.id)];
    if (scopes.length === 0) {
      setMsg(t("translateNothing"));
      return;
    }
    setTranslating({ done: 0, total: scopes.length });
    setSummary(null);

    let requested = 0;
    let unanswered = 0;
    let failed = 0;
    const at = new Date().toISOString();

    // Un `runId` por corrida: agrupa en el registro las N llamadas por sección
    // como UNA operación, que es como la vive el usuario.
    const runId = crypto.randomUUID();
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      hasCost: false,
      model: "",
      provider: "",
      inputPer1M: null as number | null,
      outputPer1M: null as number | null,
      currency: "USD",
    };

    // Pool de 3. La concurrencia real es posible porque el endpoint es un Route
    // Handler: Next 16 serializa las Server Actions por cliente.
    let cursor = 0;
    const worker = async () => {
      while (cursor < scopes.length) {
        const scope = scopes[cursor++];
        try {
          const res = await fetch("/api/admin/forms/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              definition: scopeDefinition(scope),
              sectionId: scope,
              to,
              force,
              runId,
              formId: id,
            }),
          });
          const data = (await res.json()) as {
            results?: TranslateResult[];
            requested?: number;
            missing?: number;
            model?: string;
            error?: string;
            accounted?: Accounted;
          };
          if (!res.ok) {
            failed++;
          } else {
            requested += data.requested ?? 0;
            unanswered += data.missing ?? 0;
            const a = data.accounted;
            if (a) {
              totals.inputTokens += a.inputTokens;
              totals.outputTokens += a.outputTokens;
              if (a.cost != null) {
                totals.cost += a.cost;
                totals.hasCost = true;
              }
              totals.model = a.model;
              totals.provider = a.provider;
              totals.inputPer1M = a.inputPer1M;
              totals.outputPer1M = a.outputPer1M;
              totals.currency = a.currency;
            }
            if (data.results?.length) {
              update((d) => applyTranslations(d, data.results!, { to, model: data.model, at }));
            }
          }
        } catch {
          failed++;
        }
        setTranslating((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(3, scopes.length) }, () => worker()),
    );

    setTranslating(null);
    setActiveLocale(to);

    if (requested === 0 && failed === 0) {
      setMsg(t("translateNothing"));
      return;
    }
    // Con scope de sección se nombra cuál: el mensaje no debe leerse como si
    // se hubiera traducido el formulario entero (el título sigue sin tocar).
    const scopeLabel =
      scope === "section" && active
        ? `${resolveText(active.title, locale) || `${t("section")} ${activeIdx + 1}`} — `
        : "";
    const parts = [`${scopeLabel}${t("translateDone")}: ${requested - unanswered}/${requested}`];
    if (unanswered) parts.push(`${unanswered} ${t("translateUnanswered")}`);
    if (failed) parts.push(`${failed} ${t("translateFailedSections")}`);
    parts.push(t("translateReviewHint"));
    setMsg(parts.join(" · "));

    setSummary({
      to,
      scopeLabel: scopeLabel.replace(/ — $/, ""),
      sections: scopes.length,
      translated: requested - unanswered,
      requested,
      unanswered,
      failed,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cost: totals.hasCost ? totals.cost : null,
      inputPer1M: totals.inputPer1M,
      outputPer1M: totals.outputPer1M,
      currency: totals.currency,
      model: totals.model,
      provider: totals.provider,
    });
  }

  function onExport() {
    const blob = new Blob([JSON.stringify(def, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "form"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function insertPreset(presetId: string, selected: string[], target: string) {
    const preset = FIELD_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const existingKeys = def.sections.flatMap((s) => s.fields.map((f) => f.key));
    const { fields, autoAdded, skipped } = buildInsertFields(preset, selected, existingKeys);
    if (!fields.length) {
      setMsg(t("presetNoneSelected"));
      return;
    }
    update((d) => {
      if (target === "__new__") {
        const s = newSection();
        s.title = preset.label;
        s.fields.push(...fields);
        d.sections.push(s);
        return;
      }
      let idx = d.sections.findIndex((x) => x.id === target);
      if (idx === -1) {
        if (d.sections.length === 0) d.sections.push(newSection());
        idx = 0;
      }
      d.sections[idx].fields.push(...fields);
    });
    let m = t("presetInserted");
    if (autoAdded.length) m += ` (+${autoAdded.length} ${t("presetDepsNote")})`;
    if (skipped.length) m += ` — ${t("presetDuplicateKeys")}: ${skipped.join(", ")}`;
    setMsg(m);
    setPickerPresetId(null);
  }

  function moveSection(from: number, to: number) {
    if (from === to) return;
    update((d) => {
      if (from < 0 || to < 0 || from >= d.sections.length || to >= d.sections.length) return;
      const [s] = d.sections.splice(from, 1);
      d.sections.splice(to, 0, s);
    });
    setActiveSection(to);
  }

  // Preguntas con rol interno: su sección y etiqueta (resumen de la tarjeta de
  // identidad) y la marca que muestra el preview. El solicitante no ve ninguna.
  const internalRefs = INTERNAL_ROLES.flatMap((role) => {
    const id = def.internalFields?.[role];
    for (const [si, s] of def.sections.entries()) {
      const f = s.fields.find((x) => x.id === id);
      if (f) return [{ role, id: f.id, si, label: resolveText(f.label, locale) || f.key }];
    }
    return [];
  });
  const internalMarks = Object.fromEntries(
    internalRefs.map((r) => [r.id, t(`internalRole_${r.role}`)]),
  );

  const allFieldKeys = def.sections.flatMap((s) =>
    s.fields.map((f) => ({ key: f.key, label: resolveText(f.label, locale) || f.key, field: f })),
  );

  // ---------- i18n: locale de origen, cobertura y procedencia ----------
  const srcLocale = def.defaultLocale || "es";
  const targetLocales = def.locales.filter((l) => l !== srcLocale);
  /** Cobertura del locale que se está editando (null si es el de origen). */
  const cov: Coverage | null = locale === srcLocale ? null : coverage(def, locale);
  const i18nCtx: I18nCtx = {
    src: srcLocale,
    isAuto: (path) => locale !== srcLocale && isMachineTranslated(def, path, locale),
  };

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1
          className={`min-w-0 max-w-md truncate font-display text-xl font-bold ${
            name.trim() ? "text-foreground" : "text-muted"
          }`}
          title={name}
        >
          {name.trim() || t("formName")}
        </h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            status === "published"
              ? "bg-success/15 text-success"
              : status === "archived"
                ? "bg-warning/15 text-warning"
                : "bg-surface-2 text-muted"
          }`}
        >
          {t(status)}
        </span>
        {status === "published" && (
          <a
            href={`/forms/${id}`}
            target="_blank"
            rel="noopener"
            className="text-xs font-medium text-brand hover:underline"
          >
            {t("viewPublic")}
          </a>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Cobertura del locale activo: hace visible lo que `resolveText`
              esconde al caer al locale de origen. */}
          {cov && (
            <span
              className={`text-xs font-medium ${
                cov.missing > 0 ? "text-warning" : "text-success"
              }`}
              title={
                cov.machine > 0
                  ? `${cov.machine} ${t("coverageMachine")}`
                  : undefined
              }
            >
              {locale.toUpperCase()} {cov.percent}%
              {cov.missing > 0 && ` · ${cov.missing} ${t("coverageMissing")}`}
              {cov.machine > 0 && ` · ${cov.machine} auto`}
            </span>
          )}
          {/* Locale tabs */}
          <div className="flex overflow-hidden rounded-lg border border-border">
            {def.locales.map((l) => (
              <button
                key={l}
                onClick={() => setActiveLocale(l)}
                className={`px-2.5 py-1 text-xs font-medium ${
                  locale === l ? "bg-brand text-white" : "bg-surface text-muted"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          {targetLocales.length > 0 && (
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(translating)}
                onClick={() => setShowTranslate((v) => !v)}
              >
                {translating
                  ? `${t("translating")} ${translating.done}/${translating.total}`
                  : `${t("translate")} ▾`}
              </Button>
              {showTranslate && (
                <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-surface-card p-1 shadow-lg">
                  {/* El alcance aplica a las dos acciones de abajo: así el menú
                      no se duplica por cada idioma destino. */}
                  <div className="mb-1 flex overflow-hidden rounded-md border border-border">
                    {TRANSLATE_SCOPES.map((s) => (
                      <button
                        key={s}
                        disabled={s === "section" && def.sections.length === 0}
                        onClick={() => setTranslateScope(s)}
                        className={`flex-1 px-2 py-1 text-[11px] font-medium disabled:opacity-40 ${
                          translateScope === s
                            ? "bg-brand text-white"
                            : "bg-surface text-muted hover:bg-surface-2"
                        }`}
                      >
                        {s === "form" ? t("translateScopeForm") : t("translateScopeSection")}
                      </button>
                    ))}
                  </div>
                  {targetLocales.map((l) => (
                    <Fragment key={l}>
                      <button
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-surface-2"
                        onClick={() => onTranslate(l, false, translateScope)}
                      >
                        {t("translateMissing")} → {l.toUpperCase()}
                      </button>
                      <button
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-2"
                        onClick={() => onTranslate(l, true, translateScope)}
                      >
                        {t("translateForce")} → {l.toUpperCase()}
                      </button>
                    </Fragment>
                  ))}
                  <p className="border-t border-border px-2 pt-1.5 pb-1 text-[11px] leading-snug text-muted">
                    {translateScope === "section" && def.sections[activeIdx] && (
                      <span className="block font-medium text-foreground">
                        {activeIdx + 1}.{" "}
                        {resolveText(def.sections[activeIdx].title, locale) ||
                          `${t("section")} ${activeIdx + 1}`}
                      </span>
                    )}
                    {t("translateHint")}
                  </p>
                </div>
              )}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
            {preview ? t("edit") : t("preview")}
          </Button>
          <Button variant="outline" size="sm" onClick={onExport}>
            {t("exportJson")}
          </Button>
          {/* Un formulario archivado no se publica desde acá: primero se
              desarchiva (vuelve a borrador) y recién ahí se publica. */}
          {status !== "archived" && (
            <Button variant="outline" size="sm" onClick={onTogglePublish}>
              {status === "published" ? t("unpublish") : t("publish")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onArchive} disabled={busy}>
            {status === "archived" ? t("unarchive") : t("archive")}
          </Button>
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy ? "…" : t("save")}
          </Button>
        </div>
      </div>
      {msg && <p className="mb-3 text-sm text-muted">{msg}</p>}

      {preview ? (
        <div className="mx-auto max-w-2xl">
          {/* Mismo encabezado que la página pública /forms/[id]. */}
          <h2 className="mb-4 font-display text-2xl font-bold text-foreground">
            {resolveText(def.title, locale)}
          </h2>
          <DynamicForm
            definition={def}
            locale={locale}
            mode="preview"
            internalMarks={internalMarks}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Identidad del formulario: el nombre interno (panel, filtros) y el
              título que ve el solicitante, que se traduce como el resto. */}
          <div className="grid gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm md:grid-cols-2">
            <div>
              <label
                htmlFor="form-internal-name"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                {t("internalName")}
              </label>
              <input
                id="form-internal-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder={t("formName")}
              />
              <p className="mt-1 text-xs text-muted">{t("internalNameHint")}</p>
            </div>
            <div>
              <label
                htmlFor="form-public-title"
                className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground"
              >
                {t("publicTitle")}
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] leading-none font-semibold text-muted uppercase">
                  {locale}
                </span>
              </label>
              <div className="relative">
                <input
                  id="form-public-title"
                  className={inputCls + autoPad(i18nCtx.isAuto(PATH_TITLE))}
                  placeholder={t("publicTitle")}
                  value={getLoc(def.title, locale, srcLocale)}
                  onChange={(e) =>
                    update((d) => {
                      d.title = writeLoc(d, PATH_TITLE, locale, d.title, e.target.value);
                    })
                  }
                />
                <AutoTag show={i18nCtx.isAuto(PATH_TITLE)} tip={t("autoTip")} />
              </div>
              <p className="mt-1 text-xs text-muted">{t("publicTitleHint")}</p>
            </div>
            {/* Roles internos: qué pregunta da el título y cuál el email de
                contacto. Clic → la sección de la pregunta. */}
            <div className="border-t border-border pt-3 md:col-span-2">
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <EyeOff size={14} aria-hidden />
                  {t("internalUse")}
                </span>
                {INTERNAL_ROLES.map((role) => {
                  const ref = internalRefs.find((r) => r.role === role);
                  return (
                    <span key={role} className="min-w-0 text-muted">
                      {t(`internalRole_${role}`)}:{" "}
                      {ref ? (
                        <button
                          type="button"
                          className="max-w-[16rem] truncate align-bottom font-medium text-brand hover:underline"
                          title={ref.label}
                          onClick={() => setActiveSection(ref.si)}
                        >
                          {ref.label}
                        </button>
                      ) : (
                        <span className="italic">{t("internalNone")}</span>
                      )}
                    </span>
                  );
                })}
              </p>
              <p className="mt-1 text-xs text-muted">{t("internalUseHint")}</p>
            </div>
          </div>

          {/* Selector de packs de campos prearmados */}
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-border bg-surface-2/40 p-3">
            <span className="text-xs font-semibold uppercase text-muted">
              {t("addPreset")}
            </span>
            <select
              className={smallInput}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                e.currentTarget.value = "";
                if (v) setPickerPresetId(v);
              }}
            >
              <option value="">{t("presetPlaceholder")}</option>
              {FIELD_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {resolveText(p.label, locale)}
                </option>
              ))}
            </select>
          </div>
          {pickerPresetId && (
            <PresetPicker
              key={pickerPresetId}
              preset={FIELD_PRESETS.find((p) => p.id === pickerPresetId)!}
              sections={def.sections}
              locale={locale}
              t={t}
              onCancel={() => setPickerPresetId(null)}
              onInsert={(selected, target) => insertPreset(pickerPresetId, selected, target)}
            />
          )}
          {/* Paginador de secciones (clic para ver, arrastrar para reordenar) */}
          {def.sections.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {def.sections.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  draggable
                  onClick={() => setActiveSection(i)}
                  onDragStart={() => {
                    dragFrom.current = i;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(i);
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null) moveSection(dragFrom.current, i);
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  title={resolveText(s.title, locale) || `${t("section")} ${i + 1}`}
                  className={`h-9 min-w-9 cursor-grab rounded-lg border px-2 text-sm font-medium transition-colors active:cursor-grabbing ${
                    i === activeIdx
                      ? "border-brand bg-brand text-white"
                      : "border-border bg-surface text-foreground hover:bg-surface-2"
                  } ${dragOver === i ? "ring-2 ring-brand/50" : ""}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}

          {def.sections[activeIdx] && (
            <SectionCard
              key={def.sections[activeIdx].id}
              section={def.sections[activeIdx]}
              index={activeIdx}
              total={def.sections.length}
              locale={locale}
              allFieldKeys={allFieldKeys}
              sections={def.sections}
              internalFields={def.internalFields}
              t={t}
              update={update}
              onMove={moveSection}
              askConfirm={askConfirm}
              i18n={i18nCtx}
            />
          )}
          <Button
            variant="outline"
            onClick={() => {
              const n = def.sections.length;
              update((d) => d.sections.push(newSection()));
              setActiveSection(n);
            }}
          >
            + {t("addSection")}
          </Button>

          <div className="pt-4">
            <button
              type="button"
              disabled={busy}
              className="text-sm text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              onClick={onDelete}
            >
              {t("deleteForm")}
            </button>
            <p className="mt-1 text-xs text-muted">{t("deleteFormHint")}</p>
          </div>
        </div>
      )}
      {summary && (
        <TranslationSummaryToast summary={summary} t={t} onClose={() => setSummary(null)} />
      )}
      {confirmState && (
        <ConfirmModal
          body={confirmState.message}
          confirmLabel={confirmState.confirmLabel ?? t("delete")}
          cancelLabel={t("cancel")}
          danger={confirmState.danger ?? true}
          onConfirm={() => {
            confirmState.resolve(true);
            setConfirmState(null);
          }}
          onCancel={() => {
            confirmState.resolve(false);
            setConfirmState(null);
          }}
        />
      )}
    </main>
  );

  // ----- render helpers use closures over update/locale -----
}

type TFn = ReturnType<typeof useTranslations>;
type KeyInfo = { key: string; label: string; field: Field };

// ---------- Picker de campos prearmados ----------
function PresetPicker({
  preset,
  sections,
  locale,
  t,
  onCancel,
  onInsert,
}: {
  preset: FieldPreset;
  sections: Section[];
  locale: string;
  t: TFn;
  onCancel: () => void;
  onInsert: (selected: string[], target: string) => void;
}) {
  const categories = useMemo(() => presetCategories(preset), [preset]);
  const existingKeys = useMemo(
    () => sections.flatMap((s) => s.fields.map((f) => f.key)),
    [sections],
  );
  const existingSet = useMemo(() => new Set(existingKeys), [existingKeys]);
  const isEmpty =
    sections.length === 0 || (sections.length === 1 && sections[0].fields.length === 0);

  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<string>(sections[0]?.id ?? "__new__");

  const preview = useMemo(
    () => buildInsertFields(preset, selected, existingKeys),
    [preset, selected, existingKeys],
  );

  function toggle(key: string) {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  }
  function toggleCategory(cat: PresetCategory) {
    const keys = cat.items.map((i) => i.key).filter((k) => !existingSet.has(k));
    const allOn = keys.length > 0 && keys.every((k) => selected.includes(k));
    setSelected((s) =>
      allOn ? s.filter((k) => !keys.includes(k)) : Array.from(new Set([...s, ...keys])),
    );
  }

  return (
    <div className="rounded-2xl border border-brand/40 bg-surface-card p-4 shadow-md ring-1 ring-brand/10">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold">
          {t("addPreset")}: {resolveText(preset.label, locale)}
        </span>
        <button onClick={onCancel} className="ml-auto text-sm text-muted hover:underline">
          {t("presetCancel")}
        </button>
      </div>

      <div className="space-y-3">
        {categories.map((cat) => {
          const keys = cat.items.map((i) => i.key).filter((k) => !existingSet.has(k));
          const allOn = keys.length > 0 && keys.every((k) => selected.includes(k));
          const someOn = keys.some((k) => selected.includes(k));
          return (
            <div key={cat.id} className="rounded-xl border border-border bg-surface p-3">
              <label className="mb-2 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn && !allOn;
                  }}
                  disabled={keys.length === 0}
                  onChange={() => toggleCategory(cat)}
                />
                {resolveText(cat.label, locale)}
              </label>
              <div className="grid gap-1 sm:grid-cols-2">
                {cat.items.map((it) => {
                  const exists = existingSet.has(it.key);
                  return (
                    <label
                      key={it.key}
                      className={`flex items-center gap-2 text-xs ${exists ? "opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="accent-brand"
                        checked={exists || selected.includes(it.key)}
                        disabled={exists}
                        onChange={() => toggle(it.key)}
                      />
                      <span className="truncate">{resolveText(it.label, locale) || it.key}</span>
                      {exists && <span className="text-muted">({t("presetAlreadyExists")})</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {isEmpty ? (
          <span className="text-xs text-muted">{t("presetEmptyTargetHint")}</span>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted">
            {t("presetTarget")}
            <select className={smallInput} value={target} onChange={(e) => setTarget(e.target.value)}>
              {sections.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {resolveText(s.title, locale) || t("section")}
                </option>
              ))}
              <option value="__new__">{t("presetNewSection")}</option>
            </select>
          </label>
        )}
        <span className="text-xs text-muted">
          {selected.length} {t("presetSelectedCount")}
          {preview.autoAdded.length > 0 && ` · +${preview.autoAdded.length} ${t("presetDepsNote")}`}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={preview.fields.length === 0}
          onClick={() => onInsert(selected, isEmpty ? (sections[0]?.id ?? "__new__") : target)}
        >
          {t("presetInsertSelected")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Resumen de la corrida de traducción. Anclado abajo a la derecha y NO modal:
 * el analista puede seguir revisando lo que se acaba de traducir mientras lo
 * lee. Se cierra a mano o solo a los 10 s.
 */
function TranslationSummaryToast({
  summary,
  t,
  onClose,
}: {
  summary: RunSummary;
  t: TFn;
  onClose: () => void;
}) {
  useEffect(() => {
    const id = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(id);
  }, [onClose]);

  const rate =
    summary.inputPer1M != null && summary.outputPer1M != null
      ? `${formatCost(summary.inputPer1M, summary.currency)} / 1M in · ${formatCost(
          summary.outputPer1M,
          summary.currency,
        )} / 1M out`
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 w-72 rounded-2xl border border-border bg-surface-card p-4 shadow-xl"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          {t("translate")} → {summary.to.toUpperCase()}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("cancel")}
          className="-mt-0.5 text-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {summary.scopeLabel && (
        <p className="mb-1 truncate text-xs text-muted">{summary.scopeLabel}</p>
      )}

      <p className="text-xs text-foreground">
        {summary.translated}/{summary.requested} {t("summaryTexts")} · {summary.sections}{" "}
        {t("summaryCalls")}
      </p>
      {summary.unanswered > 0 && (
        <p className="text-xs text-warning">
          {summary.unanswered} {t("translateUnanswered")}
        </p>
      )}
      {summary.failed > 0 && (
        <p className="text-xs text-danger">
          {summary.failed} {t("translateFailedSections")}
        </p>
      )}

      <div className="mt-3 border-t border-border pt-2 text-xs text-muted">
        <p className="font-medium text-foreground">{summary.model}</p>
        <p>
          {formatTokens(summary.inputTokens)} {t("summaryIn")} ·{" "}
          {formatTokens(summary.outputTokens)} {t("summaryOut")}
        </p>
        {rate && <p className="mt-0.5">{rate}</p>}
        {summary.cost != null ? (
          <p className="mt-1 text-sm font-semibold text-foreground">
            ≈ {formatCost(summary.cost, summary.currency)}{" "}
            <span className="text-xs font-normal text-muted">({t("summaryEstimated")})</span>
          </p>
        ) : (
          <p className="mt-1 text-sm font-semibold text-foreground">{t("summaryNoCost")}</p>
        )}
      </div>
    </div>
  );
}

// Select "+ Agregar campo": reutilizable debajo de cada pregunta y en secciones vacías.
function AddFieldSelect({ t, onAdd }: { t: TFn; onAdd: (type: FieldType) => void }) {
  return (
    <select
      className={smallInput}
      value=""
      onChange={(e) => {
        const type = e.target.value as FieldType;
        if (type) onAdd(type);
        e.target.value = "";
      }}
    >
      <option value="">+ {t("addField")}</option>
      {FIELD_TYPES.map((ft) => (
        <option key={ft} value={ft}>
          {t(`type_${ft}`)}
        </option>
      ))}
    </select>
  );
}

function SectionCard({
  section,
  index,
  total,
  locale,
  allFieldKeys,
  sections,
  internalFields,
  t,
  update,
  onMove,
  askConfirm,
  i18n,
}: {
  section: Section;
  index: number;
  total: number;
  locale: string;
  allFieldKeys: KeyInfo[];
  sections: Section[];
  internalFields: InternalFields | undefined;
  t: TFn;
  update: (mut: (d: FormDefinition) => void) => void;
  onMove: (from: number, to: number) => void;
  askConfirm: (message: string) => Promise<boolean>;
  i18n: I18nCtx;
}) {
  const titlePath = sectionPath(section.id, "title");
  const descPath = sectionPath(section.id, "desc");
  const expiryLinks = expiryDateLinks({ sections });
  const expiryWarns = expiryWarnings({ sections });
  return (
    <div className="rounded-2xl border border-border bg-surface-card p-4 shadow-md ring-1 ring-black/5 dark:ring-white/10">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase text-muted">
          {t("section")} {index + 1}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn
            label="↑"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          />
          <IconBtn
            label="↓"
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
          />
          <IconBtn
            label="✕"
            danger
            onClick={async () => {
              if (await askConfirm(t("confirmDeleteSection")))
                update((d) => d.sections.splice(index, 1));
            }}
          />
        </div>
      </div>

      <div className="relative">
        <input
          className={inputCls + autoPad(i18n.isAuto(titlePath))}
          placeholder={t("sectionTitle")}
          value={getLoc(section.title, locale, i18n.src)}
          onChange={(e) =>
            update((d) => {
              d.sections[index].title = writeLoc(
                d,
                titlePath,
                locale,
                d.sections[index].title,
                e.target.value,
              );
            })
          }
        />
        <AutoTag show={i18n.isAuto(titlePath)} tip={t("autoTip")} />
      </div>
      <div className="relative mt-2">
        <input
          className={inputCls + autoPad(i18n.isAuto(descPath))}
          placeholder={t("sectionDescription")}
          value={getLoc(section.description, locale, i18n.src)}
          onChange={(e) =>
            update((d) => {
              d.sections[index].description = writeLoc(
                d,
                descPath,
                locale,
                d.sections[index].description,
                e.target.value,
              );
            })
          }
        />
        <AutoTag show={i18n.isAuto(descPath)} tip={t("autoTip")} />
      </div>

      {/* visibleIf de sección */}
      <ConditionRow
        label={t("showSectionIf")}
        condition={section.visibleIf}
        fieldKeys={allFieldKeys}
        locale={locale}
        t={t}
        onChange={(c) => update((d) => (d.sections[index].visibleIf = c))}
      />

      {/* Campos */}
      <div className="mt-4 space-y-3">
        {section.fields.map((field, fi) => (
          <Fragment key={field.id}>
            <FieldCard
              field={field}
              si={index}
              fi={fi}
              fieldCount={section.fields.length}
              locale={locale}
              allFieldKeys={allFieldKeys}
              t={t}
              update={update}
              askConfirm={askConfirm}
              i18n={i18n}
              sectionId={section.id}
              role={internalRoleOf(internalFields, field.id)}
              skippable={mayBeSkipped(sections, index, field)}
              expiryOf={expiryLinks.get(field.id) ?? null}
              expiryWarnings={expiryWarns.get(field.id) ?? []}
            />
            {/* Insertar una pregunta justo debajo de esta */}
            <AddFieldSelect
              t={t}
              onAdd={(type) =>
                update((d) => d.sections[index].fields.splice(fi + 1, 0, newField(type)))
              }
            />
          </Fragment>
        ))}
      </div>

      {section.fields.length === 0 && (
        <div className="mt-3 flex items-center gap-2">
          <AddFieldSelect
            t={t}
            onAdd={(type) => update((d) => d.sections[index].fields.push(newField(type)))}
          />
        </div>
      )}

      {/* Saltos de sección */}
      <NavRulesEditor
        section={section}
        si={index}
        sections={sections}
        fieldKeys={allFieldKeys}
        locale={locale}
        t={t}
        update={update}
      />
    </div>
  );
}

// ---------- Editor de revisión DIDIT (popover por campo) ----------

/** ⓘ con tooltip CSS-only (hover + focus de teclado). */
function InfoTip({ text }: { text: string }) {
  return (
    <span tabIndex={0} className="group relative inline-flex shrink-0 items-center outline-none">
      <span
        aria-hidden
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] leading-none text-muted group-hover:border-brand group-hover:text-brand group-focus-visible:border-brand group-focus-visible:text-brand"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 bottom-full z-30 mb-1 hidden w-56 rounded-lg border border-border bg-surface-card p-2 text-left text-[11px] font-normal whitespace-normal text-foreground shadow-lg group-hover:block group-focus-visible:block"
      >
        {text}
      </span>
    </span>
  );
}

function DiditReviewEditor({
  field,
  imageFields,
  kybCountryFields,
  kybRegNumberFields,
  hasCountryCandidate,
  kybFirstTaggedKey,
  t,
  onChange,
}: {
  field: Field;
  imageFields: { key: string; label: string }[];
  /** Candidatas para el binding explícito de kyb_registry. */
  kybCountryFields: { key: string; label: string }[];
  kybRegNumberFields: { key: string; label: string; type: FieldType }[];
  /** ¿El form puede resolver el país sin binding (tipo país o convención de key)? */
  hasCountryCandidate: boolean;
  /** Key de la PRIMERA pregunta del form etiquetada kyb_registry (o null). */
  kybFirstTaggedKey: string | null;
  t: TFn;
  onChange: (review: FieldReview | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = field.review?.feature;
  const compatible = current ? isDiditCompatible(current, field.type) : true;
  // kyb_registry sin país resoluble (ni binding ni candidata) no puede correr.
  const kybCountryOk =
    current !== "kyb_registry" || Boolean(field.review?.kybCountryKey) || hasCountryCandidate;
  // Solo se ejecuta la PRIMERA pregunta etiquetada kyb_registry del formulario;
  // cualquier tag adicional queda inerte → advertir.
  const kybDuplicate =
    current === "kyb_registry" && kybFirstTaggedKey !== null && kybFirstTaggedKey !== field.key;
  // Un campo `number` se guarda como número: pierde los ceros a la izquierda
  // del n.º de registro y deja de coincidir con el del registro mercantil.
  const kybRegNumberIsNumber =
    current === "kyb_registry" &&
    kybRegNumberFields.find((f) => f.key === field.review?.kybRegNumberKey)?.type === "number";
  const healthy = compatible && kybCountryOk && !kybDuplicate && !kybRegNumberIsNumber;

  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
          current
            ? healthy
              ? "border-brand/40 bg-brand/10 text-brand"
              : "border-danger/40 bg-danger/10 text-danger"
            : "border-border bg-surface text-muted hover:bg-surface-2"
        }`}
      >
        {current ? `DIDIT: ${t(`didit_${current}`)}${healthy ? "" : " ⚠"}` : `+ ${t("diditReview")}`}
      </button>
      {/* Requisitos de la revisión aplicada, visibles sin abrir el popover */}
      {current && <InfoTip text={t(`diditReq_${current}`)} />}
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 w-64 rounded-xl border border-border bg-surface-card p-2 shadow-lg ring-1 ring-black/5 dark:ring-white/10">
            <p className="mb-1 px-1 text-xs font-semibold text-muted">{t("diditReview")}</p>
            {current && !compatible && (
              <p className="mb-1 px-1 text-[10px] text-danger">{t("diditIncompatible")}</p>
            )}
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2 ${
                !current ? "font-semibold text-foreground" : "text-muted"
              }`}
            >
              {t("diditNone")}
            </button>
            {DIDIT_FEATURES.map((f) => {
              const ok = isDiditCompatible(f, field.type);
              return (
                // El ⓘ va FUERA del botón: los botones deshabilitados (tipo
                // incompatible) suprimen el hover, y ahí es donde más se
                // necesita leer qué requiere la feature.
                <div key={f} className="flex items-center gap-1 pr-1">
                  <button
                    type="button"
                    disabled={!ok}
                    onClick={() => {
                      const isFace = f === "face_match";
                      onChange({
                        provider: "didit",
                        feature: f,
                        ...(isFace && field.review?.refKeys ? { refKeys: field.review.refKeys } : {}),
                      });
                      if (!isFace) setOpen(false);
                    }}
                    className={`block min-w-0 flex-1 rounded px-2 py-1 text-left text-xs ${
                      ok ? "hover:bg-surface-2" : "cursor-not-allowed opacity-40"
                    } ${current === f ? "font-semibold text-brand" : "text-foreground"}`}
                  >
                    {t(`didit_${f}`)}
                    {!ok && (
                      <span className="mt-0.5 block text-[10px] text-muted">
                        {t("diditRequiresType")}:{" "}
                        {DIDIT_FEATURE_COMPAT[f].map((ty) => t(`type_${ty}`)).join(", ")}
                      </span>
                    )}
                  </button>
                  <InfoTip text={t(`diditReq_${f}`)} />
                </div>
              );
            })}
            {current === "face_match" && (
              <div className="mt-1 border-t border-border pt-1">
                <p className="px-1 text-[10px] font-semibold text-muted">{t("diditRefDoc")}</p>
                <p className="mb-1 px-1 text-[10px] text-muted">{t("diditRefHint")}</p>
                {imageFields.length === 0 ? (
                  <p className="px-1 text-[10px] text-muted">—</p>
                ) : (
                  imageFields.map((im) => {
                    const refKeys = field.review?.refKeys ?? [];
                    const checked = refKeys.includes(im.key);
                    const atMax = !checked && refKeys.length >= 2;
                    return (
                      <label
                        key={im.key}
                        className={`flex items-center gap-2 rounded px-1 py-0.5 text-xs ${
                          atMax ? "opacity-40" : "hover:bg-surface-2"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-brand"
                          checked={checked}
                          disabled={atMax}
                          onChange={() => {
                            const next = checked
                              ? refKeys.filter((k) => k !== im.key)
                              : [...refKeys, im.key];
                            onChange({
                              provider: "didit",
                              feature: "face_match",
                              ...(next.length ? { refKeys: next } : {}),
                            });
                          }}
                        />
                        <span className="truncate">{im.label}</span>
                      </label>
                    );
                  })
                )}
              </div>
            )}
            {current === "kyb_registry" && (
              <div className="mt-1 border-t border-border pt-1">
                {/* Binding explícito de país y nº de registro (prioridad sobre
                    la detección por convención de key). */}
                <p className="px-1 text-[10px] font-semibold text-muted">{t("kybCountryField")}</p>
                <select
                  className={`${smallInput} mt-0.5 w-full`}
                  value={field.review?.kybCountryKey ?? ""}
                  onChange={(e) =>
                    onChange({
                      provider: "didit",
                      feature: "kyb_registry",
                      ...(e.target.value ? { kybCountryKey: e.target.value } : {}),
                      ...(field.review?.kybRegNumberKey
                        ? { kybRegNumberKey: field.review.kybRegNumberKey }
                        : {}),
                    })
                  }
                >
                  <option value="">{t("kybAutoDetect")}</option>
                  {kybCountryFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 px-1 text-[10px] font-semibold text-muted">
                  {t("kybRegNumberField")}
                </p>
                <select
                  className={`${smallInput} mt-0.5 w-full`}
                  value={field.review?.kybRegNumberKey ?? ""}
                  onChange={(e) =>
                    onChange({
                      provider: "didit",
                      feature: "kyb_registry",
                      ...(field.review?.kybCountryKey
                        ? { kybCountryKey: field.review.kybCountryKey }
                        : {}),
                      ...(e.target.value ? { kybRegNumberKey: e.target.value } : {}),
                    })
                  }
                >
                  <option value="">{t("kybAutoDetect")}</option>
                  {kybRegNumberFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {!field.review?.kybCountryKey && !hasCountryCandidate && (
                  <p className="mt-1 px-1 text-[10px] text-danger">{t("kybNoCountryWarning")}</p>
                )}
                {kybDuplicate && (
                  <p className="mt-1 px-1 text-[10px] text-danger">{t("kybDuplicateWarning")}</p>
                )}
                {kybRegNumberIsNumber && (
                  <p className="mt-1 px-1 text-[10px] text-danger">{t("kybRegNumberIsNumber")}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Control de vencimiento (popover por pregunta de archivo) ----------

/**
 * Chip para controlar el vencimiento de un documento. La fecha sale de DIDIT
 * (solo el anverso de un id_verification) o de una pregunta de fecha que
 * responde el solicitante; esa pregunta queda obligatoria.
 */
function ExpiryEditor({
  field,
  dateFields,
  warnings,
  t,
  onChange,
  onAddDateField,
}: {
  field: Field;
  /** Preguntas de fecha del formulario, por id. */
  dateFields: { id: string; label: string }[];
  warnings: ExpiryWarning[];
  t: TFn;
  onChange: (expiry: FieldExpiry | undefined) => void;
  /** Inserta una pregunta de fecha debajo de esta y la enlaza. */
  onAddDateField: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = field.expiry;
  const diditOk = canUseDiditExpiry(field);
  const linked =
    current?.source === "date_field"
      ? dateFields.find((d) => d.id === current.dateFieldId)
      : undefined;
  const healthy = warnings.length === 0;
  const chip = !current
    ? `+ ${t("expiryTrack")}`
    : current.source === "didit"
      ? t("expiryChipDidit")
      : t("expiryChipDate", { label: linked?.label ?? "—" });

  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
          current
            ? healthy
              ? "border-brand/40 bg-brand/10 text-brand"
              : "border-warning/50 bg-warning/10 text-foreground"
            : "border-border bg-surface text-muted hover:bg-surface-2"
        }`}
      >
        <CalendarClock size={12} aria-hidden />
        {chip}
        {healthy ? "" : " ⚠"}
      </button>
      {current && <InfoTip text={t("expiryTip")} />}
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 w-72 rounded-xl border border-border bg-surface-card p-2 shadow-lg ring-1 ring-black/5 dark:ring-white/10">
            <p className="mb-1 px-1 text-xs font-semibold text-muted">{t("expiryTitle")}</p>
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2 ${
                !current ? "font-semibold text-foreground" : "text-muted"
              }`}
            >
              {t("expiryNone")}
            </button>
            <button
              type="button"
              disabled={!diditOk}
              onClick={() => {
                onChange({ source: "didit" });
                setOpen(false);
              }}
              className={`block w-full rounded px-2 py-1 text-left text-xs ${
                diditOk ? "hover:bg-surface-2" : "cursor-not-allowed opacity-50"
              } ${current?.source === "didit" ? "font-semibold text-brand" : "text-foreground"}`}
            >
              {t("expiryDidit")}
              {!diditOk && (
                <span className="mt-0.5 block text-[10px] text-muted">
                  {t("expiryDiditRequires")}
                </span>
              )}
            </button>
            <div className="mt-1 border-t border-border pt-1">
              <p
                className={`px-1 text-xs ${
                  current?.source === "date_field" ? "font-semibold text-brand" : "text-foreground"
                }`}
              >
                {t("expiryDate")}
              </p>
              {dateFields.length === 0 ? (
                <p className="px-1 text-[10px] text-muted">{t("expiryNoDateFields")}</p>
              ) : (
                <select
                  className={`${smallInput} mt-1 w-full`}
                  value={current?.source === "date_field" ? current.dateFieldId : ""}
                  onChange={(e) => {
                    if (e.target.value) {
                      onChange({ source: "date_field", dateFieldId: e.target.value });
                    }
                  }}
                >
                  <option value="">{t("expiryPickDate")}</option>
                  {dateFields.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => {
                  onAddDateField();
                  setOpen(false);
                }}
                className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-brand hover:bg-surface-2"
              >
                + {t("expiryAddDateField")}
              </button>
            </div>
            {warnings.map((w) => (
              <p key={w} className="mt-1 px-1 text-[10px] text-foreground">
                ⚠ {t(`expiryWarn_${w}`)}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FieldCard({
  field,
  si,
  fi,
  fieldCount,
  locale,
  allFieldKeys,
  t,
  update,
  askConfirm,
  i18n,
  sectionId,
  role,
  skippable,
  expiryOf,
  expiryWarnings: expiryWarns,
}: {
  field: Field;
  si: number;
  fi: number;
  fieldCount: number;
  locale: string;
  allFieldKeys: KeyInfo[];
  t: TFn;
  update: (mut: (d: FormDefinition) => void) => void;
  askConfirm: (message: string) => Promise<boolean>;
  i18n: I18nCtx;
  sectionId: string;
  /** Rol interno de la pregunta (título / email de contacto), si lo tiene. */
  role: InternalRole | null;
  /** La pregunta puede quedar sin responder (ver mayBeSkipped). */
  skippable: boolean;
  /** Pregunta de archivo cuyo vencimiento da esta (si es una fecha enlazada). */
  expiryOf: Field | null;
  /** Avisos del control de vencimiento de esta pregunta de archivo. */
  expiryWarnings: ExpiryWarning[];
}) {
  const mut = (fn: (f: Field) => void) =>
    update((d) => fn(d.sections[si].fields[fi]));

  /** setLoc + markHuman sobre un texto del campo, por `part`. */
  const mutLoc = (
    part: "label" | "help" | "ph",
    read: (f: Field) => LocalizedText | undefined,
    write: (f: Field, v: Record<string, string>) => void,
    value: string,
  ) =>
    update((d) => {
      const f = d.sections[si].fields[fi];
      write(f, writeLoc(d, fieldPath(sectionId, field.id, part), locale, read(f), value));
    });

  const labelPath = fieldPath(sectionId, field.id, "label");
  const phPath = fieldPath(sectionId, field.id, "ph");
  const helpPath = fieldPath(sectionId, field.id, "help");

  return (
    <div
      className={`rounded-xl border bg-surface p-3 shadow-sm ${
        role ? "border-brand/60 ring-1 ring-brand/20" : "border-border"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          className={smallInput}
          value={field.type}
          onChange={(e) => mut((f) => (f.type = e.target.value as FieldType))}
        >
          {FIELD_TYPES.map((ft) => (
            <option key={ft} value={ft}>
              {t(`type_${ft}`)}
            </option>
          ))}
        </select>
        {/* Con rol interno, o si es la fecha de vencimiento de un documento, es
            obligatoria siempre (normalizeFormDefinition). */}
        <label
          className="flex items-center gap-1 text-xs text-muted"
          title={
            role
              ? t("internalRequiredLocked")
              : expiryOf
                ? t("expiryRequiredLocked")
                : undefined
          }
        >
          <input
            type="checkbox"
            className="accent-brand"
            checked={field.required || role !== null || expiryOf !== null}
            disabled={role !== null || expiryOf !== null}
            onChange={(e) => mut((f) => (f.required = e.target.checked))}
          />
          {t("required")}
        </label>
        {/* Largo mín./máx. de la respuesta (solo texto). Escribe validation.minLen/maxLen
            preservando otras claves; DynamicForm ya valida y muestra el mensaje. */}
        {(field.type === "short_text" || field.type === "long_text") && (
          <>
            <input
              type="number"
              min={1}
              className={`${smallInput} w-28`}
              placeholder={t("minLenLabel")}
              title={t("minLenLabel")}
              value={field.validation?.minLen ?? ""}
              onChange={(e) =>
                mut((f) => {
                  const n = e.target.value === "" ? NaN : Number(e.target.value);
                  const v = { ...(f.validation ?? {}) };
                  if (Number.isFinite(n) && n > 0) v.minLen = Math.floor(n);
                  else delete v.minLen;
                  if (Object.keys(v).length) f.validation = v;
                  else delete f.validation;
                })
              }
            />
            <input
              type="number"
              min={1}
              className={`${smallInput} w-28`}
              placeholder={t("maxLenLabel")}
              title={t("maxLenLabel")}
              value={field.validation?.maxLen ?? ""}
              onChange={(e) =>
                mut((f) => {
                  const n = e.target.value === "" ? NaN : Number(e.target.value);
                  const v = { ...(f.validation ?? {}) };
                  if (Number.isFinite(n) && n > 0) v.maxLen = Math.floor(n);
                  else delete v.maxLen;
                  if (Object.keys(v).length) f.validation = v;
                  else delete f.validation;
                })
              }
            />
          </>
        )}
        {/* Rango mín./máx. de la respuesta (solo número). Escribe validation.min/max.
            Ojo: a diferencia del largo de texto, acá 0 y los negativos son valores
            legítimos, así que la guarda es `isFinite` a secas y no se redondea. */}
        {field.type === "number" && (
          <>
            <input
              type="number"
              step="any"
              className={`${smallInput} w-28`}
              placeholder={t("minValueLabel")}
              title={t("minValueLabel")}
              value={field.validation?.min ?? ""}
              onChange={(e) =>
                mut((f) => {
                  const n = e.target.value === "" ? NaN : Number(e.target.value);
                  const v = { ...(f.validation ?? {}) };
                  if (Number.isFinite(n)) v.min = n;
                  else delete v.min;
                  if (Object.keys(v).length) f.validation = v;
                  else delete f.validation;
                })
              }
            />
            <input
              type="number"
              step="any"
              className={`${smallInput} w-28`}
              placeholder={t("maxValueLabel")}
              title={t("maxValueLabel")}
              value={field.validation?.max ?? ""}
              onChange={(e) =>
                mut((f) => {
                  const n = e.target.value === "" ? NaN : Number(e.target.value);
                  const v = { ...(f.validation ?? {}) };
                  if (Number.isFinite(n)) v.max = n;
                  else delete v.max;
                  if (Object.keys(v).length) f.validation = v;
                  else delete f.validation;
                })
              }
            />
          </>
        )}
        {field.type !== "note" && (
          <DiditReviewEditor
            field={field}
            imageFields={allFieldKeys
              .filter((k) => (k.field.type === "file" || k.field.type === "selfie") && k.key !== field.key)
              .map((k) => ({ key: k.key, label: k.label }))}
            kybCountryFields={allFieldKeys
              .filter(
                (k) =>
                  (k.field.type === "country" ||
                    k.field.type === "dropdown" ||
                    k.field.type === "short_text") &&
                  k.key !== field.key,
              )
              .map((k) => ({ key: k.key, label: k.label }))}
            kybRegNumberFields={allFieldKeys
              .filter(
                (k) =>
                  (k.field.type === "short_text" || k.field.type === "number") &&
                  k.key !== field.key,
              )
              .map((k) => ({ key: k.key, label: k.label, type: k.field.type }))}
            hasCountryCandidate={allFieldKeys.some(
              (k) =>
                k.field.type === "country" ||
                KYB_COUNTRY_RES.some((s) => s.re.test(k.key) && !s.exclude?.test(k.key)),
            )}
            kybFirstTaggedKey={
              allFieldKeys.find(
                (k) =>
                  k.field.review?.provider === "didit" &&
                  k.field.review.feature === "kyb_registry",
              )?.key ?? null
            }
            t={t}
            onChange={(review) =>
              mut((f) => {
                if (review) f.review = review;
                else delete f.review;
              })
            }
          />
        )}
        {field.type === "file" && (
          <ExpiryEditor
            field={field}
            dateFields={allFieldKeys
              .filter((k) => k.field.type === "date")
              .map((k) => ({ id: k.field.id, label: k.label }))}
            warnings={expiryWarns}
            t={t}
            onChange={(expiry) =>
              mut((f) => {
                if (expiry) f.expiry = expiry;
                else delete f.expiry;
              })
            }
            onAddDateField={() =>
              update((d) => {
                const fields = d.sections[si].fields;
                const doc = fields[fi];
                const date = newField("date");
                date.label = { es: "Fecha de vencimiento", en: "Expiry date" };
                date.required = true;
                const key = `${doc.key}_expires_on`;
                if (!d.sections.some((s) => s.fields.some((g) => g.key === key))) date.key = key;
                fields.splice(fi + 1, 0, date);
                doc.expiry = { source: "date_field", dateFieldId: date.id };
              })
            }
          />
        )}
        {expiryOf && (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-brand/40 px-2 py-0.5 text-xs text-brand">
            <CalendarClock size={12} aria-hidden />
            {t("expiryLinkedTo", { label: resolveText(expiryOf.label, locale) || expiryOf.key })}
          </span>
        )}
        <InternalRoleToggle field={field} role={role} t={t} update={update} />
        <div className="ml-auto flex items-center gap-1">
          <IconBtn
            label="↑"
            disabled={fi === 0}
            onClick={() =>
              update((d) => {
                const arr = d.sections[si].fields;
                const [f] = arr.splice(fi, 1);
                arr.splice(fi - 1, 0, f);
              })
            }
          />
          <IconBtn
            label="↓"
            disabled={fi === fieldCount - 1}
            onClick={() =>
              update((d) => {
                const arr = d.sections[si].fields;
                const [f] = arr.splice(fi, 1);
                arr.splice(fi + 1, 0, f);
              })
            }
          />
          <IconBtn
            label="✕"
            danger
            onClick={async () => {
              if (await askConfirm(t("confirmDeleteField")))
                update((d) => d.sections[si].fields.splice(fi, 1));
            }}
          />
        </div>
      </div>

      {role && skippable && (
        <p className="mb-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
          {t(`internalSkippable_${role}`)}
        </p>
      )}

      <div className="relative">
        <input
          className={inputCls + autoPad(i18n.isAuto(labelPath))}
          placeholder={t("fieldLabel")}
          value={getLoc(field.label, locale, i18n.src)}
          onChange={(e) =>
            mutLoc("label", (f) => f.label, (f, v) => (f.label = v), e.target.value)
          }
        />
        <AutoTag show={i18n.isAuto(labelPath)} tip={t("autoTip")} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          className={`${smallInput} flex-1`}
          placeholder={t("fieldKey")}
          value={field.key}
          onChange={(e) => mut((f) => (f.key = e.target.value.replace(/\s+/g, "_")))}
        />
        <div className="relative flex-1">
          <input
            className={`${smallInput} w-full${autoPad(i18n.isAuto(phPath))}`}
            placeholder={t("placeholder")}
            value={getLoc(field.placeholder, locale, i18n.src)}
            onChange={(e) =>
              mutLoc(
                "ph",
                (f) => f.placeholder,
                (f, v) => (f.placeholder = v),
                e.target.value,
              )
            }
          />
          <AutoTag show={i18n.isAuto(phPath)} tip={t("autoTip")} />
        </div>
      </div>

      {/* Descripción de la pregunta (se muestra bajo el input) */}
      <div className="relative mt-2">
        <textarea
          className={inputCls + autoPad(i18n.isAuto(helpPath))}
          rows={2}
          placeholder={t("fieldDescription")}
          value={getLoc(field.help, locale, i18n.src)}
          onChange={(e) =>
            mutLoc("help", (f) => f.help, (f, v) => (f.help = v), e.target.value)
          }
        />
        <AutoTag show={i18n.isAuto(helpPath)} tip={t("autoTip")} align="top" />
      </div>

      {/* Imagen de ayuda de la pregunta */}
      <ImageUpload
        value={field.image}
        onChange={(url) => mut((f) => (f.image = url))}
        imageSize={field.imageSize}
        onImageSizeChange={(s) => mut((f) => (f.imageSize = s))}
        label={t("helpImage")}
      />

      {/* Opciones */}
      {isChoiceType(field.type) && (
        <OptionsEditor
          field={field}
          si={si}
          fi={fi}
          locale={locale}
          t={t}
          update={update}
          i18n={i18n}
          sectionId={sectionId}
        />
      )}

      {/* Config de archivo */}
      {field.type === "file" && (
        <FileConfigEditor field={field} mut={mut} t={t} />
      )}

      {/* visibleIf del campo */}
      <ConditionRow
        label={t("showFieldIf")}
        condition={field.visibleIf}
        fieldKeys={allFieldKeys.filter((k) => k.key !== field.key)}
        locale={locale}
        t={t}
        onChange={(c) => mut((f) => (f.visibleIf = c))}
      />
    </div>
  );
}

// ---------- Rol interno de la pregunta (título / email de contacto) ----------

/**
 * Chip para marcar la pregunta como título o email de contacto de la
 * solicitud. Solo aparece en los tipos que pueden tener el rol, y marcarla en
 * una quita la marca de la que lo tenía (un rol, una pregunta).
 */
function InternalRoleToggle({
  field,
  role,
  t,
  update,
}: {
  field: Field;
  role: InternalRole | null;
  t: TFn;
  update: (mut: (d: FormDefinition) => void) => void;
}) {
  const candidate = internalRoleFor(field.type);
  if (!candidate) return null;
  const active = role === candidate;
  const label = t(`internalRole_${candidate}`);
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        aria-pressed={active}
        onClick={() => update((d) => setInternalRole(d, candidate, active ? null : field.id))}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
          active
            ? "border-brand bg-brand text-white"
            : "border-dashed border-border bg-surface text-muted hover:bg-surface-2"
        }`}
      >
        <EyeOff size={12} aria-hidden />
        {active ? label : `+ ${label}`}
      </button>
      {active && <InfoTip text={t(`internalRoleTip_${candidate}`)} />}
    </span>
  );
}

function OptionsEditor({
  field,
  si,
  fi,
  locale,
  t,
  update,
  i18n,
  sectionId,
}: {
  field: Field;
  si: number;
  fi: number;
  locale: string;
  t: TFn;
  update: (mut: (d: FormDefinition) => void) => void;
  i18n: I18nCtx;
  sectionId: string;
}) {
  const options = field.options ?? [];
  return (
    <div className="mt-2 rounded-lg bg-surface-2 p-2">
      <p className="mb-1 text-xs font-medium text-muted">{t("options")}</p>
      <div className="space-y-1.5">
        {options.map((o, oi) => (
          <div key={oi} className="rounded-md border border-border/60 p-1.5">
            <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                className={`${smallInput} w-full${autoPad(i18n.isAuto(optionPath(sectionId, field.id, o.value)))}`}
                placeholder={t("optionLabel")}
                value={getLoc(o.label, locale, i18n.src)}
                onChange={(e) =>
                  update((d) => {
                    const opt = d.sections[si].fields[fi].options![oi];
                    opt.label = writeLoc(
                      d,
                      optionPath(sectionId, field.id, opt.value),
                      locale,
                      opt.label,
                      e.target.value,
                    );
                    if (!opt.value)
                      opt.value = e.target.value.trim().slice(0, 40) || `opt_${oi}`;
                  })
                }
              />
              <AutoTag
                show={i18n.isAuto(optionPath(sectionId, field.id, o.value))}
                tip={t("autoTip")}
              />
            </div>
            <input
              className={`${smallInput} w-32`}
              placeholder="value"
              value={o.value}
              onChange={(e) =>
                update((d) => {
                  const opt = d.sections[si].fields[fi].options![oi];
                  // El `value` es parte del path de procedencia: al renombrarlo
                  // hay que mover la marca, o el badge desaparecería solo.
                  renameProvenance(
                    d,
                    optionPath(sectionId, field.id, opt.value),
                    optionPath(sectionId, field.id, e.target.value),
                  );
                  opt.value = e.target.value;
                })
              }
            />
            <IconBtn
              label="✕"
              danger
              onClick={() =>
                update((d) => d.sections[si].fields[fi].options!.splice(oi, 1))
              }
            />
            </div>
            <ImageUpload
              size="sm"
              value={o.image}
              onChange={(url) =>
                update((d) => {
                  d.sections[si].fields[fi].options![oi].image = url;
                })
              }
            />
          </div>
        ))}
      </div>
      <button
        className="mt-1.5 text-xs text-brand hover:underline"
        onClick={() =>
          update((d) => {
            const arr = (d.sections[si].fields[fi].options ??= []);
            arr.push({ value: `opt_${arr.length + 1}`, label: { es: "", en: "" } });
          })
        }
      >
        + {t("addOption")}
      </button>
    </div>
  );
}

function FileConfigEditor({
  field,
  mut,
  t,
}: {
  field: Field;
  mut: (fn: (f: Field) => void) => void;
  t: TFn;
}) {
  const cfg = field.file ?? { accept: [], multiple: false, maxSizeMB: 15 };
  return (
    <div className="mt-2 rounded-lg bg-surface-2 p-2">
      <p className="mb-1 text-xs font-medium text-muted">{t("fileConfig")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${smallInput} flex-1`}
          placeholder=".pdf,.png,image/*"
          value={cfg.accept.join(",")}
          onChange={(e) =>
            mut(
              (f) =>
                (f.file = {
                  ...cfg,
                  accept: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
            )
          }
        />
        <input
          type="number"
          className={`${smallInput} w-20`}
          value={cfg.maxSizeMB}
          onChange={(e) => mut((f) => (f.file = { ...cfg, maxSizeMB: Number(e.target.value) || 15 }))}
        />
        <span className="text-xs text-muted">MB</span>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            className="accent-brand"
            checked={cfg.multiple}
            onChange={(e) => mut((f) => (f.file = { ...cfg, multiple: e.target.checked }))}
          />
          {t("multiple")}
        </label>
      </div>
    </div>
  );
}

function ConditionRow({
  label,
  condition,
  fieldKeys,
  locale,
  t,
  onChange,
}: {
  label: string;
  condition?: Condition;
  fieldKeys: KeyInfo[];
  locale: string;
  t: TFn;
  onChange: (c: Condition | undefined) => void;
}) {
  const leaf =
    condition && "field" in condition
      ? condition
      : undefined;
  const enabled = !!leaf;
  const selField = fieldKeys.find((k) => k.key === leaf?.field);
  const selValue = selField?.field.options?.find(
    (o) => o.value === String(leaf?.value ?? ""),
  );
  const selValueLabel = selValue ? resolveText(selValue.label, locale) : undefined;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          className="accent-brand"
          checked={enabled}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { field: fieldKeys[0]?.key ?? "", op: "eq", value: "" }
                : undefined,
            )
          }
        />
        {label}
      </label>
      {enabled && (
        <>
          <select
            className={smallSelect}
            title={selField?.label}
            value={leaf!.field}
            onChange={(e) => onChange({ ...leaf!, field: e.target.value })}
          >
            {fieldKeys.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <select
            className={smallInput}
            value={leaf!.op}
            onChange={(e) => onChange({ ...leaf!, op: e.target.value as ConditionOp })}
          >
            {(["eq", "neq", "in", "not_in", "gt", "lt", "answered"] as ConditionOp[]).map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {leaf!.op !== "answered" &&
            (selField && selField.field.options?.length ? (
              <select
                className={smallSelect}
                title={selValueLabel}
                value={String(leaf!.value ?? "")}
                onChange={(e) => onChange({ ...leaf!, value: e.target.value })}
              >
                <option value="">—</option>
                {selField.field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {resolveText(o.label, locale)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={smallInput}
                placeholder={t("value")}
                value={String(leaf!.value ?? "")}
                onChange={(e) => onChange({ ...leaf!, value: e.target.value })}
              />
            ))}
        </>
      )}
    </div>
  );
}

function NavRulesEditor({
  section,
  si,
  sections,
  fieldKeys,
  locale,
  t,
  update,
}: {
  section: Section;
  si: number;
  sections: Section[];
  fieldKeys: KeyInfo[];
  locale: string;
  t: TFn;
  update: (mut: (d: FormDefinition) => void) => void;
}) {
  const rules = section.next ?? [];
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-xs font-medium text-muted">{t("jumps")}</p>
      {rules.map((rule, ri) => {
        const leaf = "field" in rule.when ? rule.when : undefined;
        const selField = fieldKeys.find((k) => k.key === leaf?.field);
        const selValue = selField?.field.options?.find(
          (o) => o.value === String(leaf?.value ?? ""),
        );
        const selValueLabel = selValue ? resolveText(selValue.label, locale) : undefined;
        return (
          <div key={ri} className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{t("if")}</span>
            <select
              className={smallSelect}
              title={selField?.label}
              value={leaf?.field ?? ""}
              onChange={(e) =>
                update((d) => (d.sections[si].next![ri].when = { field: e.target.value, op: leaf?.op ?? "eq", value: leaf?.value }))
              }
            >
              {fieldKeys.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
            <span>=</span>
            {selField && selField.field.options?.length ? (
              <select
                className={smallSelect}
                title={selValueLabel}
                value={String(leaf?.value ?? "")}
                onChange={(e) =>
                  update((d) => (d.sections[si].next![ri].when = { field: leaf!.field, op: "eq", value: e.target.value }))
                }
              >
                <option value="">—</option>
                {selField.field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {resolveText(o.label, locale)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={smallInput}
                value={String(leaf?.value ?? "")}
                onChange={(e) =>
                  update((d) => (d.sections[si].next![ri].when = { field: leaf?.field ?? "", op: "eq", value: e.target.value }))
                }
              />
            )}
            <span>→</span>
            <select
              className={smallSelect}
              value={rule.goTo}
              onChange={(e) => update((d) => (d.sections[si].next![ri].goTo = e.target.value))}
            >
              <option value="SUBMIT">{t("submitEnd")}</option>
              {sections.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {t("section")} {i + 1}
                </option>
              ))}
            </select>
            <IconBtn
              label="✕"
              danger
              onClick={() => update((d) => d.sections[si].next!.splice(ri, 1))}
            />
          </div>
        );
      })}
      <button
        className="text-xs text-brand hover:underline"
        onClick={() =>
          update((d) => {
            const arr = (d.sections[si].next ??= []);
            arr.push({ when: { field: fieldKeys[0]?.key ?? "", op: "eq", value: "" }, goTo: "SUBMIT" });
          })
        }
      >
        + {t("addJump")}
      </button>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-6 w-6 items-center justify-center rounded border border-border text-xs disabled:opacity-30 ${
        danger ? "text-danger hover:bg-danger/10" : "text-muted hover:bg-surface-2"
      }`}
    >
      {label}
    </button>
  );
}
