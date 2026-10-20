-- =============================================================
-- Formularios del sistema
-- -------------------------------------------------------------
-- Un formulario del sistema se define en el código (lib/forms/system/) y la
-- app lo instala en una organización: el cron /api/cron/sync-system-forms o la
-- acción de admin «Instalar». Quien lo consume (GlobalFlow) depende de sus
-- claves y valores, así que no se edita desde el panel: se cambia con un
-- deploy. El panel lo muestra solo para leer y permite duplicarlo.
--
--   system_key      identificador estable del formulario en el código
--                   (ej. 'globalflow-kyb-empresas').
--   system_version  versión de la definición en el código que está instalada.
--
-- No se usa `source = 'system'`: `duplicateForm` copia `source`, y las copias
-- quedarían marcadas como del sistema. La copia sale sin estas columnas.
--
-- La definición también lleva `meta.system = {key, version}`, que queda
-- congelado en cada solicitud y sale por la API (`form`).
-- =============================================================

alter table public.forms
  add column if not exists system_key text,
  add column if not exists system_version integer;

alter table public.forms
  drop constraint if exists forms_system_version_check;
alter table public.forms
  add constraint forms_system_version_check
    check ((system_key is null) = (system_version is null) and (system_version is null or system_version > 0));

-- Un formulario del sistema por clave y organización: la sincronización
-- actualiza esa fila, no crea otra.
create unique index if not exists forms_org_system_key_uniq
  on public.forms (org_id, system_key)
  where system_key is not null;

comment on column public.forms.system_key is
  'Clave del formulario del sistema (lib/forms/system/). Null en los formularios del panel. Con valor, el panel no lo edita.';
comment on column public.forms.system_version is
  'Versión de la definición del sistema instalada. Null si system_key es null.';
