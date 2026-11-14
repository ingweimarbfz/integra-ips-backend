-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 5: aula del curso)
-- · Material del grupo (guías, talleres, documentos, enlaces y videos) por asignatura.
-- · Entregas de los estudiantes a los talleres (archivo o enlace) con calificación y retroalimentación.
-- · Evaluaciones con peso (%) por asignatura y planilla de notas (escala 0,0 – 5,0).
-- =====================================================================
alter table public.edu_settings
  add column if not exists passing_score numeric(3, 1) not null default 3.0 check (passing_score between 0 and 5);

create table if not exists public.edu_materials (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  group_id bigint not null references public.edu_groups(id) on delete cascade,
  subject_id bigint references public.edu_subjects(id) on delete set null,
  kind text not null default 'documento' check (kind in ('guia', 'taller', 'documento', 'enlace', 'video')),
  title text not null,
  description text,
  file_url text, file_path text, file_name text, file_type text, file_size integer,
  link_url text,
  due_at timestamptz,
  allow_late boolean not null default true,
  published boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists edu_materials_org_idx on public.edu_materials (org_id);
create index if not exists edu_materials_group_idx on public.edu_materials (group_id);

create table if not exists public.edu_submissions (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  material_id bigint not null references public.edu_materials(id) on delete cascade,
  student_id bigint not null references public.edu_students(id) on delete cascade,
  file_url text, file_path text, file_name text, file_type text, file_size integer,
  link_url text,
  comment text,
  submitted_at timestamptz not null default now(),
  late boolean not null default false,
  status text not null default 'entregado' check (status in ('entregado', 'revisado', 'devuelto')),
  score numeric(3, 1) check (score is null or score between 0 and 5),
  feedback text,
  graded_by bigint references public.users(id) on delete set null,
  graded_at timestamptz,
  unique (material_id, student_id)
);
create index if not exists edu_submissions_org_idx on public.edu_submissions (org_id);

create table if not exists public.edu_grade_items (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  group_id bigint not null references public.edu_groups(id) on delete cascade,
  subject_id bigint not null references public.edu_subjects(id) on delete cascade,
  name text not null,
  kind text not null default 'otro' check (kind in ('taller', 'parcial', 'practica', 'quiz', 'final', 'otro')),
  weight numeric(5, 2) not null check (weight > 0 and weight <= 100),
  material_id bigint references public.edu_materials(id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists edu_grade_items_org_idx on public.edu_grade_items (org_id);
create index if not exists edu_grade_items_group_idx on public.edu_grade_items (group_id, subject_id);

create table if not exists public.edu_grades (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  item_id bigint not null references public.edu_grade_items(id) on delete cascade,
  student_id bigint not null references public.edu_students(id) on delete cascade,
  score numeric(3, 1) not null check (score between 0 and 5),
  comment text,
  updated_by bigint references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (item_id, student_id)
);
create index if not exists edu_grades_org_idx on public.edu_grades (org_id);

alter table public.edu_materials enable row level security;
alter table public.edu_submissions enable row level security;
alter table public.edu_grade_items enable row level security;
alter table public.edu_grades enable row level security;
