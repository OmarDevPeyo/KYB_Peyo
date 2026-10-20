import { resolveText, type Field } from "./definition";
import { formatNaics } from "./naics";

export type FileRef = { path: string; filename: string };

// Sí/No por locale: `renderAnswer` alimenta el panel Y la respuesta de
// `GET /api/v1/kyb/requests/:id/answers?locale=`, así que hardcodear español
// devolvía texto en el idioma equivocado a los clientes de la API.
const BOOLEAN_TEXT = {
  es: { yes: "Sí", no: "No" },
  en: { yes: "Yes", no: "No" },
} as const;

/** Extrae los FileRef ({path, filename}) del valor de un campo file/selfie. */
export function fileRefsOf(value: unknown): FileRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) =>
    r && typeof r === "object" && "path" in r
      ? [
          {
            path: String((r as { path: unknown }).path),
            filename:
              "filename" in r ? String((r as { filename: unknown }).filename) : "archivo",
          },
        ]
      : [],
  );
}

/** Formatea el valor de una respuesta de forma legible según el tipo del campo. */
export function renderAnswer(
  field: Field,
  value: unknown,
  locale: string,
): string {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return "—";
  }

  switch (field.type) {
    case "single_choice":
    case "dropdown": {
      const opt = field.options?.find((o) => o.value === String(value));
      return opt ? resolveText(opt.label, locale) : String(value);
    }
    case "multiple_choice": {
      const arr = Array.isArray(value) ? value : [value];
      return (
        arr
          .map((v) => {
            const opt = field.options?.find((o) => o.value === String(v));
            return opt ? resolveText(opt.label, locale) : String(v);
          })
          .join(", ") || "—"
      );
    }
    case "file": {
      const arr = Array.isArray(value) ? value : [];
      return (
        arr
          .map((r) =>
            r && typeof r === "object" && "filename" in r
              ? String((r as { filename: unknown }).filename)
              : String(r),
          )
          .join(", ") || "—"
      );
    }
    case "naics":
      return formatNaics(String(value), locale);
    case "boolean":
      return BOOLEAN_TEXT[locale === "en" ? "en" : "es"][value === true ? "yes" : "no"];
    default:
      return String(value);
  }
}

/**
 * ¿La respuesta es texto libre largo? Decide tres cosas de presentación: si se
 * respetan los saltos de línea que escribió el solicitante, si se limita la
 * medida para que el párrafo sea legible, y si ocupa la fila entera de la
 * rejilla de dos columnas. El umbral cubre el `short_text` que en la práctica se
 * usó como párrafo.
 */
export function isLongAnswer(field: Field, value: unknown): boolean {
  if (field.type === "file" || field.type === "selfie") return false;
  if (field.type === "long_text") return true;
  return typeof value === "string" && value.length > 120;
}
