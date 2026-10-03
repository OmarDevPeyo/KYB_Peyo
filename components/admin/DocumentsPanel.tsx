"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Download, Eye } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getDocUrlAction } from "@/app/admin/actions";
import { DocLightbox, type FlatDoc } from "./DocLightbox";
import {
  FileTypeIcon,
  ICON_LINK,
  fileKindOf,
  isPreviewable,
  withDownloadName,
  type DocGroup,
} from "./docParts";

/**
 * Margen antes del TTL de 1 h de `createSignedDocUrls`: si la pestaña lleva más
 * de esto abierta, se re-firma antes de abrir el visor.
 */
const RESIGN_AFTER_MS = 45 * 60 * 1000;

/** Con pocos archivos, desplegar todo de entrada; con muchos, solo el primero. */
const OPEN_ALL_UP_TO = 8;

/**
 * Inventario de documentos de una solicitud, agrupado por la pregunta que los
 * pidió (`kyb_documents.doc_type` es la key del campo: ver `ApplicantForm`).
 *
 * Los grupos llegan ya ordenados y con las etiquetas resueltas al locale desde
 * el RSC; aquí solo hay interacción: desplegar, previsualizar y descargar.
 */
export function DocumentsPanel({ groups }: { groups: DocGroup[] }) {
  const t = useTranslations("admin");
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** URLs re-firmadas en cliente, por si las del servidor ya caducaron. */
  const [fresh, setFresh] = useState<Record<string, string>>({});
  /** Momento de montaje ≈ momento en que el servidor firmó las URLs. Se toma en
   *  un efecto porque leer el reloj durante el render no es puro. */
  const mountedAt = useRef(0);
  const retried = useRef<Record<string, boolean>>({});

  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  const flat = useMemo<FlatDoc[]>(
    () => groups.flatMap((g) => g.docs.map((d) => ({ ...d, question: g.question }))),
    [groups],
  );
  /** Índice en la lista aplanada, para que el visor navegue entre grupos. */
  const indexById = useMemo(
    () => new Map(flat.map((d, i) => [d.id, i])),
    [flat],
  );
  const urlOf = useCallback(
    (path: string, fallback?: string) => fresh[path] ?? fallback,
    [fresh],
  );

  const resign = useCallback(async (path: string) => {
    const u = await getDocUrlAction(path);
    if (u) setFresh((m) => ({ ...m, [path]: u }));
    return u ?? undefined;
  }, []);

  /** Abre el visor, re-firmando antes si la URL falta o la página lleva rato abierta. */
  const openAt = useCallback(
    async (i: number) => {
      setOpen(i);
      const d = flat[i];
      if (!d || fresh[d.path]) return;
      const stale =
        mountedAt.current > 0 && Date.now() - mountedAt.current > RESIGN_AFTER_MS;
      if (!d.url || stale) {
        setBusy(true);
        await resign(d.path);
        setBusy(false);
      }
    },
    [flat, fresh, resign],
  );

  /** Descarga cuando la firma del servidor falló: se pide una en el momento. */
  const downloadFallback = useCallback(
    async (path: string, filename: string) => {
      const u = await resign(path);
      if (u) window.location.assign(withDownloadName(u, filename));
    },
    [resign],
  );

  const openAll = flat.length <= OPEN_ALL_UP_TO;

  return (
    <>
      <div className="space-y-2">
        {groups.map((g, gi) => (
          <details
            key={g.key}
            id={`docs-${g.key}`}
            // Atributo inicial, no controlado: React no lo re-aplica en cada
            // render, así que el analista abre y cierra sin pelear con el estado.
            open={openAll || gi === 0}
            className="group rounded-xl border border-border bg-surface"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 text-muted transition-transform group-open:rotate-90"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {g.question ?? t("documentsOther")}
                </p>
                <p className="truncate text-xs text-muted">
                  {g.section ?? t("documentsOtherHint")}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-muted">
                {t("documentsCount", { count: g.docs.length })}
              </span>
            </summary>

            <ul className="border-t border-border p-1.5">
              {g.docs.map((d) => {
                const kind = fileKindOf(d.filename, d.mime);
                const url = urlOf(d.path, d.url);
                const meta = [t(`docKind_${kind}`), d.sizeLabel, d.uploadedAtLabel]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2"
                  >
                    <FileTypeIcon kind={kind} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <span className="truncate" title={d.filename}>
                          {d.filename}
                        </span>
                        {d.tag && (
                          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                            {d.tag}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted">{meta}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {isPreviewable(kind) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("docPreview")}
                          title={t("docPreview")}
                          onClick={() => void openAt(indexById.get(d.id) ?? 0)}
                        >
                          <Eye size={18} aria-hidden />
                        </Button>
                      )}
                      {url ? (
                        <a
                          href={withDownloadName(url, d.filename)}
                          rel="noopener"
                          className={ICON_LINK}
                          aria-label={t("docDownload")}
                          title={t("docDownload")}
                        >
                          <Download size={18} aria-hidden />
                        </a>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("docDownload")}
                          title={t("docDownload")}
                          onClick={() => void downloadFallback(d.path, d.filename)}
                        >
                          <Download size={18} aria-hidden />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>

      {open !== null && flat[open] && (
        <DocLightbox
          docs={flat}
          index={open}
          url={urlOf(flat[open].path, flat[open].url)}
          loading={busy}
          onIndex={(n) => void openAt(n)}
          onClose={() => setOpen(null)}
          onImageError={() => {
            // Única señal fiable de «la URL firmada caducó»: se re-firma una vez.
            const d = flat[open];
            if (d && !retried.current[d.path]) {
              retried.current[d.path] = true;
              void resign(d.path);
            }
          }}
        />
      )}
    </>
  );
}
