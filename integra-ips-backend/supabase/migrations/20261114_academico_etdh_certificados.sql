-- =====================================================================
-- IIPS-019 · Académico ETDH (fase 6: certificados y acreditación)
-- · Certificados con consecutivo por organización y código de verificación pública; se anulan, no se borran.
-- · Acreditación: el árbol de carpetas de Doc. Generales también sirve al área de Educación
--   (qdoc_folders.area = 'educacion'), con un árbol institucional y uno por programa (edu_program_id).
-- =====================================================================
create table if not exists public.edu_certificates (
  id bigserial primary key,
  org_id bigint not null default current_org_id(),
  number integer not null,
  student_id bigint not null references public.edu_students(id) on delete restrict,
  program_id bigint not null references public.edu_programs(id) on delete restrict,
  cert_type text not null,
  title text not null,
  hours integer not null default 0,
  issued_at date not null,
  verification_code text not null,
  snapshot jsonb not null,
  signer_user_id bigint references public.users(id) on delete set null,
  signer_signature_url text,
  voided boolean not null default false,
  void_reason text,
  voided_at timestamptz,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, number),
  unique (verification_code)
);
create index if not exists edu_certificates_org_idx on public.edu_certificates (org_id);
create unique index if not exists edu_certificates_active_unique on public.edu_certificates (student_id, program_id) where not voided;
alter table public.edu_certificates enable row level security;

alter table public.qdoc_folders
  add column if not exists area text not null default 'calidad' check (area in ('calidad', 'educacion')),
  add column if not exists edu_program_id bigint references public.edu_programs(id) on delete set null;
create index if not exists qdoc_folders_area_idx on public.qdoc_folders (org_id, area);
