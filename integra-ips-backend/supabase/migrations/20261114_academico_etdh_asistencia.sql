-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 4: asistencia con firmas)
-- · Asistencia por clase: checklist del docente (presente, tarde, excusa, ausente) y firma de cada estudiante.
-- · Acta de la clase: la cierra el docente con su firma y la firma el director de educación.
-- · Formato institucional del acta (código, nombre y versión), asistencia mínima y director de educación.
-- =====================================================================

alter table public.edu_settings
  add column if not exists attendance_format_code text,
  add column if not exists attendance_format_name text not null default 'Registro de asistencia',
  add column if not exists attendance_format_version text,
  add column if not exists min_attendance_pct numeric(5, 2) not null default 80 check (min_attendance_pct between 0 and 100),
  add column if not exists director_user_id bigint references public.users(id) on delete set null;

alter table public.edu_sessions
  add column if not exists attendance_taken_at timestamptz,
  add column if not exists attendance_taken_by bigint references public.users(id) on delete set null,
  add column if not exists teacher_signed_at timestamptz,
  add column if not exists teacher_signed_by bigint references public.users(id) on delete set null,
  add column if not exists teacher_signature_url text,
  add column if not exists director_signed_at timestamptz,
  add column if not exists director_user_id bigint references public.users(id) on delete set null,
  add column if not exists director_signature_url text;

create table if not exists public.edu_attendance (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  session_id bigint not null references public.edu_sessions(id) on delete cascade,
  student_id bigint not null references public.edu_students(id) on delete cascade,
  enrollment_id bigint references public.edu_enrollments(id) on delete set null,
  status text not null check (status in ('presente', 'tarde', 'excusa', 'ausente')),
  arrived_at time,
  note text,
  student_signed_at timestamptz,
  student_signature_url text,
  signed_from text check (signed_from in ('presencial', 'portal')),
  updated_by bigint references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (session_id, student_id)
);
create index if not exists edu_attendance_org_idx on public.edu_attendance (org_id);
create index if not exists edu_attendance_student_idx on public.edu_attendance (student_id);
alter table public.edu_attendance enable row level security;
