-- =====================================================================
-- IIPS-019 · Académico ETDH (ajustes de la fase 2: descuentos, planes de pago y facturación)
-- · Descuentos con el mismo diseño de IPS: porcentaje o valor fijo, ícono y color.
-- · Planes de pago configurables por tipo de programa (número de cuotas y periodicidad).
-- · Factura por matrícula (al estudiante) y factura aparte al convenio por su aporte.
--   Usan la misma numeración DIAN de la IPS (next_invoice_number, consecutivo por organización).
-- =====================================================================

-- ---------------------------------------------------------------- Descuentos (porcentaje o valor fijo)
alter table public.edu_discounts
  add column if not exists type text not null default 'porcentaje' check (type in ('porcentaje', 'valor')),
  add column if not exists value numeric(14, 2),
  add column if not exists icon text not null default 'handshake',
  add column if not exists color text not null default '#14B8A6',
  add column if not exists updated_at timestamptz;
update public.edu_discounts set value = pct where value is null;
alter table public.edu_discounts alter column value set not null;
alter table public.edu_discounts drop constraint if exists edu_discounts_value_check;
alter table public.edu_discounts add constraint edu_discounts_value_check check (value > 0 and (type = 'valor' or value <= 100));
alter table public.edu_discounts drop column if exists pct;

-- ---------------------------------------------------------------- Planes de pago
create table if not exists public.edu_payment_plans (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  name text not null,
  program_kind text not null default 'todos' check (program_kind in ('todos', 'curso', 'diplomado', 'seminario', 'carrera_tecnica', 'otro')),
  installments integer not null check (installments between 1 and 36),
  interval_months integer not null default 1 check (interval_months between 1 and 12),
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index if not exists edu_payment_plans_org_idx on public.edu_payment_plans (org_id);
alter table public.edu_payment_plans enable row level security;

-- ---------------------------------------------------------------- Matrícula: descuento, plan y facturas
alter table public.edu_enrollments
  add column if not exists discount_value numeric(14, 2) not null default 0 check (discount_value >= 0),
  add column if not exists payment_plan_id bigint references public.edu_payment_plans(id) on delete set null,
  add column if not exists invoice_number text,
  add column if not exists invoiced_at timestamptz,
  add column if not exists agreement_invoice_number text,
  add column if not exists agreement_invoiced_at timestamptz,
  add column if not exists invoice_voided jsonb not null default '[]'::jsonb;
-- Valor del descuento de las matrículas existentes (antes solo había porcentaje).
update public.edu_enrollments set discount_value = round(base_value * discount_pct / 100, 2) where discount_value = 0 and discount_pct > 0;

-- Planes de pago iniciales para las organizaciones que ya usan Educación.
insert into public.edu_payment_plans (org_id, name, program_kind, installments, description, sort_order)
select o.org_id, p.name, p.kind, p.n, p.d, p.s
from (select distinct org_id from public.edu_programs) o
cross join (values
  ('De contado', 'todos', 1, 'Un solo pago al matricular', 1),
  ('Carrera técnica · semestre en 4 cuotas', 'carrera_tecnica', 4, 'Cuotas mensuales durante el semestre', 2),
  ('Carrera técnica · semestre en 6 cuotas', 'carrera_tecnica', 6, 'Cuotas mensuales durante el semestre', 3),
  ('Curso en 2 cuotas', 'curso', 2, 'Mitad al matricular y mitad al mes siguiente', 4),
  ('Diplomado en 3 cuotas', 'diplomado', 3, 'Cuotas mensuales', 5)
) as p(name, kind, n, d, s)
on conflict (org_id, name) do nothing;
