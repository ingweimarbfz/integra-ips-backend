-- IIPS-019 · Sección de Telegram "Clases de educación" (academico): la tabla de canales solo aceptaba las secciones anteriores.
alter table public.notification_channels drop constraint if exists notification_channels_section_check;
alter table public.notification_channels add constraint notification_channels_section_check
  check (section = any (array['temperatura', 'socorro', 'vehicular', 'educacion', 'ambulancias', 'inventario', 'academico']));
