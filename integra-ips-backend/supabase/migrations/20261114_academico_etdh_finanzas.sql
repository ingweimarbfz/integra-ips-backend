-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 2: matrícula y finanzas)
-- · Configuración académica por organización: reglamento estudiantil y cláusulas adicionales del contrato.
-- · Catálogos de descuentos y convenios (empresas, alcaldías, IPS de práctica).
-- · Plan de cuotas de cada matrícula y pagos con recibo de caja consecutivo (los pagos se anulan, no se borran).
-- · Contrato de matrícula firmado por el estudiante (copia del texto firmado como evidencia) y aceptación del reglamento.
-- =====================================================================

create table if not exists public.edu_settings (
  org_id bigint primary key default current_org_id(),
  rules_title text not null default 'Reglamento estudiantil',
  rules_text text,
  rules_version text not null default '1.0',
  contract_clauses text,
  refund_policy text,
  updated_at timestamptz not null default now()
);

create table if not exists public.edu_discounts (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  name text not null,
  pct numeric(5, 2) not null check (pct > 0 and pct <= 100),
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index if not exists edu_discounts_org_idx on public.edu_discounts (org_id);

create table if not exists public.edu_agreements (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  name text not null,
  nit text,
  kind text not null default 'empresa' check (kind in ('empresa', 'entidad_publica', 'ips_practica', 'fundacion', 'otro')),
  contribution_pct numeric(5, 2) not null default 0 check (contribution_pct between 0 and 100),
  contact_name text,
  phone text,
  email text,
  starts_on date,
  ends_on date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (org_id, name)
);
create index if not exists edu_agreements_org_idx on public.edu_agreements (org_id);

alter table public.edu_enrollments
  add column if not exists discount_id bigint references public.edu_discounts(id) on delete set null,
  add column if not exists agreement_id bigint references public.edu_agreements(id) on delete set null,
  add column if not exists first_due_date date,
  add column if not exists contract_required boolean not null default false,
  add column if not exists contract_signed_at timestamptz,
  add column if not exists contract_signer_name text,
  add column if not exists contract_signer_doc text,
  add column if not exists contract_signature_url text,
  add column if not exists contract_snapshot jsonb,
  add column if not exists contract_ip text,
  add column if not exists contract_signed_by_user bigint references public.users(id) on delete set null,
  add column if not exists rules_accepted_at timestamptz,
  add column if not exists rules_version text;

-- Plan de cuotas. El estado (pagada, parcial, vencida) se calcula aplicando los pagos en orden de vencimiento.
create table if not exists public.edu_installments (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  enrollment_id bigint not null references public.edu_enrollments(id) on delete cascade,
  number integer not null check (number between 1 and 36),
  due_date date not null,
  amount numeric(14, 2) not null check (amount >= 0),
  unique (enrollment_id, number)
);
create index if not exists edu_installments_org_idx on public.edu_installments (org_id);

-- Pagos con recibo de caja consecutivo por organización. Una matrícula con pagos no se puede borrar.
create table if not exists public.edu_payments (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  enrollment_id bigint not null references public.edu_enrollments(id) on delete restrict,
  receipt_number integer not null,
  paid_at date not null,
  amount numeric(14, 2) not null check (amount > 0),
  method text not null default 'efectivo' check (method in ('efectivo', 'transferencia', 'tarjeta', 'consignacion', 'convenio', 'otro')),
  reference text,
  notes text,
  voided boolean not null default false,
  voided_reason text,
  voided_at timestamptz,
  voided_by bigint references public.users(id) on delete set null,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, receipt_number)
);
create index if not exists edu_payments_org_idx on public.edu_payments (org_id);
create index if not exists edu_payments_enrollment_idx on public.edu_payments (enrollment_id);

alter table public.edu_settings enable row level security;
alter table public.edu_discounts enable row level security;
alter table public.edu_agreements enable row level security;
alter table public.edu_installments enable row level security;
alter table public.edu_payments enable row level security;

-- Matrículas que ya existían: plan de cuotas iguales, mensuales desde la fecha de matrícula.
insert into public.edu_installments (org_id, enrollment_id, number, due_date, amount)
select e.org_id, e.id, n,
  (e.enrolled_at + ((n - 1) * interval '1 month'))::date,
  case when n < e.installments then round(e.total_value / e.installments, 0)
       else e.total_value - round(e.total_value / e.installments, 0) * (e.installments - 1) end
from public.edu_enrollments e
cross join lateral generate_series(1, e.installments) n
where not exists (select 1 from public.edu_installments i where i.enrollment_id = e.id);

-- Carreras técnicas: el contrato de matrícula es obligatorio.
update public.edu_enrollments e set contract_required = true
from public.edu_programs p where p.id = e.program_id and p.kind = 'carrera_tecnica' and not e.contract_required;
