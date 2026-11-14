# API Integra IPS (Express + Supabase)

Base de datos: proyecto Supabase `centro-vacunacion` (ref `jyiblnjcnnhxjavrhtas`; el nombre del proyecto en Supabase se cambia desde su panel).
Tablas: `users`, `temperature`, `cytology_samples`, con RLS activo y sin acceso público. Solo este backend accede, usando la clave secreta.

## Cómo correrlo

1. Copia `.env.example` como `.env`. En `SUPABASE_SECRET_KEY` pega la clave secreta (Dashboard → Project Settings → API Keys) y en `JWT_SECRET` una cadena aleatoria (`openssl rand -hex 32`).
2. Ejecuta `npm install`.
3. Ejecuta `npm start`. La API queda en http://localhost:4000.

Frontend (repositorio `integra-ips`, carpeta `integra-ips/`): `npm install && npm start`, en http://localhost:3000.

## Rutas
- `POST /login` `{ userName, password }`: valida la contraseña con bcrypt en el servidor.
- `GET /usuarios` y `POST /registrar-usuario`
- `GET /reporte-temperatura` y `POST /registrar-temperatura` `{ tempMin, tempMax }`: la fecha y la hora las pone la base de datos.
- `GET /reporte-toma-de-muestras-citologicas` y `POST /registrar-toma-de-muestras-citologicas`: son obligatorios `fechaExamen`, `nombre`, `apellidos` y `numDocumento`.

## Roles y sesión
Las sesiones usan un token (JWT, 8 h) que se envía en `Authorization: Bearer …`. Cada petición vuelve a leer el usuario, así que un cambio de rol o una desactivación aplican de inmediato.

| Rol | Puede |
|---|---|
| administrador | Todo: dashboard, temperatura, citologías, usuarios (`/usuarios`, CRUD) y configuración (`/configuracion`, colores, logo, umbrales, precio) |
| empleado | Dashboard, registrar y consultar temperaturas y citologías |
| invitado | Solo el dashboard, con datos agregados y sin datos de pacientes |

Todos los roles pueden editar su propio perfil: foto, datos y contraseña (`/perfil`).
Imágenes en Supabase Storage: buckets `avatars` y `branding`.

## Operaciones Generales: Socorro y Educación (`socorro.js`)
- **Personas** (`/socorro/personas`): registro previo de voluntarios con documento, carnet, grupo sanguíneo y agrupación. `GET /socorro/personas/buscar?valor=` busca por carnet o documento.
- **Eventos** (`gso_events.area` = `socorro` o `educacion`): personal, materiales (equipos que salen y regresan) e insumos (medicamentos, dispositivos médicos y reactivos que se consumen de la bodega de la sede). `GET /socorro/inventario?evento=` devuelve las líneas de la bodega de la sede del evento.
- **Eventos** (`/socorro/eventos`): la hora de inicio se registra al crear el evento y la de terminación al finalizarlo (`POST /:id/finalizar`). Personal, materiales (salen y regresan) e insumos (descuentan stock). Solo el coordinador del evento (su documento coincide con la identificación del usuario) o un administrador puede modificar materiales e insumos.
- **Dashboard** (`/socorro/dashboard`): eventos en curso, eventos y horas de servicio del mes, alertas de stock bajo y consumo.

## Módulo de vehículos (`vehicles.js`)
- **Rol `conductor`**: solo entra al módulo de vehículos (dashboard de flota, consulta de vehículos y sus propios reportes diarios).
- **Hoja de vida** (`/vehiculos`, CRUD solo administrador): datos del vehículo, móvil, km inicial (0 km si es nuevo), fotos frontal, laterales y trasera (bucket `vehicles`), SOAT y otros documentos con vencimiento (`/vehiculos/:id/documentos`), y mantenimientos preventivos y correctivos con repuestos (`/vehiculos/:id/mantenimientos`).
- **Reportes diarios** (`/vehiculos-reportes`): se abren buscando la móvil (`/vehiculos/buscar?movil=101`). El km de salida es el km actual del vehículo y la hora se registra sola. Se asocia a un servicio de Socorro o a una actividad nueva. Al cerrar (`/:id/cerrar`) se registran el km de llegada, la foto del tacómetro (obligatoria) y el tanqueo con la foto del ticket. El km de llegada pasa a ser el km actual de la móvil. El conductor ve solo sus reportes; el administrador ve todos.
- **Alertas**: SOAT o documento a 30 días o menos de vencer (o vencido) y mantenimiento preventivo a 15 días o menos, o a 500 km o menos del próximo. Los umbrales están en `ALERT` dentro de `vehicles.js`.

## Hoja de vida de equipos · IPS (`equipment.js`)
- **Equipos** (`/equipos`): biomédicos, refrigeración (cadena de frío), aires acondicionados, plantas eléctricas, cómputo y mobiliario. Cada equipo registra código EQ-0001, marca, modelo, serial, INVIMA, clase de riesgo, área, proveedor, compra, garantía, stock y stock mínimo, estado, frecuencia de mantenimiento preventivo, ficha técnica y foto. Solo el administrador lo modifica; el empleado lo consulta.
- **Mantenimientos** (`/equipos/:id/mantenimientos`): preventivos y correctivos con responsable (taller, biomédico o interno), empresa, N° de orden, costos y repuestos. El resultado del mantenimiento más reciente actualiza el estado del equipo, y el próximo preventivo se calcula con la frecuencia si no se indica.
- **Alertas** (`/equipos-resumen`, también en el dashboard de IPS): preventivo vencido o a 15 días o menos, garantía a 30 días o menos de vencer, equipo fuera de servicio o en mantenimiento, y stock bajo.

## Sedes y alcance (multi-sede)
- **Sedes** (`/sedes`, administrador): una seccional con sus unidades municipales y grupos de apoyo; para cada sede se define si tiene IPS y qué servicios presta (`cadena_frio`, `citologia`, `equipos`).
- Usuarios, voluntarios, temperaturas, citologías, eventos, inventario, equipos y reportes de vehículos tienen `site_id`. Los vehículos además tienen `owner_site_id` (propiedad de la Seccional) y `site_id` (sede a la que están adscritos).
- **Alcance:** el administrador ve todo y puede filtrar con `?sede=<id>`, que el frontend envía automáticamente. Empleados, voluntarios y conductores solo ven su sede.
- **Roles:** administrador, empleado, voluntario y conductor; el rol invitado se eliminó.
- **Voluntarios:** tipo `base` (mínimo 12 h al mes) o `apoyo`, fecha de ingreso y seguro del voluntariado. Las horas se calculan con la duración de los eventos finalizados en los que participó. Si un voluntario de base tiene 3 meses calendario completos seguidos con menos de 12 h, queda inactivo; esto se revisa al iniciar el servidor y cada 6 horas, o con `POST /voluntarios/evaluar`. Su panel está en `GET /voluntario/panel`.

## Servicios de IPS (`index.js`)

- Tablas `ips_services` (código, nombre, módulo que habilita: `cadena_frio`, `citologia` o ninguno) y `site_services` (servicio activo por sede). `sites.has_ips` se recalcula: una sede tiene IPS si tiene al menos un servicio.
- `GET/POST/PUT/DELETE /servicios-ips` y `PUT /servicios-ips/:id/sedes/:siteId` (`{ enabled }`). Solo el administrador modifica.
- `requireIps(modulo)` revisa que la sede del empleado tenga un servicio activo con ese módulo. Los equipos (`equipment.service_id`) se asocian a un servicio y se filtran con `GET /equipos?servicio=`.
- La flota vehicular institucional (vehículos, preoperacional y reportes diarios) sigue en Operaciones Generales (`/socorro/vehiculos/*`). Solo el **conductor** crea reportes diarios y preoperacionales; el administrador los consulta. El servicio de IPS **Ambulancias** no es la flota: solo sirve como destino de insumos y equipos de la ambulancia en el inventario.

## Inventario institucional (`inventory.js`) · Resolución 3100 de 2019

- `inventory_products`: catálogo por categoría (`medicamento`, `dispositivo_medico`, `reactivo`, `operacional`, `no_operacional`) con los campos obligatorios de la auditoría (principio activo, forma farmacéutica, concentración, presentación, INVIMA, marca, clasificación de riesgo, serie y vida útil) y unidad de medida de una lista fija.
- `warehouses`: varias bodegas por sede (código BOD-…, responsable, ubicación, activa); una sola es la **bodega general** (Seccional). CRUD en `/inventario/bodegas` (admin).
- `inventory_items` = línea de stock por bodega + producto + lote (con vencimiento); `site_id` se conserva para el alcance por sede.
- Flujo: solo el administrador ingresa (`POST /inventario/entradas`, siempre a la bodega general, lote y vencimiento obligatorios en insumos) y traslada (`POST /inventario/traslados`, de la general a cualquier bodega o entre bodegas de la misma sede; nunca de regreso a la general). Cada bodega registra entregas semanales a sus servicios de IPS, Educación o Socorro (`POST /inventario/entregas`) y los eventos consumen de ella. Bajas y ajustes: `POST /inventario/bajas` (admin).
- Consultas: `/inventario/catalogos`, `/inventario/productos`, `/inventario/bodegas`, `/inventario/stock`, `/inventario/movimientos` (kárdex) y `/inventario/resumen` (dashboard por bodega, categoría, vencimientos y stock bajo). El empleado solo ve la bodega de su sede.
- Funciones SQL atómicas: `inv_move` (movimiento con destino y referencia) e `inv_transfer` (traslado entre bodegas); referencias `TR-000001`.

## Módulos por usuario (`index.js`)

- `users.modules` (text[]): `null` = módulos del rol; un arreglo los reemplaza. El administrador siempre ve todo. `GET /usuarios/modulos` devuelve las claves y los valores por rol.
- El middleware `auth` relaciona cada ruta con un módulo (`ROUTE_MODULES`). Si el usuario no lo tiene habilitado responde 403. Si lo tiene, puede usar los endpoints abiertos a empleados o voluntarios aunque su rol sea otro; los endpoints solo de administrador o solo de conductor no se abren.

## Firma digital (`signatures.js`)

- Cada usuario guarda su firma (`users.signature_url`, bucket `signatures`): dibujada en pantalla o imagen PNG/JPG con fondo blanco o SVG. `PUT/DELETE /firma`; el administrador gestiona la de cualquier usuario en `/firmas/usuarios`.
- `document_signatures` guarda las firmas estampadas (tipo, clave del documento, casilla, copia de la imagen y del nombre, fecha). `GET /firmas?tipo=&clave=`, `POST /firmas`, `DELETE /firmas/:id` (quien firmó o admin).
- Reglas por documento: citología (quien elaboró / tomó la muestra), evento (coordinador; dirección), reporte vehicular y preoperacional (el conductor del registro; revisó = administrador), reportes de temperatura e inventario y hoja de vida de equipos (personal de la sede).

## Recordatorio de temperatura por Telegram (Supabase)
30 minutos después de cada hora de toma (Temperatura → Recordatorios), si esa lectura aún no está registrada en una sede, se avisa al grupo de Telegram de la sección "temperatura" de la sede. Corre en Supabase, no en este backend, así que funciona aunque la API esté apagada.
- `supabase/functions/recordatorio-temperatura`: edge function (sin JWT; valida la cabecera `x-cron-secret` contra el secreto `temp_reminder_cron_secret` de Vault).
- `supabase/migrations/20261114_recordatorio_temperatura_telegram.sql`: activa pg_cron y pg_net, crea `temperature_reminders_sent` (un aviso por sede, día y lectura) y programa la tarea `recordatorio-temperatura` cada 5 minutos.
- Prueba sin enviar: POST con body `{ "dry": true, "now": "08:31", "date": "AAAA-MM-DD" }` y la misma cabecera.
- Para pausarlo: apaga los recordatorios en Temperatura → Recordatorios, o `select cron.unschedule('recordatorio-temperatura');`.
