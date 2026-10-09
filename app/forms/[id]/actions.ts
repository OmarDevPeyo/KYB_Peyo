"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { createRequest } from "@/lib/kyb/service";
import { getPublishedForm } from "@/lib/forms/store";
import { consumeRate } from "@/lib/auth/rateLimit";
import { clientIp } from "@/lib/request/clientIp";

/**
 * Intakes por minuto y por IP. Holgado para un humano llenando el formulario
 * (que arranca uno), suficiente para que una IP no genere solicitudes en masa.
 * Va por formulario para que el abuso de uno no bloquee a los demás.
 */
const INTAKE_PER_MIN = 10;

/**
 * Intake público: crea una solicitud real para un formulario PUBLICADO y
 * redirige al flujo por token (`/f/[token]`), que ya maneja autosave, subida
 * de archivos, submit y persistencia. Así el enlace público `/forms/[id]`
 * recolecta respuestas de verdad en vez de ser solo vista previa.
 */
export async function startPublicIntake(
  formId: string,
): Promise<{ ok: false; error: string }> {
  // Solo formularios publicados pueden recibir intake público.
  const form = await getPublishedForm(formId);
  if (!form) {
    return { ok: false, error: "Este formulario no está disponible." };
  }

  // Esta acción no tiene autenticación de ningún tipo y escribe en la base, así
  // que el límite por IP es lo único que la separa de un generador de filas.
  const ip = await clientIp();
  const rate = await consumeRate(`intake:${formId}:${ip}`, INTAKE_PER_MIN);
  if (!rate.allowed) {
    console.warn(`[startPublicIntake] rate limit form=${formId} ip=${ip}`);
    return { ok: false, error: "Demasiados intentos. Intenta de nuevo en un minuto." };
  }

  let token: string;
  try {
    // external_ref distintivo para que admin identifique los intakes públicos.
    const externalRef = `public:${randomUUID().slice(0, 8)}`;
    // La solicitud es de la org dueña del formulario: sin API key, es lo único
    // que la ata a un cliente.
    const created = await createRequest({
      orgId: form.org_id,
      externalRef,
      form: { id: form.id, revision: form.version },
      formDefinition: form.definition,
    });
    token = created.token;
  } catch (e) {
    console.error("[startPublicIntake] falló", e);
    return { ok: false, error: "No se pudo iniciar la solicitud. Intenta de nuevo." };
  }

  // redirect() debe ir fuera del try/catch (lanza NEXT_REDIRECT internamente).
  redirect(`/f/${token}`);
}
