import { AnswerField } from "@/components/admin/answerParts";

/**
 * IP, ciudad y región de la IP, y navegador con que se envió la solicitud
 * (0036). Van al lado del país ({@link IpCountryField}) y, como él, no son
 * respuestas del solicitante: los textos llegan ya traducidos.
 *
 * Cada campo aparece solo si hay dato. Las enviadas antes de 0036 solo tienen
 * el país, y ahí esto no pinta nada.
 */
export function SubmissionOriginFields({
  ip,
  ipCity,
  ipRegion,
  userAgent,
  labels,
}: {
  ip: string | null;
  ipCity: string | null;
  ipRegion: string | null;
  userAgent: string | null;
  labels: { ip: string; location: string; userAgent: string };
}) {
  const location = [ipCity, ipRegion].filter(Boolean).join(" · ");
  return (
    <>
      {ip && (
        <AnswerField label={labels.ip}>
          <span className="font-mono text-xs">{ip}</span>
        </AnswerField>
      )}
      {location && <AnswerField label={labels.location}>{location}</AnswerField>}
      {userAgent && (
        <AnswerField label={labels.userAgent} long>
          <span className="break-all font-mono text-xs text-muted">{userAgent}</span>
        </AnswerField>
      )}
    </>
  );
}
