-- IIPS-021 · Módulos opcionales por organización (p. ej. ocultar Facturación).
-- Aditiva: el valor por defecto deja todo como estaba.
alter table public.plt_organizations add column if not exists disabled_modules text[] not null default '{}';
