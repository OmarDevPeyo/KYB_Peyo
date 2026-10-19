import { AnswerField } from "@/components/admin/answerParts";
import { countryName, flagEmoji } from "@/lib/forms/countries";

/**
 * País de la IP con que se envió la solicitud, como un par pregunta/respuesta
 * más: lo usan el detalle y el informe. No es una respuesta del solicitante, así
 * que el texto llega ya traducido y la nota lo aclara.
 */
export function IpCountryField({
  code,
  locale,
  label,
  unknown,
  warning,
  hint,
}: {
  /** ISO alpha-2, o null si no hubo dato (p. ej. enviada antes de registrarlo). */
  code: string | null;
  locale: string;
  label: string;
  unknown: string;
  /** Aviso de que no coincide con lo declarado; sin él, no hay aviso. */
  warning?: string | null;
  hint?: string;
}) {
  return (
    <AnswerField
      label={label}
      footer={
        <>
          {warning && (
            <p className="mt-1.5 rounded-lg bg-warning/10 px-2 py-1 text-xs text-warning">
              {warning}
            </p>
          )}
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        </>
      }
    >
      {code ? (
        <>
          {flagEmoji(code)} {countryName(code, locale)}{" "}
          <span className="font-mono text-xs text-muted">{code}</span>
        </>
      ) : (
        <span className="text-muted">{unknown}</span>
      )}
    </AnswerField>
  );
}
