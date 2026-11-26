-- IIPS-039 · Ente territorial (Secretaría de Salud) como pagador: aplicación de vacunas PAI a población no afiliada (Ley 715 de 2001).
alter table public.eps_insurers drop constraint if exists eps_insurers_kind_check;
alter table public.eps_insurers add constraint eps_insurers_kind_check check (kind in ('eps', 'aseguradora', 'clinica', 'hospital_publico', 'empresa_publica', 'ente_territorial', 'empresa_privada', 'ips', 'otra'));
