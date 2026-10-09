import { redirect } from "next/navigation";
import { getAuthState, loginPathFor } from "@/lib/auth/admin";
import { WelcomeFlow } from "./WelcomeFlow";

export const dynamic = "force-dynamic";

/**
 * Primer ingreso con la contraseña temporal que llegó por correo: la persona
 * elige la suya y después se le ofrece activar el 2FA.
 *
 * Con la cuenta ya activa y sin 2FA se muestra directo la oferta: guardar la
 * contraseña renueva la cookie de sesión y Next vuelve a renderizar esta
 * página, que no puede mandarla al panel antes de ofrecerle el 2FA.
 */
export default async function WelcomePage() {
  const s = await getAuthState();
  switch (s.state.kind) {
    case "signed_out":
      redirect(await loginPathFor(null));
    case "mfa_pending":
      redirect("/auth/mfa");
    case "suspended":
      redirect("/auth/suspended");
    case "no_account":
      redirect(`${await loginPathFor(null)}?error=forbidden`);
    case "active":
      if (s.analyst?.mfaEnabled) redirect("/admin");
      break;
    case "password_setup":
      break;
  }

  return (
    <WelcomeFlow
      email={s.email ?? ""}
      isAdmin={s.role === "admin"}
      initialStep={s.state.kind === "active" ? "mfa" : "password"}
    />
  );
}
