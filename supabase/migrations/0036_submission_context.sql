-- =============================================================
-- Desde dónde se envió la solicitud: IP, región, ciudad y navegador
-- -------------------------------------------------------------
-- 0034 guardó el país de la IP. Compliance de GlobalFlow pidió más: en su
-- informe quiere ver la IP, la ciudad y el dispositivo con que se envió, para
-- contrastarlos con la dirección declarada. Vercel manda la región y la ciudad
-- en `x-vercel-ip-country-region` y `x-vercel-ip-city`; la IP en `x-real-ip`.
-- La app los lee al enviar (lib/request/clientCountry.ts) y los valida en
-- lib/kyb/submissionContext.ts.
--
-- Igual que el país: guarda el del último envío, un reenvío tras pedir
-- correcciones lo pisa, y el de cada envío queda además en
-- `audit_log.metadata` (form_submitted), que no se reescribe (0033).
--
-- Es una aproximación por IP: con VPN o proxy da la ubicación del servidor.
-- Señal para el analista, no prueba.
-- =============================================================

-- Nullable: las enviadas antes de este cambio, las que no se enviaron y los
-- pedidos sin header (fuera de Vercel) no tienen valor. Los CHECK son el tope
-- de lo que la app ya recorta, para que un error no llene la fila.
alter table public.kyb_requests
  add column if not exists submitted_ip text
    constraint kyb_requests_submitted_ip_check
    check (char_length(submitted_ip) <= 45),
  add column if not exists submitted_ip_region text
    constraint kyb_requests_submitted_ip_region_check
    check (submitted_ip_region ~ '^[A-Z0-9]{1,3}$'),
  add column if not exists submitted_ip_city text
    constraint kyb_requests_submitted_ip_city_check
    check (char_length(submitted_ip_city) <= 120),
  add column if not exists submitted_user_agent text
    constraint kyb_requests_submitted_user_agent_check
    check (char_length(submitted_user_agent) <= 512);

comment on column public.kyb_requests.submitted_ip is
  'IP (v4 o v6) desde la que se envió por última vez, según Vercel.';
comment on column public.kyb_requests.submitted_ip_region is
  'Región de la IP del último envío (ISO 3166-2 sin el país), según Vercel.';
comment on column public.kyb_requests.submitted_ip_city is
  'Ciudad de la IP del último envío, según Vercel.';
comment on column public.kyb_requests.submitted_user_agent is
  'User agent del navegador con que se envió por última vez (máx. 512).';
