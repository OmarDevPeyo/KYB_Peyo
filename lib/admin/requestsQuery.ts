/**
 * Query string del listado de solicitudes (`/admin`).
 *
 * La arman tres lugares —la paginación de la página, la barra de filtros y
 * las pestañas de organización— y antes cada uno la construía a mano: agregar
 * un filtro (`org`) exigía acordarse de los tres. Puro, sin `@/`, para
 * probarlo con `node --test`.
 */

export interface RequestsQuery {
  /** Pestaña de organización (solo admin). Vacío = todas. */
  org: string;
  q: string;
  status: string;
  form: string;
  /** País de la IP del envío (alpha-2, `submitted_ip_country`). */
  country: string;
  from: string;
  to: string;
  page: number;
}

export const EMPTY_REQUESTS_QUERY: RequestsQuery = {
  org: "",
  q: "",
  status: "",
  form: "",
  country: "",
  from: "",
  to: "",
  page: 1,
};

/** Orden fijo de los parámetros: URLs estables, fáciles de comparar. */
const KEYS = ["org", "q", "status", "form", "country", "from", "to"] as const;

export function requestsHref(query: Partial<RequestsQuery>): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

/**
 * Cambio de pestaña de org. Se conservan búsqueda, estado, país y fechas, pero NO el
 * formulario (es de una org concreta: filtrar por el de otra da vacío) ni la
 * página (la nueva lista tiene otro largo).
 */
export function withOrg(query: Partial<RequestsQuery>, org: string): string {
  return requestsHref({ ...query, org, form: "", page: 1 });
}

/** "Limpiar filtros": vuelve a la lista entera, pero sin salir de la pestaña. */
export function clearedFilters(query: Partial<RequestsQuery>): string {
  return requestsHref({ org: query.org ?? "" });
}
