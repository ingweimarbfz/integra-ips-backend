-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 3: horarios y clases)
-- · Rol 'docente': ve su panel con sus clases y grupos.
-- · Horarios recurrentes por grupo y asignatura (días, horas, modalidad, salón o enlace, vigencia).
-- · Clases concretas generadas desde el horario (se reprograman, cambian de enlace o se cancelan una a una).
-- · Grupo de Telegram de cada grupo académico (avisos de clases) y módulo "Panel del docente" en los planes.
-- =====================================================================

alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role = any (array['administrador', 'empleado', 'conductor', 'voluntario', 'estudiante', 'docente']));

alter table public.edu_groups
  add column if not exists telegram_chat_id text,
  add column if not exists telegram_title text;

insert into public.plt_features (key, label, grp, module_key, description, sort_order) values
  ('edu_docente', 'Educación · Panel del docente', 'educacion', 'edu_docente', 'Clases del día, horario, grupos y enlace a las clases virtuales.', 64)
on conflict (key) do update set label = excluded.label, grp = excluded.grp, module_key = excluded.module_key, description = excluded.description, sort_order = excluded.sort_order;
update public.plt_plans set features = (select array_agg(distinct f) from unnest(features || array['edu_docente']) f), updated_at = now()
where code in ('educacion', 'humanitario') and not ('edu_docente' = any (features));

-- Horario recurrente (plantilla): genera las clases entre starts_on y ends_on en los días indicados (1 = lunes … 7 = domingo).
create table if not exists public.edu_schedules (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  group_id bigint not null references public.edu_groups(id) on delete cascade,
  subject_id bigint references public.edu_subjects(id) on delete set null,
  teacher_user_id bigint references public.users(id) on delete set null,
  modality text not null default 'presencial' check (modality in ('presencial', 'virtual')),
  platform text check (platform in ('meet', 'teams', 'zoom', 'otro')),
  meeting_url text,
  location text,
  weekdays integer[] not null check (array_length(weekdays, 1) between 1 and 7),
  start_time time not null,
  end_time time not null,
  starts_on date not null,
  ends_on date not null,
  notes text,
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  check (end_time > start_time),
  check (ends_on >= starts_on)
);
create index if not exists edu_schedules_org_idx on public.edu_schedules (org_id);
create index if not exists edu_schedules_group_idx on public.edu_schedules (group_id);

-- Cada clase (sesión) concreta: es la que se reprograma, se cancela y, en la fase 4, la que lleva la asistencia.
create table if not exists public.edu_sessions (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  schedule_id bigint references public.edu_schedules(id) on delete set null,
  group_id bigint not null references public.edu_groups(id) on delete cascade,
  subject_id bigint references public.edu_subjects(id) on delete set null,
  teacher_user_id bigint references public.users(id) on delete set null,
  date date not null,
  start_time time not null,
  end_time time not null,
  modality text not null default 'presencial' check (modality in ('presencial', 'virtual')),
  platform text check (platform in ('meet', 'teams', 'zoom', 'otro')),
  meeting_url text,
  location text,
  topic text,
  status text not null default 'programada' check (status in ('programada', 'realizada', 'cancelada')),
  cancel_reason text,
  rescheduled_from date,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  check (end_time > start_time)
);
create index if not exists edu_sessions_org_idx on public.edu_sessions (org_id);
create index if not exists edu_sessions_group_date_idx on public.edu_sessions (group_id, date);
create index if not exists edu_sessions_teacher_date_idx on public.edu_sessions (teacher_user_id, date);

alter table public.edu_schedules enable row level security;
alter table public.edu_sessions enable row level security;
