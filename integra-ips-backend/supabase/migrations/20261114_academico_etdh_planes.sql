-- IIPS-019 · Educación ETDH en planes y precios: tipo de organización "etdh" y textos del plan Educación.
alter table public.plt_organizations drop constraint if exists plt_organizations_org_type_check;
alter table public.plt_organizations add constraint plt_organizations_org_type_check check (org_type = any (array['ips', 'esal', 'etdh']));

update public.plt_features set label = case key
  when 'edu_dashboard' then 'Dashboard del instituto, reportes PDF, SIET y acreditación'
  when 'edu_programas' then 'Programas, pensum, grupos, horarios, aulas y clases virtuales'
  when 'edu_estudiantes' then 'Estudiantes, matrículas, cartera, convenios y certificados'
  when 'edu_portal' then 'Portal del estudiante: horario, aula virtual, notas, pagos y certificados'
  when 'edu_docente' then 'Panel del docente: horario, asistencia con firmas, talleres y calificaciones'
  else label end
where key in ('edu_dashboard', 'edu_programas', 'edu_estudiantes', 'edu_portal', 'edu_docente');

update public.plt_plans set
  tagline = 'Para instituciones de Educación para el Trabajo y el Desarrollo Humano (ETDH): de la matrícula al certificado.',
  bullets = array['3 sedes y 50 usuarios del instituto', 'Programas, pensum, grupos, horarios, aulas y clases virtuales (Meet o Teams)', 'Matrículas, planes de pago, descuentos, convenios, cartera y facturación', 'Asistencia con firmas del estudiante, el docente y el director', 'Aula virtual, talleres, notas y portal del estudiante', 'Certificados con verificación pública, reportes PDF, SIET y acreditación', 'Avisos por Telegram a cada grupo']::text[],
  updated_at = now()
where code = 'educacion';

update public.plt_plans set
  bullets = array['Sedes ilimitadas y 200 usuarios', 'Todo lo de Integral', 'Socorro, eventos y emergencias', 'Educación, voluntariado y reportes', 'Institución ETDH completa: matrículas, clases, asistencia, aula virtual, notas y certificados']::text[],
  updated_at = now()
where code = 'humanitario';
