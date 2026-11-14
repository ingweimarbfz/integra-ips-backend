-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 1: base)
-- Institución de Educación para el Trabajo y el Desarrollo Humano (Decreto 1075 de 2015).
-- · Programas (cursos, diplomados, carreras técnicas) con su pensum: periodos → asignaturas.
--   billing_mode = 'total' (se cobra el valor total del programa) | 'periodo' (cada semestre tiene su valor).
-- · Grupos (cohortes) por sede, estudiantes y matrículas con su liquidación (descuento y convenio).
-- · Rol nuevo 'estudiante' (portal), logo propio del área de educación y funcionalidades del plan.
-- Todas las tablas llevan org_id (multi-cliente) con current_org_id() por defecto.
-- =====================================================================

-- ---------------------------------------------------------------- Rol estudiante
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role = any (array['administrador', 'empleado', 'conductor', 'voluntario', 'estudiante']));

-- ---------------------------------------------------------------- Logo del área de educación
alter table public.app_settings add column if not exists edu_logo_url text;

-- ---------------------------------------------------------------- Plan: público "Institución ETDH"
alter table public.plt_plans drop constraint if exists plt_plans_audience_check;
alter table public.plt_plans add constraint plt_plans_audience_check check (audience = any (array['ips', 'esal', 'etdh']));

alter table public.plt_features drop constraint if exists plt_features_grp_check;
alter table public.plt_features add constraint plt_features_grp_check
  check (grp = any (array['ips', 'estandares', 'operaciones', 'voluntariado', 'general', 'educacion']));

insert into public.plt_features (key, label, grp, module_key, description, sort_order) values
  ('edu_dashboard', 'Educación · Dashboard del director', 'educacion', 'edu_dashboard', 'Indicadores generales del instituto: matrícula, programas, grupos y alertas.', 60),
  ('edu_programas', 'Educación · Programas, pensum y grupos', 'educacion', 'edu_programas', 'Cursos, diplomados y carreras técnicas con periodos, asignaturas y horas.', 61),
  ('edu_estudiantes', 'Educación · Estudiantes y matrículas', 'educacion', 'edu_estudiantes', 'Ficha del estudiante, matrícula, descuentos y convenios.', 62),
  ('edu_portal', 'Educación · Portal del estudiante', 'educacion', 'edu_portal', 'Acceso del estudiante a su programa.', 63)
on conflict (key) do update set label = excluded.label, grp = excluded.grp, module_key = excluded.module_key, description = excluded.description, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------- Programas
create table if not exists public.edu_programs (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  code text not null,
  name text not null,
  kind text not null default 'curso' check (kind in ('curso', 'diplomado', 'seminario', 'carrera_tecnica', 'otro')),
  cert_type text not null default 'asistencia' check (cert_type in ('tecnico_laboral', 'conocimientos_academicos', 'asistencia')),
  modality text not null default 'presencial' check (modality in ('presencial', 'virtual', 'mixta')),
  billing_mode text not null default 'total' check (billing_mode in ('total', 'periodo')),
  period_label text not null default 'Semestre',
  price numeric(14, 2) not null default 0 check (price >= 0),
  registration_number text,
  registration_date date,
  registration_expires date,
  occupation text,
  description text,
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (org_id, code)
);
create index if not exists edu_programs_org_idx on public.edu_programs (org_id);

-- Periodos del pensum (semestres; un curso tiene uno solo).
create table if not exists public.edu_program_periods (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  program_id bigint not null references public.edu_programs(id) on delete cascade,
  number integer not null check (number between 1 and 20),
  name text not null,
  price numeric(14, 2) not null default 0 check (price >= 0),
  unique (program_id, number)
);
create index if not exists edu_program_periods_org_idx on public.edu_program_periods (org_id);

-- Asignaturas o módulos de cada periodo, con sus horas.
create table if not exists public.edu_subjects (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  program_id bigint not null references public.edu_programs(id) on delete cascade,
  period_id bigint not null references public.edu_program_periods(id) on delete cascade,
  code text,
  name text not null,
  kind text not null default 'teorico_practico' check (kind in ('teorico', 'practico', 'teorico_practico', 'practica_laboral')),
  hours integer not null default 0 check (hours >= 0),
  sort_order integer not null default 0
);
create index if not exists edu_subjects_org_idx on public.edu_subjects (org_id);
create index if not exists edu_subjects_period_idx on public.edu_subjects (period_id);

-- ---------------------------------------------------------------- Grupos (cohortes)
create table if not exists public.edu_groups (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  program_id bigint not null references public.edu_programs(id) on delete restrict,
  site_id bigint references public.sites(id) on delete set null,
  code text not null,
  shift text not null default 'mañana' check (shift in ('mañana', 'tarde', 'noche', 'fin_de_semana', 'mixta')),
  start_date date,
  end_date date,
  capacity integer check (capacity is null or capacity > 0),
  current_period integer not null default 1,
  status text not null default 'planeado' check (status in ('planeado', 'en_curso', 'finalizado', 'cancelado')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (org_id, code)
);
create index if not exists edu_groups_org_idx on public.edu_groups (org_id);
create index if not exists edu_groups_program_idx on public.edu_groups (program_id);

-- ---------------------------------------------------------------- Estudiantes
create table if not exists public.edu_students (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  site_id bigint references public.sites(id) on delete set null,
  doc_type text not null default 'CC',
  doc_number text not null,
  first_name text not null,
  last_name text not null,
  birth_date date,
  gender text,
  phone text,
  email text,
  address text,
  municipality text,
  eps text,
  education_level text,
  guardian_name text,
  guardian_phone text,
  user_id bigint references public.users(id) on delete set null,
  status text not null default 'activo' check (status in ('activo', 'inactivo', 'graduado', 'retirado')),
  notes text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (org_id, doc_type, doc_number)
);
create index if not exists edu_students_org_idx on public.edu_students (org_id);
create index if not exists edu_students_user_idx on public.edu_students (user_id);

-- ---------------------------------------------------------------- Matrículas
-- Un registro por programa (billing_mode 'total') o por periodo (billing_mode 'periodo').
create table if not exists public.edu_enrollments (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  student_id bigint not null references public.edu_students(id) on delete cascade,
  program_id bigint not null references public.edu_programs(id) on delete restrict,
  group_id bigint references public.edu_groups(id) on delete set null,
  period_id bigint references public.edu_program_periods(id) on delete set null,
  academic_period text,
  enrolled_at date not null default current_date,
  status text not null default 'matriculado' check (status in ('preinscrito', 'matriculado', 'aplazado', 'retirado', 'finalizado')),
  base_value numeric(14, 2) not null default 0 check (base_value >= 0),
  discount_pct numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  discount_reason text,
  agreement_name text,
  agreement_value numeric(14, 2) not null default 0 check (agreement_value >= 0),
  total_value numeric(14, 2) not null default 0 check (total_value >= 0),
  installments integer not null default 1 check (installments between 1 and 36),
  notes text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists edu_enrollments_org_idx on public.edu_enrollments (org_id);
create index if not exists edu_enrollments_student_idx on public.edu_enrollments (student_id);
create index if not exists edu_enrollments_group_idx on public.edu_enrollments (group_id);
-- Una matrícula activa por estudiante, programa y periodo.
create unique index if not exists edu_enrollments_unique_active on public.edu_enrollments (student_id, program_id, coalesce(period_id, 0))
  where status in ('preinscrito', 'matriculado', 'aplazado');

-- El backend usa la clave secreta; RLS activo sin políticas bloquea el acceso directo con la clave pública.
alter table public.edu_programs enable row level security;
alter table public.edu_program_periods enable row level security;
alter table public.edu_subjects enable row level security;
alter table public.edu_groups enable row level security;
alter table public.edu_students enable row level security;
alter table public.edu_enrollments enable row level security;
