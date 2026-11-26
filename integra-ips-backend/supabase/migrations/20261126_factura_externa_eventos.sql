-- IIPS-038 · Factura en vacunación y eventos programados.
-- Con Facturación activa se enlaza la factura del sistema; sin ella se escribe el N° de la factura de otro sistema.
alter table public.vaccination_records add column if not exists external_invoice text;
alter table public.planned_events add column if not exists charge_id bigint references public.service_charges(id) on delete set null;
alter table public.planned_events add column if not exists invoice_number text;
alter table public.planned_events add column if not exists invoiced_at timestamptz;
create unique index if not exists planned_events_charge_uidx on public.planned_events (charge_id) where charge_id is not null;
-- Educación sin Facturación: cada pago o abono lleva el N° de la factura del sistema externo.
alter table public.edu_payments add column if not exists external_invoice text;
notify pgrst, 'reload schema';
