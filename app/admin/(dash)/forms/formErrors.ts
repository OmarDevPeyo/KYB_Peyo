import type { FormActionErrorCode } from "./actions";

/** Sin augmentación de `IntlMessages`, `t` es simplemente (key, values) => string. */
type Translator = (key: string, values?: Record<string, string | number>) => string;

export interface ActionError {
  error: string;
  code?: FormActionErrorCode;
  params?: Record<string, string | number>;
}

/**
 * Traduce el rechazo de un action de formularios. Los actions devuelven un
 * CÓDIGO + `params` (el panel es bilingüe) y un `error` en español de fallback,
 * que es lo que se usa para los errores crudos de la base.
 *
 * Espera un `t` del namespace "forms".
 */
export function formActionError(t: Translator, res: ActionError): string {
  switch (res.code) {
    case "assigned_to_client":
      return t("errorAssignedToClient", { clients: String(res.params?.clients ?? "") });
    case "requests_no_snapshot":
      return t("errorRequestsNoSnapshot", { count: Number(res.params?.count ?? 0) });
    case "system_form":
      return t("errorSystemForm");
    default:
      return res.error;
  }
}
