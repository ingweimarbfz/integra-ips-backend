-- =====================================================================
-- IIPS-019 · Aulas y salones configurables y control de cruces
-- · Catálogo de aulas por sede (aula, laboratorio, sala de simulación, auditorio, escenario de práctica).
-- · Horarios y clases presenciales usan un aula del catálogo; el backend no deja programar dos clases a la vez
--   en la misma aula, con el mismo docente, con el mismo grupo ni con estudiantes en común.
-- =====================================================================
create table if not exists public.edu_classrooms (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  site_id bigint references public.sites(id) on delete set null,
  name text not null,
  kind text not null default 'aula' check (kind in ('aula', 'laboratorio', 'simulacion', 'auditorio', 'practica', 'otro')),
  capacity integer check (capacity is null or capacity > 0),
  resources text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (org_id, site_id, name)
);
create index if not exists edu_classrooms_org_idx on public.edu_classrooms (org_id);
alter table public.edu_classrooms enable row level security;

alter table public.edu_schedules add column if not exists classroom_id bigint references public.edu_classrooms(id) on delete set null;
alter table public.edu_sessions add column if not exists classroom_id bigint references public.edu_classrooms(id) on delete set null;
create index if not exists edu_sessions_classroom_date_idx on public.edu_sessions (classroom_id, date);
