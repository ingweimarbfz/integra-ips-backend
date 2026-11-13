require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const compression = require('compression')
const { pageQuery, setTotal } = require('./paging')
const tenant = require('./tenant')
const platform = require('./platform')
let legal = null // documentos legales: se registra más abajo
// Rutas permitidas mientras el contrato y el acuerdo de datos no estén firmados.
const LEGAL_ALLOW = ['/auth/me', '/legal', '/firma', '/configuracion', '/plan', '/perfil']

const {
  SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET,
  PORT = 4000, CORS_ORIGIN = 'http://localhost:3000', SESSION_HOURS = 8
} = process.env
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !JWT_SECRET) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SECRET_KEY o JWT_SECRET en el archivo .env (ver .env.example)')
  process.exit(1)
}

// Cliente con la clave secreta: solo vive en el servidor, nunca en el navegador.
// Si la red cambia (Wi-Fi, VPN, suspensión del equipo) una conexión reutilizada puede quedar colgada
// y la app se queda "cargando". Cada consulta tiene un tiempo límite; las lecturas (GET/HEAD) se reintentan una vez.
const SB_TIMEOUT = { read: 15000, write: 60000 }
const fetchWithTimeout = async (url, opts = {}) => {
  const method = String(opts.method || 'GET').toUpperCase()
  const read = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('Tiempo de espera agotado con la base de datos')), read ? SB_TIMEOUT.read : SB_TIMEOUT.write)
    if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal.reason), { once: true })
    try {
      return await fetch(url, { ...opts, headers: tenant.orgHeaders(opts.headers), signal: ctrl.signal })
    } catch (e) {
      if (!read || attempt >= 1 || opts.signal?.aborted) throw e
      console.warn(`[supabase] reintentando ${method} tras: ${e.message}`)
    } finally { clearTimeout(timer) }
  }
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithTimeout }
})
tenant.scopeClient(supabase)
tenant.setEnsure((id) => platform.ensure(id))

const app = express()
// CORS_ORIGIN admite varios orígenes separados por coma (p. ej. localhost y la URL pública del frontend).
app.use(cors({ origin: CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean), exposedHeaders: ['X-Total-Count'] }))
// Respuestas comprimidas (gzip/deflate): los JSON grandes viajan 70–80 % más livianos.
app.use(compression({ threshold: 1024 }))
app.use(express.json({ limit: '25mb' })) // imágenes en base64 (foto de perfil y logo)

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
const MODULE_KEYS = ['ips_dashboard', 'citologias', 'facturacion', 'vacunacion', 'temperatura', 'traslado', 'equipos', 'og_dashboard', 'socorro', 'educacion', 'personas', 'reporte_voluntarios', 'inventario', 'flota', 'voluntario', 'talento_humano', 'procesos_prioritarios', 'interdependencia', 'medicamentos', 'infraestructura', 'historia_clinica', 'doc_generales']
const ROLE_MODULES = {
  empleado: ['ips_dashboard', 'citologias', 'facturacion', 'vacunacion', 'temperatura', 'equipos', 'og_dashboard', 'socorro', 'educacion', 'personas', 'reporte_voluntarios', 'inventario', 'flota', 'talento_humano', 'procesos_prioritarios', 'interdependencia', 'medicamentos', 'infraestructura', 'historia_clinica', 'doc_generales'],
  voluntario: ['socorro', 'educacion', 'voluntario'],
  conductor: ['flota', 'traslado'],
  administrador: MODULE_KEYS
}
// El plan contratado (plataforma) limita los módulos de todos, incluido el administrador.
const inPlan = (m) => !platform.state.modules || platform.state.modules.includes(m)
// Funciones del plan que no son módulos del menú (p. ej. envío de documentos, recordatorios automáticos).
const hasFeature = (k) => !platform.state.features || platform.state.features.includes(k)
const userModules = (u) => (u.role === 'administrador' ? MODULE_KEYS : Array.isArray(u.modules) ? u.modules.filter((m) => MODULE_KEYS.includes(m)) : ROLE_MODULES[u.role] || []).filter(inPlan)
// Ruta → módulo (el primero que coincide). Las rutas sin módulo solo dependen del rol.
const ROUTE_MODULES = [
  ['/citologias', ['citologias']], ['/registrar-toma-de-muestras-citologicas', ['citologias']], ['/consultar-citologias', ['citologias']],
  ['/facturacion', ['facturacion']], ['/calidad', ['doc_generales']], ['/vacunacion', ['vacunacion']],
  ['/registrar-temperatura', ['temperatura']], ['/reporte-temperatura', ['temperatura']], ['/temperatura', ['temperatura']],
  ['/ambulancias-dashboard', ['traslado']], ['/equipos', ['equipos']], ['/dashboard', ['ips_dashboard']],
  ['/estandares/th', ['talento_humano']], ['/estandares/documentos/procesos_prioritarios', ['procesos_prioritarios']], ['/estandares/documentos/interdependencia', ['interdependencia']], ['/estandares/documentos/medicamentos', ['medicamentos']], ['/estandares/documentos/infraestructura', ['infraestructura']], ['/estandares/documentos/historia_clinica', ['historia_clinica']], ['/socorro/dashboard', ['og_dashboard']], ['/socorro/reporte-voluntarios', ['reporte_voluntarios']], ['/socorro/eventos', ['socorro', 'educacion']], ['/socorro/inventario', ['socorro', 'educacion']],
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
const USER_COLUMNS = 'id, org_id, identification, name, last_name, username, role, email, avatar_url, signature_url, remunerado, active, created_at, site_id, modules, site:sites(' + SITE_SELECT + ')'

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
  plan: platform.state.plan ? { name: platform.state.plan.name, code: platform.state.plan.code, modules: platform.state.modules } : null,
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
    // Multi-cliente: el resto de la petición corre en el contexto de la organización del usuario.
    await platform.ensure(user.org_id)
    return tenant.runAsOrg(user.org_id, () => authorize(req, res, next, roles, user))
  } catch (e) {
    fail(res, e)
  }
}
const authorize = async (req, res, next, roles, user) => {
  try {
    // Permisos: rol del endpoint + módulos del usuario.
    const mods = routeModules(req.path)
    if (mods && !mods.some(inPlan)) return fail(res, 'Tu plan no incluye este módulo. Consulta las opciones de plan con el proveedor.', 403)
    if (legal && !LEGAL_ALLOW.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      const st = await legal.current()
      if (st.pending) return fail(res, 'El servicio está pendiente de activación: el administrador debe firmar el contrato y el acuerdo de tratamiento de datos.', 423)
    }
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

app.get('/', (req, res) => res.send('API Integra IPS (Supabase)'))

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
  await platform.ensure(user.org_id)
  tenant.runAsOrg(user.org_id, () => res.send({ token: signToken(user), user: toUserDTO(user) }))
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
  // Los recordatorios de temperatura se guardan aparte (/temperatura/recordatorios): se conservan.
  const keep = svc.settings?.reminders ? { reminders: svc.settings.reminders } : {}
  const { error } = await supabase.from('ips_services').update({ settings: { ...next, custom, ...keep } }).eq('id', id)
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
  citologia: [], // el valor de la citología está en Facturación → Tarifario
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
    supabase.from('app_settings').select('*').maybeSingle(),
    serviceSettings('cadena_frio'),
    getCytologyPrice()
  ])
  if (error) throw error
  const price = cyto
  return {
    ipsName: s.ips_name,
    shortName: s.short_name,
    primaryColor: s.primary_color,
    secondaryColor: s.secondary_color,
    logoUrl: s.logo_url,
    loginImageUrl: s.login_image_url,
    loginDescription: s.login_description,
    loginFooter: s.login_footer,
    tempMinThreshold: Number(cold.temp_min),
    tempMaxThreshold: Number(cold.temp_max),
    cytologyPrice: price,
    updatedAt: s.updated_at
  }
}

// Público: el login necesita el nombre, los colores y el logo antes de iniciar sesión.
// Organización por defecto de la instalación (la que se muestra en el login antes de iniciar sesión).
let defaultOrg = { id: null, at: 0 }
const defaultOrgId = async () => {
  if (defaultOrg.id && Date.now() - defaultOrg.at < 300000) return defaultOrg.id
  const { data } = await supabase.from('plt_organizations').select('id').eq('is_current', true).maybeSingle()
  defaultOrg = { id: data?.id || 1, at: Date.now() }
  return defaultOrg.id
}
app.get('/configuracion/publica', h(async (req, res) => {
  const s = await tenant.runAsOrg(Number(req.query.org) || await defaultOrgId(), () => getSettings())
  res.send({ ipsName: s.ipsName, shortName: s.shortName, primaryColor: s.primaryColor, secondaryColor: s.secondaryColor, logoUrl: s.logoUrl, loginImageUrl: s.loginImageUrl, loginDescription: s.loginDescription, loginFooter: s.loginFooter })
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
    ...('loginDescription' in b ? { login_description: clean(b.loginDescription)?.slice(0, 600) ?? null } : {}),
    ...('loginFooter' in b ? { login_footer: clean(b.loginFooter)?.slice(0, 200) ?? null } : {}),
    updated_at: new Date().toISOString()
  })
  if (error) throw error
  res.send(await getSettings())
}))

app.post('/configuracion/logo', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const url = await uploadImage('branding', 'logo', req.body?.image, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
  if (!url) return fail(res, 'Imagen inválida (PNG, JPG, WEBP o SVG de máximo 2 MB)', 400)
  const { error } = await supabase.from('app_settings').update({ logo_url: url, updated_at: new Date().toISOString() })
  if (error) throw error
  await removeStoredFile('branding', before.logoUrl)
  res.send(await getSettings())
}))

// Imagen de fondo del inicio de sesión (configurable por la IPS).
app.post('/configuracion/login-imagen', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const url = await uploadImage('branding', 'login', req.body?.image, ['image/png', 'image/jpeg', 'image/webp'])
  if (!url) return fail(res, 'Imagen inválida (PNG, JPG o WEBP de máximo 2 MB)', 400)
  const { error } = await supabase.from('app_settings').update({ login_image_url: url, updated_at: new Date().toISOString() })
  if (error) throw error
  await removeStoredFile('branding', before.loginImageUrl)
  res.send(await getSettings())
}))
app.delete('/configuracion/login-imagen', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const { error } = await supabase.from('app_settings').update({ login_image_url: null, updated_at: new Date().toISOString() })
  if (error) throw error
  await removeStoredFile('branding', before.loginImageUrl)
  res.send(await getSettings())
}))

app.delete('/configuracion/logo', auth(ADMIN), h(async (req, res) => {
  const before = await getSettings()
  const { error } = await supabase.from('app_settings').update({ logo_url: null, updated_at: new Date().toISOString() })
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
const TEMP_SELECT = 'id, recorded_at, record_date, shift, slot, temp_min, temp_max, site_id, updated_at, users:users!temperature_created_by_fkey(name, last_name), editor:users!temperature_updated_by_fkey(name, last_name)'
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
    shift: t.shift, shiftLabel: SHIFTS[t.shift], slot: t.slot || 1, slotLabel: `${SHIFTS[t.shift]} · ${t.slot || 1}.ª lectura`,
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


// ---------------------------------------------------------------- Recordatorios del registro de temperatura
// Cada día se registran 2 jornadas (mañana y tarde, cada una con mínima y máxima = 4 temperaturas).
// A cada hora configurada se avisa si la jornada indicada aún no se registra.
const DEFAULT_REMINDERS = { enabled: true, reminders: [{ time: '09:00', shift: 'manana' }, { time: '12:00', shift: 'manana' }, { time: '14:00', shift: 'tarde' }, { time: '18:00', shift: 'tarde' }] }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const coldService = async () => (await supabase.from('ips_services').select('id, settings, active').eq('module', 'cadena_frio').maybeSingle()).data
const reminderConfig = (svc) => {
  const r = svc?.settings?.reminders
  return r && Array.isArray(r.reminders) ? { enabled: r.enabled !== false, reminders: r.reminders } : DEFAULT_REMINDERS
}
// Lecturas del día: una por cada hora de recordatorio (por defecto 2 en la mañana y 2 en la tarde).
// Cada lectura registra la temperatura mínima y máxima del termómetro de la nevera.
// Cada lectura se habilita desde 30 minutos antes de su hora y deben registrarse en orden
// (mañana 1.ª → mañana 2.ª → tarde 1.ª → tarde 2.ª): no se puede adelantar una lectura de la tarde en la mañana.
const READING_EARLY_MIN = 30
const shiftHHMM = (hhmm, delta) => { const [h, m] = hhmm.split(':').map(Number); const t = Math.max(0, Math.min(1439, h * 60 + m + delta)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
const readingPlan = (cfg) => {
  const out = []
  for (const shift of Object.keys(SHIFTS)) {
    const times = (cfg.reminders || []).filter((r) => r.shift === shift).map((r) => r.time).sort().slice(0, 4)
    const list = times.length ? times : (shift === 'manana' ? ['08:00', '12:00'] : ['14:00', '18:00'])
    list.forEach((time, i) => out.push({ shift, slot: i + 1, time, opensAt: shiftHHMM(time, -READING_EARLY_MIN), label: `${SHIFTS[shift]} · ${i + 1}.ª lectura (${time})` }))
  }
  return out
}
const slotKey = (shift, slot) => `${shift}-${slot || 1}`
// Siguiente lectura en orden; no se puede saltar ni adelantar ni registrar antes de su hora.
const pickReading = (plan, taken, shift, slot, now) => {
  const next = plan.find((p) => !taken.has(slotKey(p.shift, p.slot)))
  if (!next) return { error: `Hoy ya están las ${plan.length} lecturas del día.` }
  const s = slot || (shift ? plan.find((p) => p.shift === shift && !taken.has(slotKey(shift, p.slot)))?.slot : null)
  const want = shift || slot ? plan.find((p) => p.shift === (shift || next.shift) && p.slot === s) : next
  if (!want) return { error: `Ya están las lecturas de la ${SHIFTS[shift || next.shift].toLowerCase()} de hoy` }
  const name = (p) => `${p.slot}.ª lectura de la ${SHIFTS[p.shift].toLowerCase()}`
  if (taken.has(slotKey(want.shift, want.slot))) return { error: `Ya se registró la ${name(want)} de hoy. Puedes modificarla en la tabla.` }
  if (want !== next) return { error: `Las lecturas van en orden: primero registra la ${name(next)} (${next.time}).` }
  if (now < want.opensAt) return { error: `Aún no es hora de la ${name(want)} (${want.time}). Se habilita a las ${want.opensAt}.` }
  return { reading: want }
}
app.get('/temperatura/jornada', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const plan = readingPlan(reminderConfig(await coldService()))
  res.send({ shift: currentShift(), date: todayBogota(), now: nowHHMM(), plan })
}))
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
app.get('/temperatura/recordatorios', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const svc = await coldService()
  const cfg = reminderConfig(svc)
  const today = todayBogota()
  // Sedes a revisar: la del usuario, la filtrada, o todas las que tienen cadena de frío (administrador).
  let siteIds = []
  const scoped = scopeSite(req)
  if (scoped) siteIds = [scoped]
  else if (svc) siteIds = ((await supabase.from('site_services').select('site_id').eq('service_id', svc.id)).data || []).map((x) => x.site_id)
  const [{ data: sites }, { data: temps }] = await Promise.all([
    supabase.from('sites').select('id, name').in('id', siteIds.length ? siteIds : [0]),
    supabase.from('temperature').select('site_id, shift, slot').eq('record_date', today).in('site_id', siteIds.length ? siteIds : [0])
  ])
  // Cada recordatorio corresponde a una lectura (1.ª o 2.ª de su jornada, por orden de hora).
  const plan = readingPlan(cfg)
  const reminders = cfg.reminders.map((r) => ({ ...r, slot: plan.find((p) => p.shift === r.shift && p.time === r.time)?.slot || 1 }))
  res.send({
    ...cfg, reminders, plan, today, now: nowHHMM(),
    sites: (sites || []).map((x) => ({ siteId: x.id, siteName: x.name, done: Object.fromEntries(plan.map((p) => [slotKey(p.shift, p.slot), temps.some((t) => t.site_id === x.id && t.shift === p.shift && (t.slot || 1) === p.slot)])) }))
  })
}))
app.put('/temperatura/recordatorios', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const list = Array.isArray(b.reminders) ? b.reminders : []
  if (list.length > 10) return fail(res, 'Máximo 10 recordatorios', 400)
  for (const r of list) if (!HHMM.test(r?.time || '') || !SHIFTS[r?.shift]) return fail(res, 'Cada recordatorio necesita una hora válida (HH:MM) y una jornada', 400)
  const reminders = [...new Map(list.map((r) => [r.time, { time: r.time, shift: r.shift }])).values()].sort((a, c) => a.time.localeCompare(c.time))
  const svc = await coldService()
  if (!svc) return fail(res, 'No hay un servicio de cadena de frío', 404)
  const { error } = await supabase.from('ips_services').update({ settings: { ...(svc.settings || {}), reminders: { enabled: b.enabled !== false, reminders } } }).eq('id', svc.id)
  if (error) throw error
  res.send({ enabled: b.enabled !== false, reminders })
}))

app.post('/registrar-temperatura', auth(STAFF), requireIps('cadena_frio'), h(async (req, res) => {
  const v = validTemps(req.body)
  if (v.error) return fail(res, v.error, 400)
  const shift = req.body?.shift || currentShift()
  if (!SHIFTS[shift]) return fail(res, 'Jornada inválida (mañana o tarde)', 400)
  const siteId = await targetSite(req, req.body?.siteId)
  const today = todayBogota()
  const plan = readingPlan(reminderConfig(await coldService()))
  // Lecturas del día (por defecto 4: dos en la mañana y dos en la tarde); completas, no se registra más hasta mañana.
  const { data: dayRows } = await supabase.from('temperature').select('id, shift, slot').eq('site_id', siteId).eq('record_date', today)
  const taken = new Set((dayRows || []).map((r) => slotKey(r.shift, r.slot)))
  if (plan.every((p) => taken.has(slotKey(p.shift, p.slot)))) return fail(res, `Hoy ya están las ${plan.length} lecturas del día. El próximo registro se habilita mañana; si necesitas corregir una lectura, modifícala.`, 409)
  const pick = pickReading(plan, taken, req.body?.shift ? shift : null, Number(req.body?.slot) || null, nowHHMM())
  if (pick.error) return fail(res, pick.error, 409)
  const want = pick.reading
  // La fecha/hora la pone la base de datos (now()), no el navegador.
  const { data, error } = await supabase.from('temperature')
    .insert({ temp_min: v.tempMin, temp_max: v.tempMax, created_by: req.user.id, site_id: siteId, record_date: today, shift: want.shift, slot: want.slot })
    .select(TEMP_SELECT).single()
  if (error) { if (error.code === '23505') return fail(res, dupShiftMsg(shift), 409); throw error }
  const dto = toTempDTO(data)
  res.status(201).send(dto)
  // Aviso por Telegram (en segundo plano): sede, lectura y si quedó fuera de rango.
  ;(async () => {
    const [{ data: site }, cold] = await Promise.all([supabase.from('sites').select('name').eq('id', siteId).maybeSingle(), serviceSettings('cadena_frio')])
    notifier.notify('temperatura', notifier.messages.temperatura({ ...dto, siteName: site?.name }, { min: Number(cold.temp_min), max: Number(cold.temp_max) }), siteId)
  })().catch((e) => console.error('Aviso de temperatura:', e.message))
}))

const loadTemp = async (req) => {
  const { data } = await supabase.from('temperature').select('id, site_id, record_date, shift, slot').eq('id', Number(req.params.id)).maybeSingle()
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
  const slot = Number(req.body?.slot) || cur.slot || 1
  if (slot < 1 || slot > 4) return fail(res, 'Lectura inválida', 400)
  if (shift !== cur.shift || slot !== (cur.slot || 1)) {
    const { data: dup } = await supabase.from('temperature').select('id').eq('site_id', cur.site_id).eq('record_date', cur.record_date).eq('shift', shift).eq('slot', slot).maybeSingle()
    if (dup) return fail(res, `Ese día ya tiene la ${slot}.ª lectura de la ${SHIFTS[shift].toLowerCase()}`, 409)
  }
  const { data, error } = await supabase.from('temperature')
    .update({ temp_min: v.tempMin, temp_max: v.tempMax, shift, slot, updated_by: req.user.id, updated_at: new Date().toISOString() })
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
  let q = applyScope(supabase.from('temperature').select(TEMP_SELECT), scopeSite(req)).order('record_date').order('shift').order('slot')
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
Object.assign(SNAKE_TO_CAMEL, { valor_base: 'valorBase', discount_id: 'discountId', discount_name: 'discountName', discount_amount: 'discountAmount', entity_id: 'entityId', eps_id: 'epsId', payment_mode: 'paymentMode', billing_status: 'billingStatus' })
const toCamel = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [SNAKE_TO_CAMEL[k] || k, v]))
const BOOLEAN_FIELDS = ['sano', 'normal', 'cupula', 'tomaVaginal', 'endoCerrado', 'polipo', 'quistes', 'lecorrea', 'sangra', 'erosionado', 'sinEspecificar']
const NUMBER_FIELDS = ['valor', 'edad']
const REQUIRED_CYTOLOGY = ['nombre', 'apellidos', 'numDocumento', 'fechaNacimiento', 'celular', 'elabora', 'tomaMuestra']

// El valor de la citología sale del tarifario (Facturación → Tarifario): tarifa por defecto del servicio de citología.
async function getCytologyTariff () {
  const { data: svc } = await supabase.from('ips_services').select('id').eq('module', 'citologia').maybeSingle()
  if (!svc) return null
  const { data } = await supabase.from('service_tariffs').select('id, name, price, is_default').eq('service_id', svc.id).eq('active', true).order('is_default', { ascending: false }).order('id').limit(1)
  return data?.[0] ? { ...data[0], serviceId: svc.id, price: Number(data[0].price) } : null
}
async function getCytologyPrice () {
  const t = await getCytologyTariff()
  return t ? t.price : null
}

const getEmployees = async (siteId) => {
  const { data, error } = await applyScope(supabase.from('users').select('id, name, last_name').eq('role', 'empleado').eq('active', true), siteId).order('name')
  if (error) throw error
  return data.map((u) => ({ id: u.id, fullName: `${u.name} ${u.last_name}`.trim() }))
}

const nextCode = (prefix, value) => `${prefix}-${String((value ? Number(value.replace(/\D/g, '')) : 0) + 1).padStart(7, '0')}`

// Entidades, EPS con convenio y cuentas de cobro (antes de /citologias/:id para que no se confundan las rutas).
const billing = require('./billing')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite, targetSite: (...a) => targetSite(...a), inPlan: (m) => inPlan(m) })
// Cadena de frío: proveedores de los equipos (contacto cuando la temperatura supera el límite).
const coldchain = require('./coldchain')(app, { supabase, auth, h, fail, clean, ADMIN, scopeSite, canAccessSite })
// Servicio de vacunación: registro nominal, inventario de biológicos, carné, seguimiento, ESAVI y dashboard.
const vaccination = require('./vaccination')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite, targetSite: (...a) => targetSite(...a), requireIps, billing, inPlan: (m) => inPlan(m), getEmployees: (...a) => getEmployees(...a) })
// Compartir carnet de vacunación y facturas por correo y WhatsApp (enlace privado con vencimiento).
const share = require('./share')(app, { supabase, auth, h, fail, clean, canAccessSite, getSettings: () => getSettings(), billing, vaccination, hasFeature: (k) => hasFeature(k) })
// Recordatorios de la siguiente dosis por correo y WhatsApp (tarea diaria, modo prueba).
require('./reminders')(app, { supabase, auth, h, fail, clean, ADMIN, todayBogota, getSettings: () => getSettings(), share, TZ, hasFeature: (k) => hasFeature(k) })
// Notificaciones por Telegram (grupos por sección).
const notifier = require('./notify')(app, { supabase, auth, h, fail, clean, ADMIN, TZ, inPlan: (m) => inPlan(m), hasFeature: (k) => hasFeature(k) })

app.get('/citologias/datos-formulario', auth(STAFF), requireIps('citologia'), h(async (req, res) => {
  const [price, employees, last, lastSlide] = await Promise.all([
    getCytologyPrice(),
    getEmployees(await targetSite(req)),
    Promise.resolve({ data: [], error: null }),
    supabase.from('cytology_samples').select('num_lamina').order('num_lamina', { ascending: false }).limit(1)
  ])
  if (last.error) throw last.error
  if (lastSlide.error) throw lastSlide.error
  res.send({
    valor: price,
    empleados: employees,
    fechaHoy: todayBogota(),
    siguienteFactura: null, // la factura se genera en Facturación → Servicios facturables
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

  // Fecha del examen y de recibido: hoy (el día en que se registra).
  row.fecha_examen = todayBogota()
  row.fecha_recibido = row.fecha_examen
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

  // Primero se factura (Facturación → Servicios facturables) y el formulario toma esa factura por el documento de la paciente.
  // Sin el módulo de facturación en el plan, la citología se registra sin factura y queda "por facturar".
  row.site_id = await targetSite(req, body.siteId)
  const tariff = await getCytologyTariff()
  if (!tariff) return fail(res, 'Configura la tarifa de la citología en Facturación → Tarifario', 400)
  let invoice = null
  if (inPlan('facturacion')) {
    if (!Number(body.invoiceId)) return fail(res, 'Primero factura la citología en Facturación → Servicios facturables y elige aquí la factura de la paciente', 400)
    try { invoice = await billing.takeInvoice(req, { module: 'citologia', chargeId: body.invoiceId, docNumber: row.num_documento, siteId: row.site_id }) } catch (e) { return fail(res, e.message, e.status || 400) }
  }
  let bill
  try { bill = await billing.resolveBilling({ entityId: body.entityId, epsId: invoice ? invoice.eps_id : body.epsId }, tariff.price) } catch (e) { return fail(res, e.message, e.status || 400) }
  row.entity_id = bill.entity_id; row.eps_id = bill.eps_id
  if (bill.entidad) row.entidad = bill.entidad
  row.eps = bill.eps || null
  if (invoice) {
    // Los valores y la forma de pago son los de la factura.
    Object.assign(row, {
      num_factura: invoice.invoice_number, valor_base: invoice.unitBase, valor: invoice.unitValor, discount_id: invoice.discount_id ?? null,
      discount_name: invoice.discount_name, discount_amount: invoice.unitDiscount || null, payment_mode: invoice.payment_mode, billing_status: invoice.billing_status, billing_id: invoice.billing_id
    })
  } else {
    row.valor = tariff.price; row.valor_base = tariff.price; row.payment_mode = 'contado'; row.billing_status = 'por_facturar'
  }

  // Elaboró / tomó muestra deben ser empleados registrados de la sede.
  const names = (await getEmployees(row.site_id)).map((e) => e.fullName)
  if (!names.includes(row.elabora)) errors.push('"Elaboró historia" debe ser un empleado registrado')
  if (!names.includes(row.toma_muestra)) errors.push('"Tomó muestra" debe ser un empleado registrado')
  if (errors.length) return fail(res, errors.join('. '), 400)

  const { data, error } = await supabase.from('cytology_samples').insert(row).select('id, num_factura, num_lamina, edad').single()
  if (error) throw error
  if (invoice) {
    try { await billing.linkInvoice(invoice.id, 'cytology_samples', data.id, data.num_lamina, { doc: row.num_documento, name: `${row.nombre || ''} ${row.apellidos || ''}`.trim() }) } catch (e) { console.error('No se pudo enlazar la factura', invoice.invoice_number, data.id, e.message) }
    return res.status(201).send({ message: 'Datos registrados exitosamente', id: data.id, numFactura: data.num_factura, numLamina: data.num_lamina, edad: data.edad })
  }
  // Sin facturación en el plan: queda "por facturar".
  await billing.recordCharge({
    site_id: row.site_id, service_id: tariff.serviceId, service_name: 'Citología', source_table: 'cytology_samples', source_id: data.id,
    service_date: row.fecha_examen, patient_name: `${row.nombre || ''} ${row.apellidos || ''}`.trim(), patient_doc: `${row.tipo_documento || ''} ${row.num_documento || ''}`.trim(),
    reference: data.num_lamina, eps_id: row.eps_id, entity_id: row.entity_id, valor_base: tariff.price, discount_amount: 0, valor: tariff.price,
    payment_mode: 'contado', billing_status: 'por_facturar', created_by: req.user.id
  }, [{ tariff_id: tariff.id, name: tariff.name, quantity: 1, unit_price: tariff.price, subtotal: tariff.price }]).catch((e) => console.error('No se pudo registrar el cobro de la citología', data.id, e.message))
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
    .select('id, fecha_examen, num_lamina, num_factura, nombre, apellidos, tipo_documento, num_documento, edad, eps, entidad, regimen', { count: 'exact' }), scopeSite(req))
    .order('fecha_examen', { ascending: false })
    .order('id', { ascending: false })
  if (desde) query = query.gte('fecha_examen', desde)
  if (hasta) query = query.lte('fecha_examen', hasta)
  if (documento) query = query.ilike('num_documento', `%${documento.replace(/[%_\\]/g, '')}%`)

  const { data, error, count } = await pageQuery(req, query, 200)
  if (error) throw error
  setTotal(res, count)
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

  // Alerta de cadena de frío: última lectura de cada sede (últimos 3 días) por encima del límite → contactar al proveedor.
  const since = new Date(Date.now() - 3 * 86400000).toISOString()
  const recentTemps = await sc(supabase.from('temperature').select('id, recorded_at, record_date, shift, temp_min, temp_max, site_id, site:sites(name)')).gte('recorded_at', since).order('recorded_at', { ascending: false })
  if (recentTemps.error) throw recentTemps.error
  const latestBySite = {}
  for (const t of recentTemps.data) if (!latestBySite[t.site_id]) latestBySite[t.site_id] = t
  const hot = Object.values(latestBySite).filter((t) => Number(t.temp_max) > tMax)
  const contacts = hot.length ? await coldchain.contactsBySite(hot.map((t) => t.site_id)) : {}
  const coldChainAlerts = hot.map((t) => ({
    siteId: t.site_id, siteName: t.site?.name ?? null, reading: toTempDTO(t), limit: tMax,
    message: `La última lectura (${Number(t.temp_max)} °C) supera el límite de ${tMax} °C. Comunícate con el proveedor de los equipos de cadena de frío.`,
    // Un proveedor por tarjeta, con los equipos y servicios que atiende en la sede.
    providers: Object.values((contacts[t.site_id] || []).reduce((acc, c) => {
      const o = acc[c.provider.id] = acc[c.provider.id] || { ...c.provider, services: [], equipment: [] }
      if (!o.services.includes(c.serviceLabel)) o.services.push(c.serviceLabel)
      if (!o.equipment.includes(c.equipment.name)) o.equipment.push(c.equipment.name)
      return acc
    }, {})).map((o) => ({ ...o, service: o.services.join(' · '), equipment: o.equipment.join(', ') }))
  }))

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
    coldChainAlerts,
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
require('./socorro')(app, { userModules, notify: (...a) => notifier.notify(...a), notifyMsg: () => notifier.messages, supabase, auth, h, fail, clean, ADMIN, STAFF, NO_DRIVER, EMAIL_RE, PHONE_RE, ISO_DATE, TZ, TZ_OFFSET, todayBogota, ...SCOPE })
// Preoperacional diario de vehículos
require('./inspections')(app, { notify: (...a) => notifier.notify(...a), notifyMsg: () => notifier.messages, supabase, auth, h, fail, clean, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, ...SCOPE })
// Módulo de vehículos (flota)
// Módulo IPS: hoja de vida de equipos
require('./inventory')(app, { supabase, auth, h, fail, clean, ADMIN, STAFF, ISO_DATE, TZ_OFFSET, todayBogota, ...SCOPE })
require('./equipment')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, uploadImage, removeStoredFile, ...SCOPE })
require('./talento')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, ...SCOPE })
require('./estandares')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, ...SCOPE })
// Calidad IPS · Documentos generales (ítems principales y carpetas hasta 3 niveles).
require('./calidad')(app, { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite })
const plt = platform.register(app, { supabase, auth, h, fail, clean, JWT_SECRET, ISO_DATE, MODULE_KEYS })
legal = require('./legal')(app, { supabase, auth, h, fail, clean, ADMIN, platform: plt, pauth: plt.pauth })
require('./search')(app, { supabase, auth, h, fail, clean, userModules, ...SCOPE })
require('./signatures')(app, { supabase, auth, h, fail, clean, ADMIN, uploadImage, removeStoredFile, canAccessSite })
require('./vehicles')(app, { notify: (...a) => notifier.notify(...a), notifyMsg: () => notifier.messages, supabase, auth, h, fail, clean, ADMIN, STAFF, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, ...SCOPE })

app.listen(PORT, () => console.log(`API escuchando en http://localhost:${PORT}`))
