// Correos de las cuentas del panel: acceso (alta o reenvío), restablecer la
// contraseña, cambio de email y aviso de contraseña cambiada. Los arma la app y
// salen por Resend (lib/mail/send.ts): Supabase Auth no manda ninguno.
//
// Puro y sin dependencias, como renewalTemplate.ts: se prueba con `node --test`.

import { escapeHtml } from "./renewalTemplate.ts";

export interface AccountEmail {
  subject: string;
  html: string;
  text: string;
}

/** Lo común a todos: la URL de la app (logo y links). */
interface Base {
  appUrl: string;
}

const BRAND = "Peyo";
const PANEL = "panel KYB de Peyo";
const SIGN_OFF_EN = "Peyo KYB panel. If you weren't expecting this email, you can ignore it.";

type Block = { kind: "p"; text: string } | { kind: "code"; label: string; value: string };

/**
 * Esqueleto compartido (mismo estilo que el correo de renovación). `blocks` es
 * texto plano: se escapa acá. El botón y el link de respaldo van si hay `cta`.
 */
function layout(input: {
  appUrl: string;
  heading: string;
  blocks: Block[];
  cta?: { label: string; url: string };
  after?: string[];
}): { html: string; text: string } {
  const e = escapeHtml;
  const logo = `${input.appUrl.replace(/\/+$/, "")}/peyo-logo.png`;
  const blocksHtml = input.blocks
    .map((b) =>
      b.kind === "p"
        ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${e(b.text)}</p>`
        : `<p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#64748b;">${e(b.label)}</p>
                <p style="margin:0 0 16px;font-family:Consolas,Menlo,monospace;font-size:17px;letter-spacing:0.04em;color:#0f172a;background:#f1f5f9;border-radius:8px;padding:10px 12px;">${e(b.value)}</p>`,
    )
    .join("\n                ");
  const url = input.cta ? e(input.cta.url) : "";
  const ctaHtml = input.cta
    ? `
            <tr>
              <td style="padding:0 32px 8px;">
                <a href="${url}" style="display:inline-block;background:#2463eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px;">${e(input.cta.label)}</a>
                <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;">Si el botón no funciona, copiá y pegá este link en tu navegador:<br /><a href="${url}" style="color:#2463eb;word-break:break-all;">${url}</a></p>
              </td>
            </tr>`
    : "";
  const afterHtml = (input.after ?? [])
    .map((line) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#64748b;">${e(line)}</p>`)
    .join("\n                ");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f2f5f9;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <img src="${e(logo)}" alt="${BRAND}" height="36" style="display:block;height:36px;width:auto;" />
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${e(input.heading)}</h1>
                ${blocksHtml}
              </td>
            </tr>${ctaHtml}
            <tr>
              <td style="padding:12px 32px 16px;">
                ${afterHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#94a3b8;">${e(SIGN_OFF_EN)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  const text = [
    input.heading,
    "",
    ...input.blocks.flatMap((b) => (b.kind === "p" ? [b.text, ""] : [`${b.label}: ${b.value}`, ""])),
    ...(input.cta ? [`${input.cta.label}: ${input.cta.url}`, ""] : []),
    ...(input.after ?? []),
    ...(input.after?.length ? [""] : []),
    SIGN_OFF_EN,
  ].join("\n");

  return { html, text };
}

/**
 * Acceso al panel con una contraseña temporal: al crear la cuenta o al
 * reenviarle el acceso. Dice el rol y el login que le corresponde (cada rol
 * entra por el suyo).
 */
export function buildAccessEmail(
  input: Base & {
    email: string;
    password: string;
    /** URL completa del login de su rol (`/login` o `/admin/login`). */
    loginUrl: string;
    role: "admin" | "analyst";
    /** Reenvío: la contraseña anterior deja de servir. */
    resent: boolean;
  },
): AccountEmail {
  const asAdmin = input.role === "admin";
  const heading = input.resent ? "Tu nuevo acceso al panel KYB" : "Te damos la bienvenida al panel KYB";
  const intro = input.resent
    ? `Te generamos una contraseña nueva para ${input.email} en el ${PANEL}. La anterior ya no sirve.`
    : `Se creó una cuenta ${asAdmin ? "de administración " : ""}para ${input.email} en el ${PANEL}.`;
  const { html, text } = layout({
    appUrl: input.appUrl,
    heading,
    blocks: [
      { kind: "p", text: intro },
      { kind: "code", label: "Email", value: input.email },
      { kind: "code", label: "Contraseña temporal", value: input.password },
    ],
    cta: { label: asAdmin ? "Entrar a administración" : "Entrar al panel", url: input.loginUrl },
    after: [
      "La primera vez que entres vas a elegir tu propia contraseña y esta deja de servir. Después te vamos a ofrecer activar la verificación en dos pasos.",
      `Entrá siempre por ${input.loginUrl}.`,
    ],
  });
  return {
    subject: input.resent ? "Tu nuevo acceso al panel KYB de Peyo" : "Tu acceso al panel KYB de Peyo",
    html,
    text,
  };
}

/** Link para elegir una contraseña nueva (lo pide la persona o un admin). */
export function buildRecoveryEmail(input: Base & { email: string; link: string }): AccountEmail {
  const { html, text } = layout({
    appUrl: input.appUrl,
    heading: "Restablecé tu contraseña",
    blocks: [
      {
        kind: "p",
        text: `Recibimos un pedido para restablecer la contraseña de ${input.email} en el ${PANEL}.`,
      },
    ],
    cta: { label: "Elegir contraseña nueva", url: input.link },
    after: [
      "El link sirve una sola vez y vence en 1 hora.",
      "Si no lo pediste, ignorá este correo: tu contraseña no cambia.",
    ],
  });
  return { subject: "Restablecé tu contraseña del panel KYB", html, text };
}

/** Confirmación a la dirección NUEVA de un cambio de email. */
export function buildEmailChangeEmail(
  input: Base & { oldEmail: string; newEmail: string; link: string },
): AccountEmail {
  const { html, text } = layout({
    appUrl: input.appUrl,
    heading: "Confirmá tu nuevo email",
    blocks: [
      {
        kind: "p",
        text: `Se pidió cambiar el email de ingreso al ${PANEL} de ${input.oldEmail} a ${input.newEmail}. Para aplicar el cambio, confirmá desde acá.`,
      },
    ],
    cta: { label: "Confirmar email", url: input.link },
    after: ["El link sirve una sola vez y vence en 1 hora.", "Si no lo pediste, ignorá este correo."],
  });
  return { subject: "Confirmá tu nuevo email del panel KYB", html, text };
}

/** Aviso (sin link) a la dirección VIEJA: si no fue la persona, se entera. */
export function buildEmailChangeNoticeEmail(
  input: Base & { oldEmail: string; newEmail: string },
): AccountEmail {
  const { html, text } = layout({
    appUrl: input.appUrl,
    heading: "Se pidió cambiar tu email",
    blocks: [
      {
        kind: "p",
        text: `Desde tu cuenta del ${PANEL} se pidió cambiar el email de ingreso de ${input.oldEmail} a ${input.newEmail}. El cambio se aplica cuando se confirme desde la dirección nueva.`,
      },
    ],
    after: ["Si no fuiste vos, cambiá tu contraseña y avisá a administración."],
  });
  return { subject: "Se pidió cambiar el email de tu cuenta del panel KYB", html, text };
}

/** Aviso de que la contraseña cambió (si no fue la persona, se entera). */
export function buildPasswordChangedEmail(
  input: Base & { email: string; forgotUrl: string },
): AccountEmail {
  const { html, text } = layout({
    appUrl: input.appUrl,
    heading: "Tu contraseña cambió",
    blocks: [
      { kind: "p", text: `La contraseña de ${input.email} en el ${PANEL} se acaba de cambiar.` },
    ],
    after: [
      `Si no fuiste vos, pedí un link para restablecerla en ${input.forgotUrl} y avisá a administración.`,
    ],
  });
  return { subject: "Tu contraseña del panel KYB cambió", html, text };
}
