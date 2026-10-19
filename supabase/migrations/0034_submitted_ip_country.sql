-- =============================================================
-- País de la IP con que se envió la solicitud
-- -------------------------------------------------------------
-- Vercel geolocaliza cada pedido y manda el país (ISO 3166-1 alpha-2) en el
-- header `x-vercel-ip-country`. La app lo lee al enviar el formulario
-- (lib/request/clientCountry.ts) y lo guarda acá: es un dato que el solicitante
-- no responde, para que el analista vea desde dónde se envió y lo compare con
-- los países que declaró.
--
-- Guarda el del último envío: un reenvío tras pedir correcciones lo pisa. El
-- de cada envío queda además en `audit_log.metadata.ipCountry` (form_submitted),
-- que no se reescribe (0033).
--
-- Es una aproximación por IP: con VPN o proxy da el país del servidor. Señal
-- para el analista, no prueba.
-- =============================================================

-- Nullable: las enviadas antes de este cambio, las que no se enviaron y los
-- pedidos sin header (fuera de Vercel) no tienen valor.
alter table public.kyb_requests
  add column if not exists submitted_ip_country text
    constraint kyb_requests_submitted_ip_country_check
    check (submitted_ip_country ~ '^[A-Z]{2}$');

comment on column public.kyb_requests.submitted_ip_country is
  'País (ISO 3166-1 alpha-2) de la IP desde la que se envió por última vez, según Vercel.';
