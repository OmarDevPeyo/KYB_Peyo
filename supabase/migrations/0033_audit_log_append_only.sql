-- =============================================================
-- audit_log no se reescribe
-- -------------------------------------------------------------
-- La auditoría solo tenía RLS, y el service-role se la saltea: cualquier
-- UPDATE o DELETE de la app, de un script o de una consulta a mano cambiaba la
-- historia sin dejar rastro. Nada en la app actualiza ni borra audit_log (solo
-- inserta), así que esto no cambia ningún flujo. Una corrección es un evento
-- nuevo.
--
-- Única excepción: la FK `request_id ... on delete set null` (0001). Borrar
-- una solicitud deja sus eventos con `request_id` null; el evento en sí no
-- cambia. Una solicitud enviada ya no se puede borrar (0032), así que esto solo
-- alcanza a las que nunca se enviaron.
-- =============================================================

create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.request_id is not null
     and new.request_id is null
     and (to_jsonb(new) - 'request_id') = (to_jsonb(old) - 'request_id') then
    return new;
  end if;
  raise exception 'audit_log es append-only: no admite %', tg_op
    using errcode = 'check_violation';
  return null;
end;
$$;

revoke execute on function public.audit_log_append_only() from public;

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

-- `reject_append_only_change` es la función genérica de 0032.
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.reject_append_only_change();
