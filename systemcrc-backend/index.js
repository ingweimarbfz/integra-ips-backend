require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const {
  SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET,
  PORT = 4000, CORS_ORIGIN = 'http://localhost:3000', SESSION_HOURS = 8
} = process.env
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !JWT_SECRET) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SECRET_KEY o JWT_SECRET en el archivo .env (ver .env.example)')
  process.exit(1)
}

// Cliente con la clave secreta: solo vive en el servidor, nunca en el navegador.
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const app = express()
// CORS_ORIGIN admite varios orígenes separados por coma (p. ej. localhost y la URL pública del frontend).
app.use(cors({ origin: CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean) }))
app.use(express.json({ limit: '20mb' })) // imágenes en base64 (foto de perfil y logo)

const TZ = 'America/Bogota'
const TZ_OFFSET = '-05:00' // Colombia no tiene horario de verano
const ROLES = ['administrador', 'empleado', 'conductor', 'voluntario']
const ADMIN = ['administrador']
const STAFF = ['administrador', 'empleado']
const ALL = ROLES
const IPS_ROLES = ['administrador', 'empleado'] // el módulo IPS es del personal de la IPS
const NO_DRIVER = ['administrador', 'empleado'] // dashboards generales (el conductor y el voluntario tienen los suyos)
const SITE_TYPES = ['seccional', 'unidad_municipal', 'grupo_apoyo']
const IPS_MODULES = ['cadena_frio', 'citologia', 'ambulancias'] // módulos del sistema que un servicio de IPS puede habilitar

// ======================================================================
// Módulos por usuario: el administrador puede mostrar u ocultar módulos a cada usuario.
// users.modules = null usa los del rol; un arreglo los reemplaza. El administrador ve todo.
// ======================================================================
const MODULE_KEYS = ['ips_dashboard', 'citologias', 'temperatura', 'traslado', 'equipos', 'og_dashboard', 'socorro', 'educacion', 'personas', 'reporte_voluntarios', 'inventario', 'flota', 'voluntario']
const ROLE_MODULES = {
  empleado: ['ips_dashboard', 'citologias', 'temperatura', 'equipos', 'og_dashboard', 'socorro', 'educacion', 'personas', 'reporte_voluntarios', 'inventario', 'flota'],
  voluntario: ['socorro', 'educacion', 'voluntario'],
  conductor: ['flota', 'traslado'],
  administrador: MODULE_KEYS
}
const userModules = (u) => (u.role === 'administrador' ? MODULE_KEYS : Array.isArray(u.modules) ? u.modules.filter((m) => MODULE_KEYS.includes(m)) : ROLE_MODULES[u.role] || [])
// Ruta → módulo (el primero que coincide). Las rutas sin módulo solo dependen del rol.
const ROUTE_MODULES = [
  ['/citologias', ['citologias']], ['/registrar-toma-de-muestras-citologicas', ['citologias']], ['/consultar-citologias', ['citologias']],
  ['/registrar-temperatura', ['temperatura']], ['/reporte-temperatura', ['temperatura']], ['/temperatura', ['temperatura']],
  ['/ambulancias-dashboard', ['traslado']], ['/equipos', ['equipos']], ['/dashboard', ['ips_dashboard']],
  ['/socorro/dashboard', ['og_dashboard']], ['/socorro/reporte-voluntarios', ['reporte_voluntarios']], ['/socorro/eventos', ['socorro', 'educacion']], ['/socorro/inventario', ['socorro', 'educacion']],
  ['/socorro/personas', ['personas', 'socorro', 'educacion']], ['/inventario', ['inventario']], ['/voluntario/panel', ['voluntario']],
  ['/vehiculos', ['flota', 'traslado']]
]
const routeModules = (path) => (ROUTE_MODULES.find(([p]) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}-`)) || [])[1] || null
const GRANTABLE_ROLES = ['empleado', 'voluntario'] // roles de endpoints que se abren a quien tenga el módulo

const fail = (res, error, status = 500) => {
  if (status >= 500) console.error(error)
  res.status(status).send({ message: typeof error === 'string' ? error : 'Error en el servidor' })
}

// Envuelve handlers async para no repetir try/catch.
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => fail(res, e))

// Convierte '' en null y recorta texto.
const clean = (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v ?? null)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PHONE_RE = /^[0-9]{10}$/
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
const HEX_RE = /^#[0-9a-f]{6}$/i

const todayBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
const ageAt = (birth, ref) => {
  const [by, bm, bd] = birth.split('-').map(Number)
  const [ry, rm, rd] = ref.split('-').map(Number)
  return ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0)
}

// ======================================================================
// Usuarios y sesión
// ======================================================================
const SITE_SELECT = '*, site_services(service:ips_services(id, code, name, module, active)), warehouses(id, code, name, is_general, active)'
const USER_COLUMNS = 'id, identification, name, last_name, username, role, email, avatar_url, signature_url, remunerado, active, created_at, site_id, modules, site:sites(' + SITE_SELECT + ')'

const toUserDTO = (u) => ({
  id: u.id,
  identification: u.identification,
  name: u.name,
  lastName: u.last_name,
  fullName: `${u.name} ${u.last_name}`.trim(),
  nameUser: u.username,
  role: u.role,
  email: u.email,
  avatarUrl: u.avatar_url,
  signatureUrl: u.signature_url ?? null,
  remunerado: Boolean(u.remunerado),
  active: u.active,
  createdAt: u.created_at,
  siteId: u.site_id,
  site: u.site ? siteDTO(u.site) : null,
  modules: userModules(u),
  customModules: Array.isArray(u.modules) ? u.modules : null
})

// ======================================================================
// Sedes y alcance por sede
// ======================================================================
// Servicios de IPS activos habilitados en la sede.
const siteServices = (s) => (s?.site_services || []).map((x) => x.service).filter((x) => x && x.active)
const one = (v) => (Array.isArray(v) ? v[0] : v) || null
const siteDTO = (s) => {
  if (!s) return s
  const services = siteServices(s)
  return {
    id: s.id, type: s.type, name: s.name, municipality: s.municipality, parentId: s.parent_id ?? null,
    address: s.address ?? null, phone: s.phone ?? null, email: s.email ?? null,
    hasIps: services.length > 0,
    ipsServices: services.map((x) => x.code),
    ipsModules: [...new Set(services.map((x) => x.module).filter(Boolean))],
    services: services.map((x) => ({ id: x.id, code: x.code, name: x.name, module: x.module })),
    warehouses: (s.warehouses || []).sort((a, b) => b.is_general - a.is_general || a.name.localeCompare(b.name)).map((w) => ({ id: w.id, code: w.code, name: w.name, isGeneral: w.is_general, active: w.active })),
    active: s.active
  }
}
let seccionalIdCache = null
const seccionalId = async () => {
  if (seccionalIdCache) return seccionalIdCache
  const { data } = await supabase.from('sites').select('id').eq('type', 'seccional').order('id').limit(1)
  seccionalIdCache = data?.[0]?.id ?? null
  return seccionalIdCache
}
// Sede a la que se limita la consulta: el admin puede filtrar con ?sede= (o ver todo); los demás solo su sede.
const scopeSite = (req) => (req.user.role === 'administrador' ? (Number(req.query.sede) || null) : req.user.site_id)
const applyScope = (q, siteId, col = 'site_id') => (siteId ? q.eq(col, siteId) : q)
const canAccessSite = (req, siteId) => req.user.role === 'administrador' || Number(siteId) === Number(req.user.site_id)
// Sede donde se crea un registro: la del usuario; el admin puede indicarla (por defecto la Seccional).
const targetSite = async (req, bodySiteId) => {
  if (req.user.role !== 'administrador') return req.user.site_id
  const id = Number(bodySiteId || req.query.sede)
  if (id) {
    const { data } = await supabase.from('sites').select('id').eq('id', id).maybeSingle()
    if (data) return data.id
  }
  return seccionalId()
}
// El empleado solo usa los servicios de IPS habilitados en su sede.
const requireIps = (service) => (req, res, next) => {
  if (req.user.role === 'administrador') return next()
  if (!siteServices(req.user.site).some((x) => x.module === service)) return fail(res, 'Tu sede no tiene habilitado este servicio de IPS', 403)
  next()
}

const signToken = (user) => jwt.sign({ sub: String(user.id), role: user.role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` })

// Valida el token y vuelve a leer el usuario: un cambio de rol o una desactivación aplican de inmediato.
const auth = (roles = ALL) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return fail(res, 'Debes iniciar sesión', 401)
    let payload
    try { payload = jwt.verify(token, JWT_SECRET) } catch { return fail(res, 'Tu sesión expiró. Inicia sesión de nuevo.', 401) }

    const { data: user, error } = await supabase.from('users').select(USER_COLUMNS).eq('id', Number(payload.sub)).maybeSingle()
    if (error) throw error
    if (!user || !user.active) return fail(res, 'Usuario inactivo o inexistente', 401)
    if (user.role !== 'administrador' && user.site && !user.site.active) return fail(res, 'Tu sede está inactiva. Contacta al administrador.', 401)
    // Permisos: rol del endpoint + módulos del usuario.
    const mods = routeModules(req.path)
    if (user.role !== 'administrador' && mods) {
      const own = userModules(user)
      const has = mods.some((m) => own.includes(m))
      if (!has) return fail(res, 'No tienes habilitado este módulo. Pídele acceso al administrador.', 403)
      // Con el módulo habilitado, el usuario usa los endpoints abiertos a empleados o voluntarios (nunca los solo de administrador).
      if (!roles.includes(user.role) && !roles.some((r) => GRANTABLE_ROLES.includes(r))) return fail(res, 'No tienes permiso para esta acción', 403)
      user.moduleGrant = !roles.includes(user.role)
    } else if (!roles.includes(user.role)) return fail(res, 'No tienes permiso para esta acción', 403)
    req.user = user
    next()
  } catch (e) {
    fail(res, e)
  }
}

app.get('/', (req, res) => res.send('API SystemCRC (Supabase)'))

app.post('/login', h(async (req, res) => {
  const { userName, password } = req.body || {}
  if (!clean(userName) || !password) return fail(res, 'Usuario y contraseña requeridos', 400)

  const { data: user, error } = await supabase
    .from('users').select(`${USER_COLUMNS}, password_hash`).eq('username', clean(userName)).maybeSingle()
  if (error) throw error

  const ok = user && (await bcrypt.compare(password, user.password_hash))
  if (!ok) return fail(res, 'Nombre de usuario o contraseña incorrectos.', 401)
  if (!user.active) return fail(res, 'Tu usuario está inactivo. Contacta al administrador.', 403)
  if (user.role !== 'administrador' && user.site && !user.site.active) return fail(res, 'Tu sede está inactiva. Contacta al administrador.', 403)
  res.send({ token: signToken(user), user: toUserDTO(user) })
}))

app.get('/auth/me', auth(), (req, res) => res.send(toUserDTO(req.user)))

// ---------- Validación común de datos de usuario ----------
const validateUserInput = (b, { requirePassword }) => {
  const errors = []
  for (const [k, label] of [['identification', 'Identificación'], ['name', 'Nombre'], ['lastName', 'Apellidos'], ['nameUser', 'Usuario'], ['role', 'Rol']]) {
    if (!clean(b[k])) errors.push(`${label} es requerido`)
  }
  if (b.role && !ROLES.includes(b.role)) errors.push('Rol inválido')
  if (b.role && b.role !== 'administrador' && !Number(b.siteId)) errors.push('Selecciona la sede (seccional, unidad municipal o grupo de apoyo)')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
  if (requirePassword && (!b.password || b.password.length < 6)) errors.push('La contraseña debe tener al menos 6 caracteres')
  if (!requirePassword && b.password && b.password.length < 6) errors.push('La contraseña debe tener al menos 6 caracteres')
  return errors
}

const countActiveAdmins = async (excludeId) => {
  let q = supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'administrador').eq('active', true)
  if (excludeId) q = q.neq('id', excludeId)
  const { count, error } = await q
  if (error) throw error
  return count
}

// ---------- Administración de usuarios (solo administrador) ----------
app.get('/usuarios', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await applyScope(supabase.from('users').select(USER_COLUMNS), Number(req.query.sede) || null).order('name')
  if (error) throw error
  res.send(data.map(toUserDTO))
}))

// null = módulos del rol; arreglo = módulos personalizados.
const modulesInput = (b) => (Array.isArray(b.modules) && b.role !== 'administrador' ? [...new Set(b.modules.filter((m) => MODULE_KEYS.includes(m)))] : null)
app.get('/usuarios/modulos', auth(ADMIN), (req, res) => res.send({ keys: MODULE_KEYS, byRole: ROLE_MODULES }))

const createUser = h(async (req, res) => {
  const b = req.body || {}
  const errors = validateUserInput(b, { requirePassword: true })
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('users').insert({
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName),
    username: clean(b.nameUser),
    email: clean(b.email)?.toLowerCase() ?? null,
    password_hash: await bcrypt.hash(b.password, 10),
    role: b.role,
    site_id: Number(b.siteId) || null,
    modules: modulesInput(b),
    remunerado: b.remunerado === undefined ? ['administrador', 'empleado'].includes(b.role) : Boolean(b.remunerado),
    active: b.active !== false
  }).select(USER_COLUMNS).single()
  if (error) {
    if (error.code === '23505') return fail(res, 'La identificación o el usuario ya existen', 409)
    throw error
  }
  res.status(201).send(toUserDTO(data))
})
app.post('/usuarios', auth(ADMIN), createUser)
app.post('/registrar-usuario', auth(ADMIN), createUser) // ruta anterior

app.put('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  const errors = validateUserInput(b, { requirePassword: false })
  if (errors.length) return fail(res, errors.join('. '), 400)

  // No dejar el sistema sin administradores activos.
  const losesAdmin = b.role !== 'administrador' || b.active === false
  if (losesAdmin) {
    const { data: current } = await supabase.from('users').select('role, active').eq('id', id).maybeSingle()
    if (current?.role === 'administrador' && current.active && (await countActiveAdmins(id)) === 0) {
      return fail(res, 'Debe quedar al menos un administrador activo', 400)
    }
  }
  const patch = {
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName),
    username: clean(b.nameUser),
    email: clean(b.email)?.toLowerCase() ?? null,
    role: b.role,
    site_id: Number(b.siteId) || null,
    modules: modulesInput(b),
    remunerado: Boolean(b.remunerado),
    active: b.active !== false,
    updated_at: new Date().toISOString()
  }
  if (b.password) patch.password_hash = await bcrypt.hash(b.password, 10)

  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select(USER_COLUMNS).maybeSingle()
  if (error) {
    if (error.code === '23505') return fail(res, 'La identificación o el usuario ya existen', 409)
    throw error
  }
  if (!data) return fail(res, 'Usuario no encontrado', 404)
  res.send(toUserDTO(data))
}))

app.delete('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  if (id === req.user.id) return fail(res, 'No puedes eliminar tu propio usuario', 400)
  const { data: target } = await supabase.from('users').select('role, active, avatar_url').eq('id', id).maybeSingle()
  if (!target) return fail(res, 'Usuario no encontrado', 404)
  if (target.role === 'administrador' && target.active && (await countActiveAdmins(id)) === 0) {
    return fail(res, 'Debe quedar al menos un administrador activo', 400)
  }
  const { error } = await supabase.from('users').delete().eq('id', id)
  if (error) throw error
  await removeStoredFile('avatars', target.avatar_url)
  res.send({ message: 'Usuario eliminado' })
}))

// ---------- Sedes (configuración del administrador) ----------
app.get('/sedes', auth(), h(async (req, res) => {
  let q = supabase.from('sites').select(SITE_SELECT).order('type').order('name')
  if (req.user.role !== 'administrador') q = q.eq('id', req.user.site_id)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(siteDTO))
}))

const validateSite = async (b, id) => {
  const e = []
  if (!SITE_TYPES.includes(b.type)) e.push('Tipo de sede inválido')
  if (!clean(b.name)) e.push('El nombre es requerido')
  if (!clean(b.municipality)) e.push('El municipio es requerido')
  if (b.type !== 'seccional' && !Number(b.parentId)) e.push('Selecciona la seccional a la que pertenece')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) e.push('Correo no válido')
  if (clean(b.phone) && !/^[0-9]{7,10}$/.test(clean(b.phone))) e.push('Teléfono inválido')
  const services = [...new Set((b.serviceIds || []).map(Number).filter(Boolean))]
  if (services.length) {
    const { data: ok } = await supabase.from('ips_services').select('id').in('id', services)
    if ((ok || []).length !== services.length) e.push('Servicio de IPS inválido')
  }
  if (Number(b.parentId)) {
    const { data: p } = await supabase.from('sites').select('type').eq('id', Number(b.parentId)).maybeSingle()
    if (p?.type !== 'seccional') e.push('La sede superior debe ser una seccional')
    if (id && Number(b.parentId) === id) e.push('Una sede no puede depender de sí misma')
  }
  return { errors: e, row: {
    type: b.type, name: clean(b.name), municipality: clean(b.municipality), parent_id: b.type === 'seccional' ? null : Number(b.parentId),
    address: clean(b.address), phone: clean(b.phone), email: clean(b.email)?.toLowerCase() ?? null,
    has_ips: services.length > 0, active: b.active !== false, updated_at: new Date().toISOString()
  }, services }
}

// Guarda los servicios de IPS habilitados y la bodega de la sede.
const saveSiteExtras = async (site, services) => {
  const del = await supabase.from('site_services').delete().eq('site_id', site.id)
  if (del.error) throw del.error
  if (services.length) {
    const ins = await supabase.from('site_services').insert(services.map((service_id) => ({ site_id: site.id, service_id })))
    if (ins.error) throw ins.error
  }
}
const siteById = async (id) => {
  const { data, error } = await supabase.from('sites').select(SITE_SELECT).eq('id', id).single()
  if (error) throw error
  return data
}

app.post('/sedes', auth(ADMIN), h(async (req, res) => {
  const { errors, row, services } = await validateSite(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('sites').insert(row).select('*').single()
  if (error) { if (error.code === '23505') return fail(res, 'Ya existe una sede con ese nombre', 409); throw error }
  await saveSiteExtras(data, services)
  res.status(201).send(siteDTO(await siteById(data.id)))
}))

app.put('/sedes/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { errors, row, services } = await validateSite(req.body || {}, id)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (row.type !== 'seccional') {
    const { count } = await supabase.from('sites').select('id', { count: 'exact', head: true }).eq('parent_id', id)
    if (count) return fail(res, 'Esta sede tiene unidades o grupos a cargo; debe seguir siendo seccional', 400)
  }
  const { data, error } = await supabase.from('sites').update(row).eq('id', id).select('*').maybeSingle()
  if (error) { if (error.code === '23505') return fail(res, 'Ya existe una sede con ese nombre', 409); throw error }
  if (!data) return fail(res, 'Sede no encontrada', 404)
  await saveSiteExtras(data, services)
  seccionalIdCache = null
  res.send(siteDTO(await siteById(id)))
}))

app.delete('/sedes/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { error } = await supabase.from('sites').delete().eq('id', id)
  if (error) {
    if (error.code === '23503') return fail(res, 'La sede tiene usuarios, voluntarios o registros asociados. Desactívala en lugar de eliminarla.', 409)
    throw error
  }
  seccionalIdCache = null
  res.send({ message: 'Sede eliminada' })
}))

// Resumen por sede para el administrador (conteos básicos de cada municipio).
app.get('/sedes-resumen', auth(ADMIN), h(async (req, res) => {
  const [sites, users, vols, events, eq, veh] = await Promise.all([
    supabase.from('sites').select(SITE_SELECT).order('type').order('name'),
    supabase.from('users').select('site_id, role').eq('active', true),
    supabase.from('volunteers').select('site_id').eq('active', true),
    supabase.from('gso_events').select('site_id, status'),
    supabase.from('equipment').select('site_id').neq('status', 'dado_de_baja'),
    supabase.from('vehicles').select('site_id').neq('status', 'fuera_servicio')
  ])
  for (const r of [sites, users, vols, events, eq, veh]) if (r.error) throw r.error
  const c = (rows, id, f = () => true) => rows.filter((r) => r.site_id === id && f(r)).length
  res.send(sites.data.map((s) => ({
    ...siteDTO(s),
    employees: c(users.data, s.id, (u) => u.role === 'empleado'), drivers: c(users.data, s.id, (u) => u.role === 'conductor'),
    volunteers: c(vols.data, s.id), openEvents: c(events.data, s.id, (e) => e.status === 'en_curso'), events: c(events.data, s.id),
    equipment: c(eq.data, s.id), vehicles: c(veh.data, s.id)
  })))
}))

// ---------- Servicios de IPS (los crea el administrador y los habilita por sede) ----------
const serviceDTO = (x) => ({
  id: x.id, code: x.code, name: x.name, description: x.description, module: x.module, active: x.active,
  settings: x.settings || {}, settingsSchema: SERVICE_SETTINGS[x.module] || [],
  siteIds: (x.site_services || []).map((r) => r.site_id),
  equipment: x.equipment?.[0]?.count ?? undefined
})
const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)

app.get('/servicios-ips', auth(), h(async (req, res) => {
  const { data, error } = await supabase.from('ips_services').select('*, site_services(site_id), equipment(count)').order('id')
  if (error) throw error
  res.send(data.map(serviceDTO))
}))

const validateService = async (b, id) => {
  const e = []
  const name = clean(b.name)
  if (!name) e.push('El nombre del servicio es requerido')
  const module = clean(b.module)
  if (module && !IPS_MODULES.includes(module)) e.push('Módulo inválido')
  if (module) {
    let q = supabase.from('ips_services').select('id').eq('module', module)
    if (id) q = q.neq('id', id)
    const { data } = await q
    if (data?.length) e.push('Ya existe un servicio que habilita ese módulo')
  }
  const siteIds = [...new Set((b.siteIds || []).map(Number).filter(Boolean))]
  return { errors: e, row: { name, description: clean(b.description), module: module || null, active: b.active !== false }, siteIds }
}
const saveServiceSites = async (serviceId, siteIds) => {
  const del = await supabase.from('site_services').delete().eq('service_id', serviceId)
  if (del.error) throw del.error
  if (siteIds.length) {
    const ins = await supabase.from('site_services').insert(siteIds.map((site_id) => ({ site_id, service_id: serviceId })))
    if (ins.error) throw ins.error
  }
  await syncHasIps()
}
const syncHasIps = async () => {
  const [{ data: sites }, { data: links }] = await Promise.all([supabase.from('sites').select('id, has_ips'), supabase.from('site_services').select('site_id')])
  const on = new Set((links || []).map((l) => l.site_id))
  for (const s of sites || []) if (s.has_ips !== on.has(s.id)) await supabase.from('sites').update({ has_ips: on.has(s.id) }).eq('id', s.id)
}
const serviceById = async (id) => {
  const { data, error } = await supabase.from('ips_services').select('*, site_services(site_id), equipment(count)').eq('id', id).single()
  if (error) throw error
  return serviceDTO(data)
}

app.post('/servicios-ips', auth(ADMIN), h(async (req, res) => {
  const { errors, row, siteIds } = await validateService(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const code = slug(clean(req.body.code) || row.name)
  if (!code) return fail(res, 'Código inválido', 400)
  const { data, error } = await supabase.from('ips_services').insert({ ...row, code }).select('id').single()
  if (error) { if (error.code === '23505') return fail(res, 'Ya existe un servicio con ese código', 409); throw error }
  await saveServiceSites(data.id, siteIds)
  res.status(201).send(await serviceById(data.id))
}))

app.put('/servicios-ips/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { errors, row, siteIds } = await validateService(req.body || {}, id)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('ips_services').update(row).eq('id', id).select('id').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Servicio no encontrado', 404)
  await saveServiceSites(id, siteIds)
  res.send(await serviceById(id))
}))

// Configuración del servicio: campos del módulo + parámetros libres (custom: [{ name, value }]).
app.put('/servicios-ips/:id/configuracion', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { data: svc } = await supabase.from('ips_services').select('id, module, settings').eq('id', id).maybeSingle()
  if (!svc) return fail(res, 'Servicio no encontrado', 404)
  const b = req.body || {}
  const errors = []
  const next = {}
  for (const f of SERVICE_SETTINGS[svc.module] || []) {
    const raw = b[f.key]
    if (raw === '' || raw == null) { if (f.required) errors.push(`${f.label} es obligatorio`); continue }
    const v = f.type === 'number' ? Number(raw) : String(raw).trim()
    if (f.type === 'number' && (Number.isNaN(v) || (f.min != null && v < f.min))) { errors.push(`${f.label} inválido`); continue }
    next[f.key] = v
  }
  if (svc.module === 'cadena_frio' && next.temp_min != null && next.temp_max != null && next.temp_min >= next.temp_max) errors.push('La temperatura mínima debe ser menor que la máxima')
  const custom = (Array.isArray(b.custom) ? b.custom : []).map((c) => ({ name: clean(c?.name), value: clean(String(c?.value ?? '')) })).filter((c) => c.name)
  if (new Set(custom.map((c) => c.name.toLowerCase())).size !== custom.length) errors.push('Hay parámetros con el mismo nombre')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { error } = await supabase.from('ips_services').update({ settings: { ...next, custom } }).eq('id', id)
  if (error) throw error
  res.send(await serviceById(id))
}))

// Activa o desactiva un servicio en una sede.
app.put('/servicios-ips/:id/sedes/:siteId', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id); const siteId = Number(req.params.siteId)
  const r = req.body?.enabled
    ? await supabase.from('site_services').upsert({ site_id: siteId, service_id: id }, { onConflict: 'site_id,service_id', ignoreDuplicates: true })
    : await supabase.from('site_services').delete().eq('site_id', siteId).eq('service_id', id)
  if (r.error) { if (r.error.code === '23503') return fail(res, 'Sede o servicio inexistente', 404); throw r.error }
  await syncHasIps()
  res.send(await serviceById(id))
}))

app.delete('/servicios-ips/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { count } = await supabase.from('equipment').select('id', { count: 'exact', head: true }).eq('service_id', id)
  if (count) return fail(res, `El servicio tiene ${count} equipo(s) asociados. Desactívalo en lugar de eliminarlo.`, 409)
  const { error } = await supabase.from('ips_services').delete().eq('id', id)
  if (error) throw error
  await syncHasIps()
  res.send({ message: 'Servicio eliminado' })
}))

// ---------- Descuentos de la IPS (Configuración general) ----------
const DISCOUNT_ICONS = ['handshake', 'person', 'cake', 'star', 'briefcase', 'school', 'trophy', 'heart']
const discountDTO = (d) => ({ id: d.id, name: d.name, type: d.type, value: Number(d.value), icon: d.icon, color: d.color, description: d.description, active: d.active })
app.get('/descuentos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('discounts').select('*').order('name')
  if (req.user.role !== 'administrador' || req.query.activos === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(discountDTO))
}))
const discountRow = (b) => {
  const e = []
  const value = Number(b.value)
  if (!clean(b.name)) e.push('El nombre es requerido')
  if (!['porcentaje', 'valor'].includes(b.type)) e.push('Tipo inválido')
  if (Number.isNaN(value) || value <= 0) e.push('El valor debe ser mayor que cero')
  if (b.type === 'porcentaje' && value > 100) e.push('El porcentaje no puede superar 100')
  if (b.icon && !DISCOUNT_ICONS.includes(b.icon)) e.push('Ícono inválido')
  if (b.color && !HEX_RE.test(b.color)) e.push('Color inválido')
  return { errors: e, row: { name: clean(b.name), type: b.type, value, icon: b.icon || 'handshake', color: (b.color || '#14B8A6').toUpperCase(), description: clean(b.description), active: b.active !== false, updated_at: new Date().toISOString() } }
}
app.post('/descuentos', auth(ADMIN), h(async (req, res) => {
  const { errors, row } = discountRow(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('discounts').insert(row).select('*').single()
  if (error) { if (error.code === '23505') return fail(res, 'Ya existe un descuento con ese nombre', 409); throw error }
  res.status(201).send(discountDTO(data))
}))
app.put('/descuentos/:id', auth(ADMIN), h(async (req, res) => {
  const { errors, row } = discountRow(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('discounts').update(row).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) { if (error.code === '23505') return fail(res, 'Ya existe un descuento con ese nombre', 409); throw error }
  if (!data) return fail(res, 'Descuento no encontrado', 404)
  res.send(discountDTO(data))
}))
app.delete('/descuentos/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { count } = await supabase.from('cytology_samples').select('id', { count: 'exact', head: true }).eq('discount_id', id)
  if (count) return fail(res, `El descuento se aplicó en ${count} registro(s). Desactívalo en lugar de eliminarlo.`, 409)
  const { error } = await supabase.from('discounts').delete().eq('id', id)
  if (error) throw error
  res.send({ message: 'Descuento eliminado' })
}))

// ======================================================================
// Imágenes (Supabase Storage)
// ======================================================================
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }

const parseDataUrl = (dataUrl, allowed) => {
  const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(dataUrl || '')
  if (!m || !allowed.includes(m[1])) return null
  const buffer = Buffer.from(m[2], 'base64')
  if (buffer.length > 2 * 1024 * 1024) return null
  return { mime: m[1], buffer }
}

const uploadImage = async (bucket, prefix, dataUrl, allowed) => {
  const file = parseDataUrl(dataUrl, allowed)
  if (!file) return null
  const path = `${prefix}-${crypto.randomBytes(6).toString('hex')}.${MIME_EXT[file.mime]}`
  const { error } = await supabase.storage.from(bucket).upload(path, file.buffer, { contentType: file.mime, upsert: false })
  if (error) throw error
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

const removeStoredFile = async (bucket, url) => {
  if (!url) return
  const marker = `/object/public/${bucket}/`
  const i = url.indexOf(marker)
  if (i === -1) return
  await supabase.storage.from(bucket).remove([url.slice(i + marker.length)]).catch(() => {})
}

// ======================================================================
// Perfil del usuario actual (todos los roles)
// ======================================================================
app.get('/perfil', auth(), (req, res) => res.send(toUserDTO(req.user)))

app.put('/perfil', auth(), h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.name) || !clean(b.lastName)) return fail(res, 'Nombre y apellidos son requeridos', 400)
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) return fail(res, 'Correo no válido', 400)
  const { data, error } = await supabase.from('users').update({
    name: clean(b.name), last_name: clean(b.lastName), email: clean(b.email)?.toLowerCase() ?? null, updated_at: new Date().toISOString()
  }).eq('id', req.user.id).select(USER_COLUMNS).single()
  if (error) throw error
  res.send(toUserDTO(data))
}))

app.put('/perfil/password', auth(), h(async (req, res) => {
  const { actual, nueva } = req.body || {}
  if (!nueva || nueva.length < 6) return fail(res, 'La nueva contraseña debe tener al menos 6 caracteres', 400)
  const { data } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single()
  if (!(await bcrypt.compare(actual || '', data.password_hash))) return fail(res, 'La contraseña actual no es correcta', 400)
  const { error } = await supabase.from('users').update({ password_hash: await bcrypt.hash(nueva, 10), updated_at: new Date().toISOString() }).eq('id', req.user.id)
  if (error) throw error
  res.send({ message: 'Contraseña actualizada' })
}))

app.post('/perfil/foto', auth(), h(async (req, res) => {
  const url = await uploadImage('avatars', `user-${req.user.id}`, req.body?.image, ['image/png', 'image/jpeg', 'image/webp'])
  if (!url) return fail(res, 'Imagen inválida (PNG, JPG o WEBP de máximo 2 MB)', 400)
  const { data, error } = await supabase.from('users').update({ avatar_url: url, updated_at: new Date().toISOString() })
    .eq('id', req.user.id).select(USER_COLUMNS).single()
  if (error) throw error
  await removeStoredFile('avatars', req.user.avatar_url)
  res.send(toUserDTO(data))
}))

app.delete('/perfil/foto', auth(), h(async (req, res) => {
  const { data, error } = await supabase.from('users').update({ avatar_url: null }).eq('id', req.user.id).select(USER_COLUMNS).single()
  if (error) throw error
  await removeStoredFile('avatars', req.user.avatar_url)
  res.send(toUserDTO(data))
}))

// ======================================================================
// Configuración de la IPS
// ======================================================================
// Configuración propia de cada servicio de IPS (ips_services.settings). Para sumar una opción a un módulo
// basta con agregar el campo aquí; además cada servicio admite parámetros libres (nombre → valor).
const SERVICE_SETTINGS = {
  cadena_frio: [
    { key: 'temp_min', label: 'Temperatura mínima permitida', type: 'number', unit: '°C', step: 0.5, required: true, default: 15 },
    { key: 'temp_max', label: 'Temperatura máxima permitida', type: 'number', unit: '°C', step: 0.5, required: true, default: 24, help: 'Las lecturas fuera de este rango generan alerta.' }
  ],
  citologia: [
    { key: 'precio', label: 'Valor de la citología', type: 'number', unit: 'COP', step: 500, min: 0, required: true, default: 35000, help: 'Se carga por defecto al registrar una citología.' }
  ],
  ambulancias: []
}
const serviceSettings = async (module) => {
  const { data } = await supabase.from('ips_services').select('settings').eq('module', module).maybeSingle()
  const out = {}
  for (const f of SERVICE_SETTINGS[module] || []) out[f.key] = data?.settings?.[f.key] ?? f.default
  return out
}
const getSettings = async () => {
  const [{ data: s, error }, cold, cyto] = await Promise.all([
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    serviceSettings('cadena_frio'),
    serviceSettings('citologia')
  ])
  if (error) throw error
  const price = cyto.precio == null ? null : Number(cyto.precio)
  return {
    ipsName: s.ips_name,
    shortName: s.short_name,
    primaryColor: s.primary_color,
    secondaryColor: s.secondary_color,
    logoUrl: s.logo_url,
    tempMinThreshold: Number(cold.temp_min),
    tempMaxThreshold: Number(cold.temp_max),
    cytologyPrice: price,
    updatedAt: s.updated_at
  }
}

// Público: el login necesita el nombre, los colores y el logo antes de iniciar sesión.
app.get('/configuracion/publica', h(async (req, res) => {
  const s = await getSettings()
  res.send({ ipsName: s.ipsName, shortName: s.shortName, primaryColor: s.primaryColor, secondaryColor: s.secondaryColor, logoUrl: s.logoUrl })
}))

app.get('/configuracion', auth(), h(async (req, res) => res.send(await getSettings())))

app.put('/configuracion', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = []
  if (!clean(b.ipsName)) errors.push('El nombre de la IPS es requerido')
  if (!clean(b.shortName)) errors.push('El nombre corto es requerido')
  if (!HEX_RE.test(b.primaryColor || '')) errors.push('Color principal inválido')
  if (!HEX_RE.test(b.secondaryColor || '')) errors.push('Color secundario inválido')
  if (errors.length) return fail(res, errors.join('. '), 400)

  const { error } = await supabase.from('app_settings').update({
    ips_name: clean(b.ipsName), short_name: clean(b.shortName),
    primary_color: b.primaryColor.toUpperCase(), secondary_color: b.secondaryColor.toUpperCase(),
    updated_at: new Date().toISOString()
  }).eq('id', 1)
  if (error) throw error
  res.send(await getSettings())
}))

app.post('/configuracion/logo', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const url = await uploadImage('branding', 'logo', req.body?.image, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
  if (!url) return fail(res, 'Imagen inválida (PNG, JPG, WEBP o SVG de máximo 2 MB)', 400)
  const { error } = await supabase.from('app_settings').update({ logo_url: url, updated_at: new Date().toISOString() }).eq('id', 1)
  if (error) throw error
  await removeStoredFile('branding', before.logoUrl)
  res.send(await getSettings())
}))

app.delete('/configuracion/logo', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const { error } = await supabase.from('app_settings').update({ logo_url: null, updated_at: new Date().toISOString() }).eq('id', 1)
  if (error) throw error
  await removeStoredFile('branding', before.logoUrl)
  res.send(await getSettings())
}))

// ======================================================================
// Temperatura (administrador y empleado)
// ======================================================================
const formatDate = (d) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
const formatTime = (d) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
const isoDateBogota = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)

// Dos lecturas al día por sede: una en la mañana y otra en la tarde.
const SHIFTS = { manana: 'Mañana', tarde: 'Tarde' }
const TEMP_SELECT = 'id, recorded_at, record_date, shift, temp_min, temp_max, site_id, updated_at, users:users!temperature_created_by_fkey(name, last_name), editor:users!temperature_updated_by_fkey(name, last_name)'
const currentShift = () => (Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date())) % 24 < 12 ? 'manana' : 'tarde')
const toTempDTO = (t) => {
  const d = new Date(t.recorded_at)
  const [y, m, dd] = (t.record_date || isoDateBogota(d)).split('-')
  return {
    id: t.id,
    recordedAt: t.recorded_at,
    isoDate: t.record_date || isoDateBogota(d),
    date: `${dd}/${m}/${y}`,
    time: formatTime(d),
    shift: t.shift, shiftLabel: SHIFTS[t.shift],
    tempMin: Number(t.temp_min),
    tempMax: Number(t.temp_max),
    siteId: t.site_id,
    createdBy: t.users ? `${t.users.name} ${t.users.last_name}` : null,
    updatedAt: t.updated_at, updatedBy: t.editor ? `${t.editor.name} ${t.editor.last_name}` : null
  }
}
const validTemps = (b) => {
  const tempMin = Number(b?.tempMin); const tempMax = Number(b?.tempMax)
  if (b?.tempMin === '' || b?.tempMax === '' || b?.tempMin == null || b?.tempMax == null || Number.isNaN(tempMin) || Number.isNaN(tempMax)) return { error: 'Temperaturas inválidas' }
  if (tempMin > tempMax) return { error: 'La mínima no puede ser mayor que la máxima' }
  if (tempMin < -30 || tempMax > 60) return { error: 'Valores fuera de rango' }
  return { tempMin, tempMax }
}
const dupShiftMsg = (shift) => `Ya hay un registro de la ${SHIFTS[shift].toLowerCase()} para hoy en esta sede. Puedes modificarlo en la tabla.`

app.get('/temperatura/jornada', auth(STAFF), requireIps('cadena_frio'), (req, res) => res.send({ shift: currentShift(), date: todayBogota() }))

app.post('/registrar-temperatura', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const v = validTemps(req.body)
  if (v.error) return fail(res, v.error, 400)
  const shift = req.body?.shift || currentShift()
  if (!SHIFTS[shift]) return fail(res, 'Jornada inválida (mañana o tarde)', 400)
  const siteId = await targetSite(req, req.body?.siteId)
  const today = todayBogota()
  const { data: dup } = await supabase.from('temperature').select('id').eq('site_id', siteId).eq('record_date', today).eq('shift', shift).maybeSingle()
  if (dup) return fail(res, dupShiftMsg(shift), 409)
  // La fecha/hora la pone la base de datos (now()), no el navegador.
  const { data, error } = await supabase.from('temperature')
    .insert({ temp_min: v.tempMin, temp_max: v.tempMax, created_by: req.user.id, site_id: siteId, record_date: today, shift })
    .select(TEMP_SELECT).single()
  if (error) { if (error.code === '23505') return fail(res, dupShiftMsg(shift), 409); throw error }
  res.status(201).send(toTempDTO(data))
}))

const loadTemp = async (req) => {
  const { data } = await supabase.from('temperature').select('id, site_id, record_date, shift').eq('id', Number(req.params.id)).maybeSingle()
  if (!data || !canAccessSite(req, data.site_id)) return null
  return data
}
// Modificar: valores y jornada (no puede repetir jornada en el mismo día).
app.put('/temperatura/:id', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const cur = await loadTemp(req)
  if (!cur) return fail(res, 'Registro no encontrado', 404)
  const v = validTemps(req.body)
  if (v.error) return fail(res, v.error, 400)
  const shift = req.body?.shift || cur.shift
  if (!SHIFTS[shift]) return fail(res, 'Jornada inválida (mañana o tarde)', 400)
  if (shift !== cur.shift) {
    const { data: dup } = await supabase.from('temperature').select('id').eq('site_id', cur.site_id).eq('record_date', cur.record_date).eq('shift', shift).maybeSingle()
    if (dup) return fail(res, `Ese día ya tiene el registro de la ${SHIFTS[shift].toLowerCase()}`, 409)
  }
  const { data, error } = await supabase.from('temperature')
    .update({ temp_min: v.tempMin, temp_max: v.tempMax, shift, updated_by: req.user.id, updated_at: new Date().toISOString() })
    .eq('id', cur.id).select(TEMP_SELECT).single()
  if (error) { if (error.code === '23505') return fail(res, 'Ese día ya tiene un registro en esa jornada', 409); throw error }
  res.send(toTempDTO(data))
}))

app.delete('/temperatura/:id', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const cur = await loadTemp(req)
  if (!cur) return fail(res, 'Registro no encontrado', 404)
  const { error } = await supabase.from('temperature').delete().eq('id', cur.id)
  if (error) throw error
  res.send({ message: 'Registro eliminado' })
}))

// ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (opcionales)
app.get('/reporte-temperatura', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const desde = clean(req.query.desde); const hasta = clean(req.query.hasta)
  if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
  let q = applyScope(supabase.from('temperature').select(TEMP_SELECT), scopeSite(req)).order('record_date').order('shift')
  if (desde) q = q.gte('record_date', desde)
  if (hasta) q = q.lte('record_date', hasta)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(toTempDTO))
}))

// ======================================================================
// Citologías (administrador y empleado)
// ======================================================================
const CYTOLOGY_FIELDS = {
  numFactura: 'num_factura', fechaExamen: 'fecha_examen', numLamina: 'num_lamina', eps: 'eps', valor: 'valor',
  entidad: 'entidad', regimen: 'regimen', nombre: 'nombre', apellidos: 'apellidos', fechaNacimiento: 'fecha_nacimiento',
  tipoDocumento: 'tipo_documento', numDocumento: 'num_documento', lugarExped: 'lugar_exped', edad: 'edad',
  direccion: 'direccion', celular: 'celular', municipio: 'municipio', solicitudServ: 'solicitud_serv',
  ocupacion: 'ocupacion', estadoCivil: 'estado_civil', contacto: 'contacto', direccionContacto: 'direccion_contacto',
  celularContacto: 'celular_contacto', ciclosMenstruales: 'ciclos_menstruales', fur: 'fur', fup: 'fup',
  g: 'g', p: 'p', a: 'a', anticonceptivoActual: 'anticonceptivo_actual', tiempo: 'tiempo',
  edadPrimerCoito: 'edad_primer_coito', resultUltCitolog: 'result_ult_citolog', fechaUltCitolog: 'fecha_ult_citolog',
  tomadaEn: 'tomada_en', tratamientos: 'tratamientos', observaciones: 'observaciones',
  sano: 'sano', normal: 'normal', cupula: 'cupula', tomaVaginal: 'toma_vaginal', endoCerrado: 'endo_cerrado',
  polipo: 'polipo', quistes: 'quistes', lecorrea: 'lecorrea', sangra: 'sangra', erosionado: 'erosionado',
  sinEspecificar: 'sin_especificar', fechaRecibido: 'fecha_recibido', elabora: 'elabora', tomaMuestra: 'toma_muestra',
  email: 'email'
}
const SNAKE_TO_CAMEL = Object.fromEntries(Object.entries(CYTOLOGY_FIELDS).map(([c, s]) => [s, c]))
Object.assign(SNAKE_TO_CAMEL, { valor_base: 'valorBase', discount_id: 'discountId', discount_name: 'discountName', discount_amount: 'discountAmount' })
const toCamel = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [SNAKE_TO_CAMEL[k] || k, v]))
const BOOLEAN_FIELDS = ['sano', 'normal', 'cupula', 'tomaVaginal', 'endoCerrado', 'polipo', 'quistes', 'lecorrea', 'sangra', 'erosionado', 'sinEspecificar']
const NUMBER_FIELDS = ['valor', 'edad']
const REQUIRED_CYTOLOGY = ['nombre', 'apellidos', 'numDocumento', 'fechaNacimiento', 'celular', 'elabora', 'tomaMuestra']

async function getCytologyPrice () {
  const { precio } = await serviceSettings('citologia')
  return precio == null ? null : Number(precio)
}

const getEmployees = async (siteId) => {
  const { data, error } = await applyScope(supabase.from('users').select('id, name, last_name').eq('role', 'empleado').eq('active', true), siteId).order('name')
  if (error) throw error
  return data.map((u) => ({ id: u.id, fullName: `${u.name} ${u.last_name}`.trim() }))
}

const nextCode = (prefix, value) => `${prefix}-${String((value ? Number(value.replace(/\D/g, '')) : 0) + 1).padStart(7, '0')}`

app.get('/citologias/datos-formulario', auth(STAFF), requireIps('citologia'), h(async (req, res) => {
  const [price, employees, last, lastSlide] = await Promise.all([
    getCytologyPrice(),
    getEmployees(await targetSite(req)),
    supabase.from('cytology_samples').select('num_factura').order('num_factura', { ascending: false }).limit(1),
    supabase.from('cytology_samples').select('num_lamina').order('num_lamina', { ascending: false }).limit(1)
  ])
  if (last.error) throw last.error
  if (lastSlide.error) throw lastSlide.error
  res.send({
    valor: price,
    empleados: employees,
    fechaHoy: todayBogota(),
    siguienteFactura: nextCode('FV', last.data[0]?.num_factura),
    siguienteLamina: nextCode('L', lastSlide.data[0]?.num_lamina)
  })
}))

app.get('/empleados', auth(STAFF), h(async (req, res) => res.send(await getEmployees(scopeSite(req)))))

app.post('/registrar-toma-de-muestras-citologicas', auth(STAFF), requireIps('citologia'), h(async (req, res) => {
  const body = req.body || {}
  const missing = REQUIRED_CYTOLOGY.filter((f) => !clean(body[f]))
  if (missing.length) return fail(res, `Faltan datos requeridos: ${missing.join(', ')}`, 400)

  const row = {}
  for (const [camel, snake] of Object.entries(CYTOLOGY_FIELDS)) {
    let v = body[camel]
    if (BOOLEAN_FIELDS.includes(camel)) v = v === true || v === 'true'
    // Formato colombiano: "35.000" o "$ 35.000,50" -> 35000 / 35000.5
    else if (NUMBER_FIELDS.includes(camel)) v = clean(v) === null ? null : Number(String(v).replace(/[^\d,-]/g, '').replace(',', '.'))
    else v = clean(v)
    row[snake] = v
  }

  // Factura y lámina las asigna la base de datos (consecutivos FV-0000001 y L-0000001).
  delete row.num_factura
  delete row.num_lamina

  // Fecha del examen: hoy.
  row.fecha_examen = todayBogota()
  if (!ISO_DATE.test(row.fecha_nacimiento)) return fail(res, 'Fecha de nacimiento inválida', 400)
  if (row.fecha_nacimiento > row.fecha_examen) return fail(res, 'La fecha de nacimiento no puede ser posterior al examen', 400)

  // Edad calculada en el servidor a partir de la fecha de nacimiento.
  row.edad = ageAt(row.fecha_nacimiento, row.fecha_examen)
  if (row.edad > 120) return fail(res, 'Revisa la fecha de nacimiento', 400)

  const errors = []
  if (!PHONE_RE.test(row.celular || '')) errors.push('El celular debe tener 10 dígitos')
  if (row.celular_contacto && !PHONE_RE.test(row.celular_contacto)) errors.push('El celular del contacto debe tener 10 dígitos')
  if (row.email && !EMAIL_RE.test(row.email)) errors.push('El correo no es válido')
  if (row.email) row.email = row.email.toLowerCase()

  // El valor sale siempre de Citologías → Configuración (no se edita en cada registro).
  row.valor = await getCytologyPrice()
  if (row.valor == null) return fail(res, 'Configura el valor de la citología en Citologías → Configuración', 400)
  // Descuento opcional: se guarda el valor base, el descuento aplicado y el valor final.
  row.valor_base = row.valor
  if (body.discountId) {
    const { data: d } = await supabase.from('discounts').select('*').eq('id', Number(body.discountId)).maybeSingle()
    if (!d || !d.active) return fail(res, 'El descuento seleccionado no está disponible', 400)
    const amount = Math.min(row.valor, d.type === 'porcentaje' ? Math.round(row.valor * Number(d.value) / 100) : Number(d.value))
    row.discount_id = d.id; row.discount_name = d.name; row.discount_amount = amount
    row.valor = row.valor - amount
  }

  // Elaboró / tomó muestra deben ser empleados registrados de la sede.
  row.site_id = await targetSite(req, body.siteId)
  const names = (await getEmployees(row.site_id)).map((e) => e.fullName)
  if (!names.includes(row.elabora)) errors.push('"Elaboró historia" debe ser un empleado registrado')
  if (!names.includes(row.toma_muestra)) errors.push('"Tomó muestra" debe ser un empleado registrado')
  if (errors.length) return fail(res, errors.join('. '), 400)

  const { data, error } = await supabase.from('cytology_samples').insert(row).select('id, num_factura, num_lamina, edad').single()
  if (error) throw error
  res.status(201).send({ message: 'Datos registrados exitosamente', id: data.id, numFactura: data.num_factura, numLamina: data.num_lamina, edad: data.edad })
}))

// Búsqueda por rango de fecha de examen y/o número de documento. Devuelve solo datos básicos.
app.get('/consultar-citologias', auth(STAFF), requireIps('citologia'), h(async (req, res) => {
  const desde = clean(req.query.desde)
  const hasta = clean(req.query.hasta)
  const documento = clean(req.query.documento)
  if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
  if (desde && hasta && desde > hasta) return fail(res, 'La fecha inicial no puede ser mayor que la final', 400)

  let query = applyScope(supabase
    .from('cytology_samples')
    .select('id, fecha_examen, num_lamina, num_factura, nombre, apellidos, tipo_documento, num_documento, edad, eps, entidad, regimen'), scopeSite(req))
    .order('fecha_examen', { ascending: false })
    .order('id', { ascending: false })
    .limit(200)
  if (desde) query = query.gte('fecha_examen', desde)
  if (hasta) query = query.lte('fecha_examen', hasta)
  if (documento) query = query.ilike('num_documento', `%${documento.replace(/[%_\\]/g, '')}%`)

  const { data, error } = await query
  if (error) throw error
  res.send(data.map(toCamel))
}))

app.get('/citologias/:id', auth(STAFF), requireIps('citologia'), h(async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'Id inválido', 400)
  const { data, error } = await supabase.from('cytology_samples').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data || !canAccessSite(req, data.site_id)) return fail(res, 'Citología no encontrada', 404)
  res.send(toCamel(data))
}))

// ======================================================================
// Dashboard (todos los roles; solo lectura y datos agregados)
// ======================================================================
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  const start = `${ym}-01`
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start, next, prev, days }
}

const ABNORMAL = ['polipo', 'quistes', 'lecorrea', 'sangra', 'erosionado']
const countBy = (rows, key, fallback = 'Sin dato') => {
  const map = new Map()
  for (const r of rows) {
    const k = r[key] || fallback
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
}
const round1 = (n) => Math.round(n * 10) / 10

app.get('/dashboard', auth(NO_DRIVER), h(async (req, res) => {
  const today = todayBogota()
  const ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : today.slice(0, 7)
  const { start, next, prev, days } = monthRange(ym)
  const prevRange = monthRange(prev)
  const settings = await getSettings()
  const tMin = settings.tempMinThreshold; const tMax = settings.tempMaxThreshold
  const site = scopeSite(req)
  const sc = (q) => applyScope(q, site)

  const [temps, cyto, cytoPrev, recent, users, lastTemp] = await Promise.all([
    sc(supabase.from('temperature').select(TEMP_SELECT))
      .gte('recorded_at', `${start}T00:00:00${TZ_OFFSET}`).lt('recorded_at', `${next}T00:00:00${TZ_OFFSET}`).order('recorded_at'),
    sc(supabase.from('cytology_samples').select(`fecha_examen, entidad, regimen, valor, edad, ${ABNORMAL.join(', ')}`))
      .gte('fecha_examen', start).lt('fecha_examen', next),
    sc(supabase.from('cytology_samples').select('id', { count: 'exact', head: true }))
      .gte('fecha_examen', prevRange.start).lt('fecha_examen', prevRange.next),
    sc(supabase.from('cytology_samples').select('id, fecha_examen, nombre, apellidos, num_documento, num_lamina, entidad'))
      .order('fecha_examen', { ascending: false }).order('id', { ascending: false }).limit(5),
    sc(supabase.from('users').select('role, active')),
    sc(supabase.from('temperature').select('recorded_at, temp_min, temp_max')).order('recorded_at', { ascending: false }).limit(1)
  ])
  for (const r of [temps, cyto, cytoPrev, recent, users, lastTemp]) if (r.error) throw r.error

  // --- Temperatura ---
  const series = temps.data.map((t) => {
    const dto = toTempDTO(t)
    const alertHigh = dto.tempMax > tMax
    const alertLow = dto.tempMin < tMin
    return { ...dto, label: dto.date.slice(0, 5), alert: alertHigh || alertLow, alertHigh, alertLow }
  })
  const alerts = series.filter((s) => s.alert).map((s) => ({
    id: s.id, date: s.date, time: s.time, shift: s.shift, shiftLabel: s.shiftLabel, tempMin: s.tempMin, tempMax: s.tempMax,
    type: s.alertHigh ? 'alta' : 'baja',
    message: s.alertHigh ? `Máxima de ${s.tempMax} °C supera el límite de ${tMax} °C` : `Mínima de ${s.tempMin} °C por debajo de ${tMin} °C`
  })).reverse()
  const maxReading = series.reduce((acc, s) => (!acc || s.tempMax > acc.tempMax ? s : acc), null)
  const minReading = series.reduce((acc, s) => (!acc || s.tempMin < acc.tempMin ? s : acc), null)
  const avg = (arr) => (arr.length ? round1(arr.reduce((a, b) => a + b, 0) / arr.length) : null)
  const daysWithReading = new Set(series.map((s) => s.isoDate))
  const isCurrentMonth = ym === today.slice(0, 7)
  const elapsedDays = isCurrentMonth ? Number(today.slice(8, 10)) : days

  // --- Citologías ---
  const rows = cyto.data
  const perDay = Array.from({ length: days }, (_, i) => ({ day: String(i + 1).padStart(2, '0'), value: 0 }))
  for (const r of rows) perDay[Number(r.fecha_examen.slice(8, 10)) - 1].value += 1
  const ageGroups = [['< 25', 0, 24], ['25–34', 25, 34], ['35–44', 35, 44], ['45–54', 45, 54], ['55 +', 55, 200]]
    .map(([name, a, b]) => ({ name, value: rows.filter((r) => r.edad != null && r.edad >= a && r.edad <= b).length }))
  const abnormal = rows.filter((r) => ABNORMAL.some((k) => r[k])).length
  const FINDING_LABELS = { polipo: 'Pólipo', quistes: 'Quistes', lecorrea: 'Leucorrea', sangra: 'Sangra', erosionado: 'Erosionado' }
  const findings = ABNORMAL.map((k) => ({ name: FINDING_LABELS[k], value: rows.filter((r) => r[k]).length }))

  // --- Usuarios ---
  const activeUsers = users.data.filter((u) => u.active)

  res.send({
    month: ym,
    siteId: site,
    today,
    thresholds: { min: tMin, max: tMax },
    temperature: {
      series,
      alerts,
      stats: {
        count: series.length,
        alerts: alerts.length,
        max: maxReading ? { value: maxReading.tempMax, date: maxReading.date } : null,
        min: minReading ? { value: minReading.tempMin, date: minReading.date } : null,
        avgMax: avg(series.map((s) => s.tempMax)),
        avgMin: avg(series.map((s) => s.tempMin)),
        compliance: elapsedDays ? Math.round((daysWithReading.size / elapsedDays) * 100) : 0,
        daysWithReading: daysWithReading.size,
        elapsedDays
      },
      registeredToday: isCurrentMonth ? daysWithReading.has(today) : null,
      last: lastTemp.data[0] ? toTempDTO(lastTemp.data[0]) : null
    },
    cytology: {
      count: rows.length,
      prevCount: cytoPrev.count,
      revenue: rows.reduce((a, r) => a + Number(r.valor || 0), 0),
      abnormal,
      findings,
      perDay,
      byEntidad: countBy(rows, 'entidad'),
      byRegimen: countBy(rows, 'regimen'),
      ageGroups,
      // Datos de pacientes solo para personal asistencial; el invitado ve agregados.
      recent: STAFF.includes(req.user.role) ? recent.data.map(toCamel) : []
    },
    users: {
      total: activeUsers.length,
      byRole: ROLES.map((r) => ({ name: r, value: activeUsers.filter((u) => u.role === r).length }))
    }
  })
}))

// Módulo Gestión de Socorro y Operaciones
const SCOPE = { scopeSite, applyScope, canAccessSite, targetSite }
require('./socorro')(app, { userModules, supabase, auth, h, fail, clean, ADMIN, STAFF, NO_DRIVER, EMAIL_RE, PHONE_RE, ISO_DATE, TZ, TZ_OFFSET, todayBogota, ...SCOPE })
// Preoperacional diario de vehículos
require('./inspections')(app, { supabase, auth, h, fail, clean, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, ...SCOPE })
// Módulo de vehículos (flota)
// Módulo IPS: hoja de vida de equipos
require('./inventory')(app, { supabase, auth, h, fail, clean, ADMIN, STAFF, ISO_DATE, TZ_OFFSET, todayBogota, ...SCOPE })
require('./equipment')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, uploadImage, removeStoredFile, ...SCOPE })
require('./signatures')(app, { supabase, auth, h, fail, clean, ADMIN, uploadImage, removeStoredFile, canAccessSite })
require('./vehicles')(app, { supabase, auth, h, fail, clean, ADMIN, STAFF, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, ...SCOPE })

app.listen(PORT, () => console.log(`API escuchando en http://localhost:${PORT}`))
