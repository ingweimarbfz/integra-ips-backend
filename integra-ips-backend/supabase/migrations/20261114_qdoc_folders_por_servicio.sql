-- IIPS-018: cada servicio de IPS tiene su propio árbol de carpetas en Doc. Generales.
-- service_id NULL = carpetas generales (las existentes). Las subcarpetas heredan el servicio de su ítem principal.
alter table public.qdoc_folders add column if not exists service_id bigint references public.ips_services(id) on delete restrict;
create index if not exists qdoc_folders_service_idx on public.qdoc_folders (service_id);
