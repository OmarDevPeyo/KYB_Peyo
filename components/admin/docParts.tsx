import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";
import { buttonClass } from "@/components/ui/Button";

/**
 * Piezas compartidas de la sección «Documentos»: los tipos serializables que el
 * RSC arma y el panel cliente consume, la clasificación de archivos por tipo y
 * el icono de cada uno.
 *
 * Sin `"use client"` a propósito: `page.tsx` (RSC) importa los tipos y
 * `formatBytes`; `DocumentsPanel`/`DocLightbox` importan lo demás.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const SHEET_EXT_RE = /\.(xlsx?|xlsm|csv|ods|numbers)$/i;
const DOC_EXT_RE = /\.(docx?|odt|rtf|txt|pages)$/i;

/** True si el archivo parece una imagen (por mime o por extensión del nombre). */
export function isImagePath(filename: string, mime?: string | null): boolean {
  if (mime && mime.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(filename);
}

export type FileKind = "pdf" | "image" | "sheet" | "doc" | "other";

/**
 * Tipo del archivo. El mime manda, pero se cae a la extensión del nombre
 * original porque `kyb_documents.mime` es nullable (filas del flujo legacy) y
 * porque la subida guarda `application/octet-stream` cuando el navegador no
 * reconoció el archivo.
 */
export function fileKindOf(filename: string, mime?: string | null): FileKind {
  const m = mime ?? "";
  if (m === "application/pdf" || PDF_EXT_RE.test(filename)) return "pdf";
  if (isImagePath(filename, mime)) return "image";
  if (
    m === "text/csv" ||
    m.includes("spreadsheet") ||
    m.includes("ms-excel") ||
    SHEET_EXT_RE.test(filename)
  ) {
    return "sheet";
  }
  if (
    m.includes("wordprocessing") ||
    m.includes("msword") ||
    m.startsWith("text/") ||
    DOC_EXT_RE.test(filename)
  ) {
    return "doc";
  }
  return "other";
}

/** Solo imagen y PDF se pintan dentro del visor; el resto ofrece descarga. */
export function isPreviewable(kind: FileKind): boolean {
  return kind === "image" || kind === "pdf";
}

/** Documento ya firmado y formateado por el RSC: nada que calcular en cliente. */
export type DocRow = {
  id: string;
  filename: string;
  /** Ruta en el bucket privado; sirve para re-firmar si la URL caduca. */
  path: string;
  mime: string | null;
  /** URL firmada en el servidor (TTL 1 h). Ausente si la firma falló. */
  url?: string;
  /** «1,4 MB» ya formateado con el locale del servidor. */
  sizeLabel: string | null;
  /** ISO crudo, para el `dateTime` de `<time>`. */
  uploadedAt: string | null;
  /**
   * Fecha ya formateada en el servidor: formatearla en cliente rompería la
   * hidratación, porque `i18n/request.ts` no fija `timeZone` y el SSR corre en
   * UTC mientras el navegador usa la zona del analista.
   */
  uploadedAtLabel: string | null;
  /** Etiqueta ya traducida: versión anterior o subida de una renovación. */
  tag?: string | null;
};

/** Documentos de una misma pregunta. `question === null` ⇒ grupo de huérfanos. */
export type DocGroup = {
  /** `doc_type` del documento (= key del campo), o `__other__` para huérfanos. */
  key: string;
  question: string | null;
  section: string | null;
  docs: DocRow[];
};

/** Tamaño legible. `null` si la fila no trae `size` (la columna es opcional). */
export function formatBytes(bytes: unknown, locale: string): string | null {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ["B", "kB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  return `${num} ${units[i]}`;
}

/**
 * Convierte una URL ya firmada en una de descarga forzada. Es literalmente lo
 * que hace supabase-js en `createSignedUrls({ download })`: añadir
 * `&download=<nombre>` para que Storage responda con `Content-Disposition:
 * attachment`. Por eso no hace falta una API route que proxee los bytes.
 *
 * Hace falta sí o sí: el atributo HTML `download` de un `<a>` se ignora cuando
 * el destino es cross-origin —y estas URLs apuntan al dominio de Supabase—, así
 * que sin el parámetro el archivo se bajaría con el UUID del path por nombre.
 *
 * (El `download` por lote de `createSignedUrls` no sirve aquí: es un único
 * nombre para todos los archivos del lote.)
 */
export function withDownloadName(signedUrl: string, filename: string): string {
  const sep = signedUrl.includes("?") ? "&" : "?";
  return `${signedUrl}${sep}download=${encodeURIComponent(filename)}`;
}

/* El color ayuda a barrer la lista de un vistazo, pero nunca es la única señal:
   la forma del icono y la extensión del nombre distinguen igual en monocromo. */
const KIND: Record<FileKind, { Icon: LucideIcon; className: string }> = {
  pdf: { Icon: FileText, className: "text-danger" },
  image: { Icon: FileImage, className: "text-brand" },
  sheet: { Icon: FileSpreadsheet, className: "text-success" },
  doc: { Icon: FileType, className: "text-warning" },
  other: { Icon: File, className: "text-muted" },
};

export function FileTypeIcon({
  kind,
  size = 20,
  className = "",
}: {
  kind: FileKind;
  size?: number;
  className?: string;
}) {
  const { Icon, className: color } = KIND[kind];
  return <Icon size={size} aria-hidden className={`${color} ${className}`} />;
}

/** Misma caja que `<Button variant="ghost" size="icon">`, para un `<a>`. */
export const ICON_LINK = buttonClass({ variant: "ghost", size: "icon" });
