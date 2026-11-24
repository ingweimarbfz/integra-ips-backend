// =====================================================================
// Directores de área (IIPS-023)
// Cada área tiene un encargado que revisa y firma sus reportes en lugar del administrador:
//   · socorro_operaciones: eventos de socorro, flota (reportes diarios y preoperacionales) e inventario
//   · talento_humano: listas de chequeo y hojas de vida del personal
//   · ips: general o por servicio ofertado (equipos, temperatura, verificaciones de estándares)
//   · educacion: actividades de educación y actas de asistencia (institución ETDH)
// Si un área no tiene director asignado, firma quien firmaba antes (administrador o empleado).
// El administrador siempre puede firmar.
// =====================================================================
const tenant = require('./tenant')

const AREAS = {
  socorro_operaciones: { label: 'Director de Socorro y Operaciones', short: 'Socorro y Operaciones' },
  talento_humano: { label: 'Director de Talento Humano', short: 'Talento Humano' },
  ips: { label: 'Director de IPS', short: 'IPS' },
  educacion: { label: 'Director de Educación', short: 'Educación' }
}

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, ADMIN } = deps
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const fullName = (u) => (u ? `${u.name} ${u.last_name}`.trim() : null)

  // Caché corta por organización: las reglas de firma la consultan en cada firma.
  const cache = new Map()
  const load = async () => {
    const org = tenant.currentOrg() || 0
    const hit = cache.get(org)
    if (hit && Date.now() - hit.at < 30000) return hit.rows
    const { data, error } = await supabase.from('area_directors').select('id, area, service_id, user_id, user:users(id, name, last_name, active), service:ips_services(id, name, module)')
    // Antes de aplicar la migración la tabla no existe: el sistema funciona como antes.
    const rows = error ? [] : data.filter((d) => d.user?.active)
    cache.set(org, { at: Date.now(), rows })
    return rows
  }
  const invalidate = () => cache.delete(tenant.currentOrg() || 0)

  // Director de un área (en IPS, primero el del servicio y luego el general).
  const directorFor = async (area, serviceId = null) => {
    const rows = await load()
    const pick = (sid) => rows.find((r) => r.area === area && (r.service_id || null) === (sid || null))
    const d = (serviceId && pick(serviceId)) || pick(null)
    return d ? { userId: d.user_id, name: fullName(d.user), area, serviceName: d.service?.name || null } : null
  }
  // Áreas que dirige un usuario.
  const areasOf = async (userId) => (await load()).filter((r) => r.user_id === userId)
    .map((r) => ({ area: r.area, serviceId: r.service_id, serviceName: r.service?.name || null, serviceModule: r.service?.module || null, label: r.service_id ? `${AREAS[r.area].label} · ${r.service?.name}` : AREAS[r.area].label }))

  // Regla de firma de una casilla de dirección: el director asignado (o el administrador); sin director, la regla anterior.
  const requireDirector = async (req, area, serviceId, fallback) => {
    if (req.user.role === 'administrador') return
    const d = await directorFor(area, serviceId)
    if (d) { if (d.userId !== req.user.id) throw httpError(403, `Esta casilla la firma ${d.name} (${AREAS[area].label.toLowerCase()}${d.serviceName ? ` · ${d.serviceName}` : ''})`); return }
    if (fallback) await fallback()
  }

  // ---------------------------------------------------------------- Configuración (administrador)
  app.get('/directores', auth(ADMIN), hx(async (req, res) => {
    const [rows, svc, users, edu] = await Promise.all([
      load(),
      supabase.from('ips_services').select('id, name, active').order('name'),
      supabase.from('users').select('id, name, last_name, role, active').eq('active', true).in('role', ['administrador', 'empleado']).order('name'),
      supabase.from('edu_settings').select('director_user_id').maybeSingle()
    ])
    for (const r of [svc, users]) if (r.error) throw r.error
    res.send({
      areas: Object.entries(AREAS).map(([key, a]) => ({ key, ...a })),
      services: svc.data.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
      users: users.data.map((u) => ({ id: u.id, fullName: fullName(u), role: u.role })),
      assignments: [...rows.map((r) => ({ area: r.area, serviceId: r.service_id, userId: r.user_id, userName: fullName(r.user) })),
        // El director de educación configurado antes en Educación → Configuración.
        ...(!rows.some((r) => r.area === 'educacion') && edu.data?.director_user_id ? [{ area: 'educacion', serviceId: null, userId: edu.data.director_user_id, userName: null }] : [])]
    })
  }))
  app.put('/directores', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    if (!AREAS[b.area]) return fail(res, 'Área inválida', 400)
    const serviceId = b.area === 'ips' ? (Number(b.serviceId) || null) : null
    const userId = Number(b.userId) || null
    let q = supabase.from('area_directors').delete().eq('area', b.area)
    q = serviceId ? q.eq('service_id', serviceId) : q.is('service_id', null)
    const { error: e1 } = await q
    if (e1) throw e1
    if (userId) {
      const { data: u } = await supabase.from('users').select('id, role, active').eq('id', userId).maybeSingle()
      if (!u || !u.active || !['administrador', 'empleado'].includes(u.role)) return fail(res, 'Elige un usuario activo (administrador o empleado)', 400)
      const { error } = await supabase.from('area_directors').insert({ area: b.area, service_id: serviceId, user_id: userId })
      if (error) throw error
    }
    // Educación: el director también firma las actas de asistencia (Educación → Configuración).
    if (b.area === 'educacion') await supabase.from('edu_settings').update({ director_user_id: userId }).not('org_id', 'is', null)
    invalidate()
    res.send({ ok: true })
  }))
  // Áreas que dirige el usuario actual (menú de usuario y bandeja de firmas).
  app.get('/mi-direccion', auth(), hx(async (req, res) => res.send({ areas: await areasOf(req.user.id) })))

  return { AREAS, directorFor, areasOf, requireDirector, invalidate }
}
