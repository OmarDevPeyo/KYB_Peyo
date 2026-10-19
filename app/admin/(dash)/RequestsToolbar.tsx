"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  ChevronDown,
  CircleDot,
  FileText,
  Globe,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import type { KybStatus } from "@/lib/kyb/types";
import { FORM_NONE } from "./requestFilters";
import { requestsHref } from "@/lib/admin/requestsQuery";
import { countryOptions } from "@/lib/forms/countries";

const STATUSES: KybStatus[] = [
  "created",
  "in_progress",
  "submitted",
  "under_review",
  "changes_requested",
  "approved",
  "rejected",
  "expired",
];

/** Espera tras la última tecla antes de buscar. */
const SEARCH_DEBOUNCE_MS = 350;

export type RequestsFilters = {
  /** Pestaña de org del admin; vacío = todas (o la propia, para un miembro). */
  org: string;
  q: string;
  status: string;
  form: string;
  /** País de la IP del envío (alpha-2). */
  country: string;
  from: string;
  to: string;
};

export type FormOption = { id: string; name: string; archived: boolean };

// Mismo alto para todos los controles: la barra se lee como una sola pieza.
const controlCls =
  "h-10 rounded-lg border text-sm text-foreground outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/30";
// Un filtro con valor se tiñe con la marca: se ve de un vistazo qué está
// filtrando. Borde y fondo van solo aquí (no en `controlCls`): sin
// tailwind-merge, dos utilidades del mismo tipo empatan por orden de CSS.
const idleCls = "border-border bg-surface hover:border-muted/50";
const activeCls = "border-brand/40 bg-brand/5";

/**
 * Barra de búsqueda y filtros del listado de solicitudes. Recibe los valores
 * actuales como props (leídos del `searchParams` en el server) y navega
 * actualizando la query string. Al cambiar cualquier filtro se resetea la
 * página a 1.
 */
export function RequestsToolbar({
  current,
  forms,
}: {
  current: RequestsFilters;
  forms: FormOption[];
}) {
  const t = useTranslations("admin");
  const tStatus = useTranslations("status");
  const locale = useLocale();
  // Todos los países y no solo los que tienen solicitudes: saberlos exigiría
  // recorrer la tabla. El selector nativo deja buscar tecleando.
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [q, setQ] = useState(current.q);
  // La búsqueda vive en estado local (se escribe antes de navegar), así que hay
  // que re-sincronizarla cuando la URL cambia por fuera: atrás del navegador o
  // los enlaces "Limpiar filtros" de la página. Lo que navegamos nosotros no se
  // re-sincroniza: pisaría lo que el usuario siguió tecleando mientras tanto.
  const [seenQ, setSeenQ] = useState(current.q);
  const [sentQ, setSentQ] = useState(current.q);
  if (current.q !== seenQ) {
    setSeenQ(current.q);
    if (current.q !== sentQ) setQ(current.q);
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelPendingSearch() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  // Un debounce que dispara después de salir de la página navegaría de vuelta.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function navigate(next: Partial<RequestsFilters>, mode: "push" | "replace" = "push") {
    const merged = { ...current, q: q.trim(), ...next };
    // Al cambiar un filtro volvemos a la primera página (no se pasa `page`).
    // La org viaja en `merged`: filtrar no saca al admin de su pestaña.
    const url = requestsHref(merged);
    setSentQ(merged.q);
    startTransition(() => {
      if (mode === "replace") router.replace(url);
      else router.push(url);
    });
  }

  function onQueryChange(value: string) {
    setQ(value);
    cancelPendingSearch();
    // `replace`: cada tecla no debe dejar una entrada en el historial.
    timer.current = setTimeout(
      () => navigate({ q: value.trim() }, "replace"),
      SEARCH_DEBOUNCE_MS,
    );
  }

  function onSearchSubmit(e: FormEvent) {
    e.preventDefault();
    cancelPendingSearch();
    navigate({});
  }

  function clearSearch() {
    cancelPendingSearch();
    setQ("");
    navigate({ q: "" });
  }

  const activeForms = forms.filter((f) => !f.archived);
  const archivedForms = forms.filter((f) => f.archived);
  const hasDates = Boolean(current.from || current.to);

  return (
    <div className="mb-4 rounded-2xl border border-border bg-surface p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          onSubmit={onSearchSubmit}
          className="relative min-w-0 basis-full sm:min-w-64 sm:flex-1 sm:basis-0"
        >
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
            {pending ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden />
            ) : (
              <Search size={16} aria-hidden />
            )}
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className={`${controlCls} ${q ? activeCls : idleCls} w-full pr-9 pl-9 placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none`}
          />
          {q && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label={t("clearSearch")}
              title={t("clearSearch")}
              className="absolute inset-y-0 right-2 my-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </form>

        <FilterSelect
          label={t("status")}
          icon={<CircleDot size={16} aria-hidden />}
          value={current.status}
          onChange={(status) => navigate({ status })}
          widthCls="sm:w-52"
        >
          <option value="">{t("allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {tStatus(s)}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          label={t("form")}
          icon={<FileText size={16} aria-hidden />}
          value={current.form}
          onChange={(form) => navigate({ form })}
          widthCls="sm:w-60"
        >
          <option value="">{t("allForms")}</option>
          <option value={FORM_NONE}>{t("formNone")}</option>
          {activeForms.length > 0 && (
            <optgroup label={t("form")}>
              {activeForms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          )}
          {/* Los archivados siguen teniendo solicitudes históricas. */}
          {archivedForms.length > 0 && (
            <optgroup label={t("archivedForms")}>
              {archivedForms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          )}
        </FilterSelect>

        <FilterSelect
          label={t("ipCountry")}
          icon={<Globe size={16} aria-hidden />}
          value={current.country}
          onChange={(country) => navigate({ country })}
          widthCls="sm:w-56"
        >
          <option value="">{t("allCountries")}</option>
          {countries.map((c) => (
            <option key={c.alpha2} value={c.alpha2}>
              {c.flag} {c.name}
            </option>
          ))}
        </FilterSelect>

        <div
          role="group"
          aria-label={t("dateRange")}
          className={`flex min-w-0 basis-full items-center gap-2 px-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30 sm:basis-auto ${controlCls} ${hasDates ? activeCls : idleCls}`}
        >
          <DateInput
            label={t("dateFrom")}
            value={current.from}
            max={current.to || undefined}
            onChange={(from) => navigate({ from })}
          />
          <span className="text-muted" aria-hidden>
            –
          </span>
          <DateInput
            label={t("dateTo")}
            value={current.to}
            min={current.from || undefined}
            onChange={(to) => navigate({ to })}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * `<select>` nativo (teclado, lector de pantalla y selector del SO gratis) con
 * ícono y chevron propios. El texto de la opción se trunca: los nombres de
 * formulario pueden ser largos.
 */
function FilterSelect({
  label,
  icon,
  value,
  onChange,
  widthCls,
  children,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (value: string) => void;
  widthCls: string;
  children: ReactNode;
}) {
  const active = value !== "";
  return (
    // En móvil a ancho completo: dos por fila truncaban "Todos los estados".
    <label className={`relative min-w-0 basis-full sm:basis-auto ${widthCls}`}>
      <span className="sr-only">{label}</span>
      <span
        className={`pointer-events-none absolute inset-y-0 left-3 flex items-center ${
          active ? "text-brand" : "text-muted"
        }`}
      >
        {icon}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${controlCls} ${active ? activeCls : idleCls} w-full cursor-pointer appearance-none truncate pr-9 pl-9`}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
      />
    </label>
  );
}

/**
 * Fecha sin borde propio: el borde y el foco los pone el grupo del rango. El
 * ícono de calendario es el nativo (abre el selector); no se duplica con uno
 * propio.
 */
function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      title={label}
      className={`min-w-0 flex-1 cursor-pointer bg-transparent text-sm outline-none sm:w-34 sm:flex-none [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100 ${
        value ? "text-foreground" : "text-muted"
      }`}
    />
  );
}
