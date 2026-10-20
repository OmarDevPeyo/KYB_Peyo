"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EyeOff, Maximize2 } from "lucide-react";
import {
  resolveText,
  type Field,
  type FormDefinition,
  type ImageSize,
} from "@/lib/forms/definition";
import {
  nextSectionId,
  visibleFields,
  visibleSections,
  reachableSections,
  reachableFields,
  type Answers,
} from "@/lib/forms/logic";
import { countryOptions } from "@/lib/forms/countries";
import { choiceProblem, toggleChoice } from "@/lib/forms/choices";
import { downscaleImage } from "@/lib/forms/imageCompress";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ImageLightbox } from "./ImageLightbox";

export type FileRef = { path: string; filename: string };
/** Resultado de una subida: la referencia, o el motivo del fallo para mostrarlo. */
export type UploadResult =
  | { ok: true; ref: FileRef }
  | { ok: false; error?: string };

export interface DynamicFormProps {
  definition: FormDefinition;
  locale: string;
  initialAnswers?: Answers;
  mode?: "live" | "preview" | "correction";
  /** En modo corrección: preguntas a corregir (con su nota) y sección de arranque. */
  corrections?: { key: string; note: string }[];
  anchorSectionId?: string;
  /** En modo corrección: bloquea la edición de las secciones previas al anchor. */
  readOnlyBeforeAnchor?: boolean;
  onSaveDraft?: (answers: Answers) => Promise<void> | void;
  onUploadFile?: (file: File, field: Field) => Promise<UploadResult>;
  onDeleteFile?: (path: string) => Promise<boolean>;
  onSubmit?: (answers: Answers) => Promise<{ ok: boolean; error?: string }>;
  /** Si se pasa, tras enviar se redirige el navegador a esta URL (app del cliente). */
  returnUrl?: string;
  /**
   * Solo el preview del builder: id de pregunta → nombre de su rol interno
   * (título / email de contacto), que se muestra junto a la etiqueta. Las
   * páginas del solicitante no lo pasan nunca.
   */
  internalMarks?: Record<string, string>;
  labels?: {
    back: string;
    continue: string;
    submit: string;
    submitting: string;
    done: string;
    doneBody: string;
    saving: string;
    saved: string;
    saveError?: string;
    submitFailed?: string;
    missingFields?: string;
    required?: string;
    invalidEmail?: string;
    invalidNumber?: string;
    invalid?: string;
    /** Una elección o un país que no está entre las opciones. */
    invalidOption?: string;
    /** Una opción excluyente («Ninguna») marcada junto a otras. */
    exclusiveOption?: string;
    notInteger?: string;
    /** Plantillas con {min}/{max}; se interpolan aquí. */
    tooShort?: string;
    tooLong?: string;
    numberTooSmall?: string;
    numberTooBig?: string;
    returnCta?: string;
    redirecting?: string;
    correctionBanner?: string;
    readOnlyNotice?: string;
    /** Botón de las imágenes de ayuda y cierre del visor en grande. */
    expandImage?: string;
    closeImage?: string;
  };
}

const DEFAULT_LABELS: Required<NonNullable<DynamicFormProps["labels"]>> = {
  back: "Atrás",
  continue: "Continuar",
  submit: "Enviar",
  submitting: "Enviando…",
  done: "¡Enviado!",
  doneBody: "Gracias, tu información fue recibida.",
  saving: "Guardando…",
  saved: "Guardado",
  saveError: "No se pudo guardar",
  submitFailed: "No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.",
  missingFields: "Faltan {count} campo(s) obligatorio(s). Te llevamos al primero.",
  required: "Requerido",
  invalidEmail: "Email inválido",
  invalidNumber: "Número inválido",
  invalid: "Valor inválido",
  invalidOption: "Elige una de las opciones.",
  exclusiveOption: "Esa opción no se combina con otras.",
  notInteger: "Ingresa un número entero.",
  tooShort: "Mínimo {min} caracteres.",
  tooLong: "Máximo {max} caracteres.",
  numberTooSmall: "El mínimo es {min}.",
  numberTooBig: "El máximo es {max}.",
  returnCta: "Continuar",
  redirecting: "Redirigiendo…",
  correctionBanner:
    "Corrige las preguntas señaladas. Las respuestas anteriores son solo de lectura.",
  readOnlyNotice: "Respuestas anteriores (solo lectura).",
  expandImage: "Ver imagen en grande",
  closeImage: "Cerrar",
};

/** Bloque de preguntas: un `note` abre un bloque nuevo y actúa como su título. */
type FieldGroup = { header: Field | null; fields: Field[] };

/** Parte los campos visibles en bloques por cada `note`. Puro (presentacional). */
function groupByNote(list: Field[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const f of list) {
    if (f.type === "note") {
      groups.push({ header: f, fields: [] });
    } else {
      if (groups.length === 0) groups.push({ header: null, fields: [] });
      groups[groups.length - 1].fields.push(f);
    }
  }
  return groups;
}

export function DynamicForm({
  definition,
  locale,
  initialAnswers = {},
  mode = "live",
  corrections,
  anchorSectionId,
  readOnlyBeforeAnchor = true,
  onSaveDraft,
  onUploadFile,
  onDeleteFile,
  onSubmit,
  returnUrl,
  internalMarks,
  labels,
}: DynamicFormProps) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const imageLabels = useMemo(
    () => ({ expand: L.expandImage, close: L.closeImage }),
    [L.expandImage, L.closeImage],
  );
  // El autosave/borrador aplica también en corrección (el solicitante re-guarda
  // mientras corrige); solo `preview` queda fuera.
  const isLive = mode === "live" || mode === "correction";
  const isCorrection = mode === "correction";
  const sections = definition.sections;
  const firstId = useMemo(() => {
    const vis = visibleSections(definition, initialAnswers);
    return (vis[0] ?? sections[0])?.id ?? "";
  }, [definition, initialAnswers, sections]);

  // Keys marcadas para corregir (nota por key). En corrección se tratan como
  // requeridas (su respuesta se borró) y muestran la nota sobre el campo.
  const noteByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of corrections ?? []) m.set(c.key, c.note);
    return m;
  }, [corrections]);

  // Arranque en corrección: el anchor (1ª pregunta marcada); las secciones
  // alcanzables previas se pre-cargan en el stack (visibles con "Atrás", en
  // solo-lectura) para no poder editarlas.
  const { startId, initialStack, beforeAnchor } = useMemo(() => {
    if (!isCorrection || !anchorSectionId) {
      return { startId: firstId, initialStack: [] as string[], beforeAnchor: new Set<string>() };
    }
    const reach = reachableSections(definition, initialAnswers);
    const idx = reach.findIndex((s) => s.id === anchorSectionId);
    if (idx <= 0) {
      return { startId: anchorSectionId, initialStack: [] as string[], beforeAnchor: new Set<string>() };
    }
    const prevIds = reach.slice(0, idx).map((s) => s.id);
    return {
      startId: anchorSectionId,
      initialStack: prevIds,
      beforeAnchor: new Set(prevIds),
    };
  }, [isCorrection, anchorSectionId, definition, initialAnswers, firstId]);

  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [currentId, setCurrentId] = useState<string>(startId);
  const [stack, setStack] = useState<string[]>(initialStack);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const current = sections.find((s) => s.id === currentId) ?? sections[0];
  const fields = current ? visibleFields(current, answers) : [];

  // Autosave con debounce.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);
  // Siempre apunta a las respuestas más recientes (para guardar al ocultar la pestaña).
  const answersRef = useRef<Answers>(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  // Tras enviar, redirige el navegador de vuelta a la app del cliente (si hay return_url).
  useEffect(() => {
    if (done && returnUrl) {
      const t = setTimeout(() => {
        window.location.href = returnUrl;
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [done, returnUrl]);
  useEffect(() => {
    if (!isLive || !onSaveDraft) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setSaveState("saving");
    timer.current = setTimeout(async () => {
      try {
        await onSaveDraft(answers);
        setSaveState("saved");
      } catch (e) {
        console.error("[DynamicForm] autosave falló", e);
        setSaveState("error");
      }
    }, 1000);
  }, [answers, isLive, onSaveDraft]);

  // Guarda ya mismo (cancela el debounce). Se usa al cambiar de sección para no
  // depender de la ventana de 1s si el usuario avanza rápido.
  function flushSave() {
    if (!isLive || !onSaveDraft) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSaveState("saving");
    Promise.resolve(onSaveDraft(answers))
      .then(() => setSaveState("saved"))
      .catch((e: unknown) => {
        console.error("[DynamicForm] guardado falló", e);
        setSaveState("error");
      });
  }

  // Flush best-effort al ocultar/cerrar la pestaña (no depende del debounce).
  useEffect(() => {
    if (!isLive || !onSaveDraft) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") void onSaveDraft(answersRef.current);
    };
    const onPageHide = () => void onSaveDraft(answersRef.current);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [isLive, onSaveDraft]);

  function setAnswer(key: string, value: unknown) {
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
  }

  /** Calcula el mapa de errores (key → mensaje) para una lista de campos. Puro. */
  function computeErrors(list: Field[]): Record<string, string> {
    const next: Record<string, string> = {};
    for (const f of list) {
      if (f.type === "note") continue;
      const val = answers[f.key];
      const empty =
        val == null || val === "" || (Array.isArray(val) && val.length === 0);

      // Requerido (en corrección, las preguntas marcadas se exigen aunque el
      // campo fuera opcional: su respuesta se borró para re-contestarla).
      const requiredNow = f.required || (isCorrection && noteByKey.has(f.key));
      if (requiredNow) {
        if (f.type === "boolean") {
          if (val !== true) {
            next[f.key] = L.required;
            continue;
          }
        } else if (empty) {
          next[f.key] = L.required;
          continue;
        }
      }
      if (empty) continue; // opcional y vacío → válido

      // Formato (solo si hay valor)
      const v = f.validation ?? {};
      if (f.type === "email") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) next[f.key] = L.invalidEmail;
      } else if (f.type === "number") {
        const n = Number(val);
        if (Number.isNaN(n)) next[f.key] = L.invalidNumber;
        else if (v.integer && !Number.isInteger(n)) next[f.key] = L.notInteger;
        else if (v.min != null && n < v.min)
          next[f.key] = L.numberTooSmall.replace("{min}", String(v.min));
        else if (v.max != null && n > v.max)
          next[f.key] = L.numberTooBig.replace("{max}", String(v.max));
      } else if (f.type === "short_text" || f.type === "long_text") {
        const s = String(val);
        if (v.minLen != null && s.length < v.minLen)
          next[f.key] = L.tooShort.replace("{min}", String(v.minLen));
        else if (v.maxLen != null && s.length > v.maxLen)
          next[f.key] = L.tooLong.replace("{max}", String(v.maxLen));
        else if (v.pattern && !new RegExp(v.pattern).test(s)) next[f.key] = L.invalid;
      } else {
        // Elecciones y país: el mismo control que hace el servidor (fieldZod).
        const problem = choiceProblem(f, val);
        if (problem) next[f.key] = problem === "exclusive" ? L.exclusiveOption : L.invalidOption;
      }
    }
    return next;
  }

  /** Hace scroll + foco al campo con la key dada, si está en el DOM. */
  function scrollToField(key: string) {
    if (!key || typeof document === "undefined") return;
    const el = document.querySelector<HTMLElement>(
      `[data-field="${CSS.escape(key)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.querySelector<HTMLElement>("input, textarea, select")?.focus();
  }

  function validateFields(list: Field[]): boolean {
    const next = computeErrors(list);
    setErrors(next);
    const firstKey = Object.keys(next)[0];
    if (firstKey) scrollToField(firstKey);
    return Object.keys(next).length === 0;
  }

  async function goNext() {
    if (!validateFields(fields)) return;
    const target = nextSectionId(definition, currentId, answers);
    if (target === "SUBMIT") {
      await submit();
    } else {
      flushSave(); // persiste el borrador al avanzar de sección
      setStack((s) => [...s, currentId]);
      setCurrentId(target);
      setErrors({});
    }
  }

  function goBack() {
    flushSave(); // persiste el borrador al retroceder de sección
    setStack((s) => {
      if (s.length === 0) return s;
      const prev = s[s.length - 1];
      setCurrentId(prev);
      return s.slice(0, -1);
    });
    setErrors({});
  }

  async function submit() {
    // Valida TODO el formulario visible. Si falta algo, en vez de un `return`
    // mudo: navega a la sección del primer campo faltante, lo resalta y muestra
    // un mensaje claro (antes esto se veía como un "cuelgue" sin feedback).
    const missing = computeErrors(reachableFields(definition, answers));
    const missingKeys = Object.keys(missing);
    if (missingKeys.length > 0) {
      setErrors(missing);
      const firstKey = missingKeys[0];
      const target = reachableSections(definition, answers).find((s) =>
        s.fields.some((f) => f.key === firstKey),
      );
      if (target && target.id !== currentId) setCurrentId(target.id);
      setSubmitError(L.missingFields.replace("{count}", String(missingKeys.length)));
      // El campo se renderiza tras cambiar de sección → scroll en el próximo tick.
      setTimeout(() => scrollToField(firstKey), 60);
      return;
    }
    if (mode === "preview" || !onSubmit) {
      setDone(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await onSubmit(answers);
      if (res.ok) setDone(true);
      else setSubmitError(res.error ?? L.submitFailed);
    } catch (e) {
      // Backstop: si la Server Action lanza (p. ej. el body excede el límite
      // del framework), esto evita el fallo silencioso sin loading ni error.
      console.error("[DynamicForm] submit falló", e);
      setSubmitError(L.submitFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const isLast = nextSectionId(definition, currentId, answers) === "SUBMIT";

  if (done) {
    return (
      <Card className="p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-2xl text-success">
          ✓
        </div>
        <h2 className="font-display text-2xl font-bold text-foreground">{L.done}</h2>
        <p className="mt-2 text-muted">{L.doneBody}</p>
        {returnUrl && (
          <div className="mt-6">
            <a
              href={returnUrl}
              className="inline-flex items-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
            >
              {L.returnCta}
            </a>
            <p className="mt-2 text-xs text-muted">{L.redirecting}</p>
          </div>
        )}
      </Card>
    );
  }

  if (!current) return null;

  const visSecs = reachableSections(definition, answers);
  const stepIdx = visSecs.findIndex((s) => s.id === current.id);
  const progress = visSecs.length ? ((stepIdx + 1) / visSecs.length) * 100 : 0;
  // Sección previa al anchor en modo corrección: visible pero no editable.
  const readOnlyNow =
    isCorrection && readOnlyBeforeAnchor && beforeAnchor.has(currentId);
  const groups = groupByNote(fields);
  // El preview del builder se monta sin padding propio, así que ahí no se fija
  // la barra ni se aplica el sangrado `-mx-6` (que asume el `p-6` del shell).
  const sticky = mode !== "preview";
  const barCls = sticky ? "sticky z-20 -mx-6 bg-background px-6" : "";

  return (
    <ImageLabelsContext.Provider value={imageLabels}>
      <div className="pb-2">
        {isCorrection && (
          <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
            {L.correctionBanner}
          </div>
        )}

        <div className={`${barCls} top-0 border-b border-border py-3`}>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-foreground">
              {resolveText(current.title, locale) || `#${stepIdx + 1}`}
            </h2>
            {isLive && (
              <span
                className={`shrink-0 text-xs ${saveState === "error" ? "text-danger" : "text-muted"}`}
              >
                {saveState === "saving"
                  ? L.saving
                  : saveState === "saved"
                    ? L.saved
                    : saveState === "error"
                      ? L.saveError
                      : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-1.5 rounded-full bg-linear-to-r from-brand to-accent transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {stepIdx + 1}/{visSecs.length}
            </span>
          </div>
        </div>

        {current.description && (
          <p className="mt-4 text-sm text-muted">
            {resolveText(current.description, locale)}
          </p>
        )}
        {readOnlyNow && (
          <p className="mt-2 text-xs font-medium text-muted">{L.readOnlyNotice}</p>
        )}

        {/* Una card por pregunta: `space-y-8` separa bloques, `space-y-4` preguntas. */}
        <div className="mt-6 space-y-8">
          {groups.map((g, gi) => (
            <section key={g.header?.id ?? `g${gi}`} className="space-y-4">
              {g.header && <GroupHeader field={g.header} locale={locale} />}
              {g.fields.map((f) => {
                const marked = isCorrection && noteByKey.has(f.key);
                const state = errors[f.key]
                  ? "border-danger/50 ring-1 ring-danger/20"
                  : marked
                    ? "border-warning/50 ring-1 ring-warning/20"
                    : "border-border";
                return (
                  <div key={f.id} data-field={f.key} className={`${QUESTION_CARD} ${state}`}>
                    <FieldInput
                      field={f}
                      locale={locale}
                      value={answers[f.key]}
                      error={errors[f.key]}
                      disabled={readOnlyNow}
                      note={isCorrection ? noteByKey.get(f.key) : undefined}
                      markedRequired={marked}
                      internalMark={mode === "preview" ? internalMarks?.[f.id] : undefined}
                      onChange={(v) => setAnswer(f.key, v)}
                      onUploadFile={onUploadFile}
                      onDeleteFile={onDeleteFile}
                    />
                  </div>
                );
              })}
            </section>
          ))}
          {fields.length === 0 && <p className="text-sm text-muted">—</p>}
        </div>

        {submitError && <p className="mt-4 text-sm text-danger">{submitError}</p>}

        <div
          className={`${barCls} bottom-0 mt-6 flex items-center justify-between gap-3 border-t border-border py-4`}
        >
          <Button
            type="button"
            variant="ghost"
            disabled={stack.length === 0}
            onClick={goBack}
          >
            ← {L.back}
          </Button>
          {isLast ? (
            <Button type="button" onClick={submit} disabled={submitting}>
              {submitting ? L.submitting : L.submit}
            </Button>
          ) : (
            <Button type="button" onClick={goNext}>
              {L.continue} →
            </Button>
          )}
        </div>
      </div>
    </ImageLabelsContext.Provider>
  );
}

// ============================================================
// Campo individual
// ============================================================
// No se reutiliza <Card>: aquí hace falta otro radio y un borde por estado, y
// sin tailwind-merge las clases en conflicto resolverían por orden del CSS.
const QUESTION_CARD =
  "rounded-xl border bg-surface p-4 shadow-sm transition-colors sm:p-5";

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/30";

function FieldInput({
  field,
  locale,
  value,
  error,
  disabled = false,
  note,
  markedRequired = false,
  internalMark,
  onChange,
  onUploadFile,
  onDeleteFile,
}: {
  field: Field;
  locale: string;
  value: unknown;
  error?: string;
  disabled?: boolean;
  note?: string;
  markedRequired?: boolean;
  /** Rol interno de la pregunta; solo llega en el preview del builder. */
  internalMark?: string;
  onChange: (v: unknown) => void;
  onUploadFile?: (file: File, field: Field) => Promise<UploadResult>;
  onDeleteFile?: (path: string) => Promise<boolean>;
}) {
  const label = resolveText(field.label, locale);
  const placeholder = resolveText(field.placeholder, locale);
  const help = resolveText(field.help, locale);
  const options = field.options ?? [];
  const imgCls = helpImageCls(field.imageSize);

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-foreground">
        {label || "—"}
        {(field.required || markedRequired) && <span className="text-danger"> *</span>}
        {internalMark && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 align-middle text-[10px] font-semibold text-white">
            <EyeOff size={10} aria-hidden />
            {internalMark}
          </span>
        )}
      </label>
      {note !== undefined && (
        <p className="mb-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
          {note || "Vuelve a responder esta pregunta."}
        </p>
      )}
      {field.image && (
        <HelpImage
          src={field.image}
          caption={label}
          wrapperClassName={`mb-2 block ${imgCls.wrap}`}
          className={`${imgCls.img} rounded-lg border border-border`}
        />
      )}

      {field.type === "long_text" ? (
        <textarea
          className={inputCls}
          rows={3}
          placeholder={placeholder}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "single_choice" ? (
        <div className="space-y-1.5">
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                className="accent-brand"
                checked={String(value ?? "") === o.value}
                disabled={disabled}
                onChange={() => onChange(o.value)}
              />
              <span>{resolveText(o.label, locale)}</span>
              {o.image && (
                <HelpImage
                  src={o.image}
                  caption={resolveText(o.label, locale)}
                  compact
                  wrapperClassName="shrink-0"
                  className="h-12 w-12 rounded border border-border object-cover"
                />
              )}
            </label>
          ))}
        </div>
      ) : field.type === "multiple_choice" ? (
        <div className="space-y-1.5">
          {options.map((o) => {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={arr.includes(o.value)}
                  disabled={disabled}
                  // Una opción excluyente («Ninguna») desmarca las demás, y al revés.
                  onChange={(e) => onChange(toggleChoice(field, arr, o.value, e.target.checked))}
                />
                <span>{resolveText(o.label, locale)}</span>
                {o.image && (
                  <HelpImage
                    src={o.image}
                    caption={resolveText(o.label, locale)}
                    compact
                    wrapperClassName="shrink-0"
                    className="h-12 w-12 rounded border border-border object-cover"
                  />
                )}
              </label>
            );
          })}
        </div>
      ) : field.type === "dropdown" ? (
        <select
          className={inputCls}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {resolveText(o.label, locale)}
            </option>
          ))}
        </select>
      ) : field.type === "country" ? (
        <CountryField value={value} onChange={onChange} locale={locale} disabled={disabled} />
      ) : field.type === "naics" ? (
        <NaicsField value={value} onChange={onChange} locale={locale} disabled={disabled} />
      ) : field.type === "file" ? (
        <FileField
          field={field}
          value={value}
          onChange={onChange}
          onUploadFile={onUploadFile}
          onDeleteFile={onDeleteFile}
          locale={locale}
          disabled={disabled}
        />
      ) : field.type === "selfie" ? (
        <SelfieField
          field={field}
          value={value}
          onChange={onChange}
          onUploadFile={onUploadFile}
          onDeleteFile={onDeleteFile}
          locale={locale}
          disabled={disabled}
        />
      ) : field.type === "boolean" ? (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="accent-brand"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{placeholder || label}</span>
        </label>
      ) : (
        <input
          type={field.type === "email" ? "email" : field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          // Solo semántica (navegador + lectores de pantalla): no bloquea el
          // tecleo. Quien rechaza fuera de rango es computeErrors, y al enviar
          // fieldZod del lado del servidor.
          min={field.type === "number" ? field.validation?.min : undefined}
          max={field.type === "number" ? field.validation?.max : undefined}
          className={inputCls}
          placeholder={placeholder}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
      {error && <p className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}

/**
 * Encabezado de bloque (campo `note`): solo texto, sin input ni respuesta. Va
 * *entre* las cards de pregunta, no dentro, para que separe visualmente.
 */
function GroupHeader({ field, locale }: { field: Field; locale: string }) {
  const label = resolveText(field.label, locale);
  const help = resolveText(field.help, locale);
  const imgCls = helpImageCls(field.imageSize);
  return (
    <div className="px-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </p>
      {help && <p className="mt-1 text-sm text-muted">{help}</p>}
      {field.image && (
        <HelpImage
          src={field.image}
          caption={label}
          wrapperClassName={`mt-2 block ${imgCls.wrap}`}
          className={`${imgCls.img} rounded-lg border border-border`}
        />
      )}
    </div>
  );
}

/**
 * Presets de tamaño de la imagen de ayuda. `md` reproduce el tamaño histórico,
 * así que las definiciones sin `imageSize` no cambian de aspecto.
 *
 * Las clases son literales a propósito: Tailwind las detecta escaneando el
 * texto del archivo, así que nunca construirlas dinámicamente (`max-h-${n}` no
 * genera CSS). `full` también cambia el wrapper porque el `w-fit` del <a>
 * anularía el ancho de la imagen.
 */
const HELP_IMAGE_SIZE: Record<ImageSize, { wrap: string; img: string }> = {
  sm: { wrap: "w-fit", img: "max-h-32" }, //  8rem
  md: { wrap: "w-fit", img: "max-h-56" }, // 14rem — tamaño histórico
  lg: { wrap: "w-fit", img: "max-h-96" }, // 24rem
  full: { wrap: "w-full", img: "w-full" }, // ancho de la tarjeta
};

function helpImageCls(size?: ImageSize) {
  return HELP_IMAGE_SIZE[size ?? "md"];
}

/**
 * Textos del visor de imágenes. Por contexto y no por props: las imágenes están
 * varios componentes más abajo (pregunta, opción, encabezado de bloque).
 */
const ImageLabelsContext = createContext({
  expand: DEFAULT_LABELS.expandImage,
  close: DEFAULT_LABELS.closeImage,
});

/**
 * Imagen de ayuda (pregunta u opción). Tocarla la abre en grande dentro del
 * mismo formulario (antes abría una pestaña nueva y la persona salía del
 * formulario). El ícono de la esquina avisa que se puede agrandar: en
 * dispositivos con mouse aparece al pasar por encima; en táctiles, siempre.
 */
function HelpImage({
  src,
  caption,
  className,
  wrapperClassName = "",
  compact = false,
}: {
  src: string;
  /** Texto que acompaña a la imagen en grande (pregunta u opción). */
  caption?: string;
  className: string;
  wrapperClassName?: string;
  /** Miniatura de opción: ícono más chico. */
  compact?: boolean;
}) {
  const labels = useContext(ImageLabelsContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Al cerrar, el foco vuelve a la miniatura (teclado y lector de pantalla
  // siguen donde estaban).
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(e) => {
          // Dentro del <label> de una opción: agrandar no la marca.
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={labels.expand}
        title={labels.expand}
        className={`group relative cursor-zoom-in rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${wrapperClassName}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className={className} />
        <span
          aria-hidden
          className={`pointer-events-none absolute flex items-center justify-center rounded-md bg-surface/90 text-foreground shadow-sm ring-1 ring-border transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 ${
            compact ? "right-0.5 bottom-0.5 h-5 w-5" : "top-2 right-2 h-8 w-8"
          }`}
        >
          <Maximize2 size={compact ? 11 : 16} />
        </span>
      </button>
      {open && (
        <ImageLightbox src={src} caption={caption} closeLabel={labels.close} onClose={close} />
      )}
    </>
  );
}

// ---------- Selector de país (combobox buscable; valor = ISO alpha-3) ----------
const COUNTRY_SEARCH = { es: "Buscar país…", en: "Search country…" };

function CountryField({
  value,
  onChange,
  locale,
  disabled = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  locale: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo(() => countryOptions(locale), [locale]);
  const selected = options.find((c) => c.value === value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((c) => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q))
    : options;
  const searchPlaceholder = locale === "en" ? COUNTRY_SEARCH.en : COUNTRY_SEARCH.es;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={`${inputCls} flex items-center justify-between text-left disabled:opacity-60`}
      >
        <span className={selected ? "" : "text-muted"}>
          {selected ? `${selected.flag} ${selected.name}` : "—"}
        </span>
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 w-full rounded-lg border border-border bg-surface-card shadow-lg">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
            />
            <div className="max-h-56 overflow-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-1 text-xs text-muted">—</p>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => {
                      onChange(c.value);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${
                      c.value === value ? "font-semibold text-brand" : "text-foreground"
                    }`}
                  >
                    <span>{c.flag}</span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Selector NAICS (buscador; valor = código de 6 dígitos) ----------
const NAICS_TEXT = {
  es: { search: "Busca por código o palabra (ej. 5415, software)…", empty: "Sin resultados", hint: "Escribe para buscar" },
  en: { search: "Search by code or word (e.g. 5415, software)…", empty: "No results", hint: "Type to search" },
} as const;

type NaicsModule = typeof import("@/lib/forms/naics");

/**
 * Como CountryField, pero el catálogo (1.012 códigos, en dos idiomas) se carga
 * recién cuando hace falta: al abrir el buscador o al mostrar un valor ya
 * elegido. Así no pesa en los formularios que no lo usan.
 */
function NaicsField({
  value,
  onChange,
  locale,
  disabled = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  locale: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<NaicsModule | null>(null);
  const code = typeof value === "string" ? value : "";
  const text = locale === "en" ? NAICS_TEXT.en : NAICS_TEXT.es;
  const lang = locale === "es" ? "es" : "en";

  useEffect(() => {
    if (catalog || (!open && !code)) return;
    let alive = true;
    import("@/lib/forms/naics").then((m) => {
      if (alive) setCatalog(m);
    });
    return () => {
      alive = false;
    };
  }, [open, code, catalog]);

  const results = catalog ? catalog.searchNaics(query) : [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={`${inputCls} flex items-center justify-between text-left disabled:opacity-60`}
      >
        <span className={code ? "truncate" : "text-muted"}>
          {code ? (catalog ? catalog.formatNaics(code, lang) : code) : "—"}
        </span>
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 w-full rounded-lg border border-border bg-surface-card shadow-lg">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={text.search}
              className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
            />
            <div className="max-h-64 overflow-auto py-1">
              {!query.trim() || !catalog ? (
                <p className="px-3 py-1 text-xs text-muted">{catalog ? text.hint : "…"}</p>
              ) : results.length === 0 ? (
                <p className="px-3 py-1 text-xs text-muted">{text.empty}</p>
              ) : (
                results.map(([c, en, es]) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      onChange(c);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${
                      c === code ? "font-semibold text-brand" : "text-foreground"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-xs text-muted">{c}</span>
                    <span>{lang === "es" ? es : en}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const FILE_TEXT = {
  es: {
    upError: "No se pudo subir el archivo. Intenta de nuevo.",
    delError: "No se pudo eliminar el archivo. Intenta de nuevo.",
    choose: "Elegir archivo",
    remove: "Quitar",
  },
  en: {
    upError: "Could not upload the file. Try again.",
    delError: "Could not remove the file. Try again.",
    choose: "Choose file",
    remove: "Remove",
  },
} as const;

function FileField({
  field,
  value,
  onChange,
  onUploadFile,
  onDeleteFile,
  locale,
  disabled = false,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  onUploadFile?: (file: File, field: Field) => Promise<UploadResult>;
  onDeleteFile?: (path: string) => Promise<boolean>;
  locale: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refs = Array.isArray(value) ? (value as FileRef[]) : [];
  const cfg = field.file;
  const T = locale === "en" ? FILE_TEXT.en : FILE_TEXT.es;

  async function removeAt(i: number) {
    const ref = refs[i];
    if (!ref) return;
    setErr(null);
    setRemoving(i);
    try {
      if (ref.path && onDeleteFile) {
        const ok = await onDeleteFile(ref.path);
        if (!ok) {
          setErr(T.delError);
          return;
        }
      }
      onChange(refs.filter((_, idx) => idx !== i));
    } catch (delErr) {
      console.error("[FileField] borrado falló", delErr);
      setErr(T.delError);
    } finally {
      setRemoving(null);
    }
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setErr(null);
    setBusy(true);
    const added: FileRef[] = [];
    try {
      for (const file of files) {
        if (cfg?.maxSizeMB && file.size > cfg.maxSizeMB * 1024 * 1024) {
          setErr(`> ${cfg.maxSizeMB} MB`);
          continue;
        }
        if (onUploadFile) {
          // Comprime imágenes grandes antes de subir (los no-imagen pasan intactos).
          const toUpload = await downscaleImage(file, { maxDim: 2000, quality: 0.85 });
          const res = await onUploadFile(toUpload, field);
          if (res.ok) added.push(res.ref);
          // Mostrar el motivo real (p. ej. error de storage / invitación) en vez del genérico.
          else setErr(res.error || T.upError);
        } else {
          added.push({ path: "", filename: file.name });
        }
      }
    } catch (uploadErr) {
      // Backstop: si la Server Action lanza (p. ej. el archivo excede el límite
      // de body del framework), mostrar el error en vez de quedar en silencio.
      console.error("[FileField] subida falló", uploadErr);
      setErr(T.upError);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
    if (added.length) onChange(cfg?.multiple ? [...refs, ...added] : added.slice(-1));
  }

  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2">
        <span className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
          {busy ? "…" : T.choose}
        </span>
        <input
          type="file"
          multiple={cfg?.multiple}
          accept={cfg?.accept?.length ? cfg.accept.join(",") : undefined}
          disabled={busy || disabled}
          onChange={onFiles}
          className="hidden"
        />
      </label>
      {cfg?.accept?.length ? (
        <p className="mt-1 text-xs text-muted">{cfg.accept.join(", ")}</p>
      ) : null}
      {err && <p className="mt-1 text-sm text-danger">{err}</p>}
      {refs.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {refs.map((r, i) => (
            <li key={i} className="flex items-center gap-2 text-muted">
              <span className="text-success">✓</span>
              <span className="min-w-0 flex-1 truncate">{r.filename}</span>
              <button
                type="button"
                className="shrink-0 cursor-pointer text-xs text-danger hover:underline disabled:opacity-50"
                onClick={() => removeAt(i)}
                disabled={removing !== null || busy || disabled}
              >
                {removing === i ? "…" : T.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Captura de selfie por cámara (solo en vivo) ----------
const SELFIE_TEXT = {
  es: {
    start: "Encender cámara",
    capture: "Tomar foto",
    retake: "Volver a tomar",
    cancel: "Cancelar",
    captured: "Selfie capturada",
    camError: "No se pudo acceder a la cámara. Concede el permiso y usa un dispositivo con cámara.",
    upError: "No se pudo subir la foto. Intenta de nuevo.",
    uploading: "Subiendo…",
  },
  en: {
    start: "Turn on camera",
    capture: "Take photo",
    retake: "Retake",
    cancel: "Cancel",
    captured: "Selfie captured",
    camError: "Could not access the camera. Grant permission and use a device with a camera.",
    upError: "Could not upload the photo. Try again.",
    uploading: "Uploading…",
  },
} as const;

function SelfieField({
  field,
  value,
  onChange,
  onUploadFile,
  onDeleteFile,
  locale,
  disabled = false,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  onUploadFile?: (file: File, field: Field) => Promise<UploadResult>;
  onDeleteFile?: (path: string) => Promise<boolean>;
  locale: string;
  disabled?: boolean;
}) {
  const t = SELFIE_TEXT[locale === "en" ? "en" : "es"];
  const refs = Array.isArray(value) ? (value as FileRef[]) : [];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const thumbUrlRef = useRef<string | null>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setActive(false);
  }
  function revokeThumb() {
    if (thumbUrlRef.current) {
      URL.revokeObjectURL(thumbUrlRef.current);
      thumbUrlRef.current = null;
    }
  }

  // Adjunta el stream al <video> cuando la cámara se enciende.
  useEffect(() => {
    if (active && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [active]);

  // Limpieza al desmontar.
  useEffect(() => {
    return () => {
      stopCamera();
      revokeThumb();
    };
  }, []);

  async function startCamera() {
    setErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(t.camError);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      setActive(true);
    } catch {
      setErr(t.camError);
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    // Reescala al lado mayor ≤ 1600px para no capturar a resolución completa de
    // cámara (archivos enormes que ralentizan subida y verificación).
    const SELFIE_MAX_DIM = 1600;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(vw, vh) > SELFIE_MAX_DIM ? SELFIE_MAX_DIM / Math.max(vw, vh) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), "image/jpeg", 0.85),
    );
    if (!blob) return;
    const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: "image/jpeg" });

    stopCamera();
    revokeThumb();
    const url = URL.createObjectURL(blob);
    thumbUrlRef.current = url;
    setThumb(url);

    setErr(null);
    setBusy(true);
    try {
      if (onUploadFile) {
        const res = await onUploadFile(file, field);
        if (res.ok) {
          onChange([res.ref]);
        } else {
          setErr(res.error || t.upError);
          revokeThumb();
          setThumb(null);
        }
      } else {
        onChange([{ path: "", filename: file.name }]);
      }
    } catch (uploadErr) {
      // Backstop ante un throw de la Server Action (p. ej. límite de body).
      console.error("[SelfieField] subida falló", uploadErr);
      setErr(t.upError);
      revokeThumb();
      setThumb(null);
    } finally {
      setBusy(false);
    }
  }

  function retake() {
    // Borra la foto previa ya subida para no dejar huérfanos en Storage.
    const prev = refs[0]?.path;
    if (prev && onDeleteFile) void onDeleteFile(prev);
    revokeThumb();
    setThumb(null);
    setErr(null);
    onChange([]);
    startCamera();
  }

  const hasCapture = refs.length > 0 || thumb != null;

  return (
    <div>
      {active ? (
        <div className="space-y-2">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full max-w-xs rounded-lg border border-border bg-black"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={capture} disabled={busy}>
              {t.capture}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={stopCamera}>
              {t.cancel}
            </Button>
          </div>
        </div>
      ) : hasCapture ? (
        <div className="space-y-2">
          {thumb && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumb}
                alt=""
                className="w-full max-w-xs rounded-lg border border-border"
              />
            </>
          )}
          <p className="text-sm text-muted">
            <span className="text-success">✓</span> {t.captured}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={retake} disabled={busy || disabled}>
            {t.retake}
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" onClick={startCamera} disabled={busy || disabled}>
          {t.start}
        </Button>
      )}
      {busy && <p className="mt-1 text-sm text-muted">{t.uploading}</p>}
      {err && <p className="mt-1 text-sm text-danger">{err}</p>}
    </div>
  );
}
