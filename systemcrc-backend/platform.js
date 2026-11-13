// =====================================================================
// Plataforma comercial: funcionalidades, planes (mensual / anual), organizaciones
// clientes y el plan que tiene esta instalación. El plan activo limita los módulos
// que el sistema muestra y permite usar (también para el administrador).
// =====================================================================
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

const tenant = require('./tenant')

// Estado del plan de cada organización (en caché un minuto; se recarga cuando cambia algo en la plataforma).
const EMPTY = { modules: null, features: null, plan: null, organization: null, loadedAt: 0 }
const states = new Map()
const stateOf = (orgId) => (orgId && states.get(Number(orgId))) || EMPTY
// Plan de la organización de la petición actual.
const state = new Proxy({}, { get: (_, k) => stateOf(tenant.currentOrg())[k] })
let loader = null
const ensure = async (orgId) => {
  const s = states.get(Number(orgId))
  if (s && Date.now() - s.loadedAt < 60000) return s
  return loader ? loader(Number(orgId)) : EMPTY
}

const register = (app, deps) => {
  const { supabase, h, fail, clean, JWT_SECRET, ISO_DATE, MODULE_KEYS } = deps
  const GROUPS = { ips: 'Servicios de IPS', estandares: 'Estándares transversales', operaciones: 'Operaciones', voluntariado: 'Socorro y voluntariado', general: 'Generales' }
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const annual = (p) => Math.round((Number(p.price_month) * 12 * (1 - Number(p.annual_discount) / 100)) / 100) * 100

  // ---------------------------------------------------------------- Plan de esta instalación
  const load = async (orgId) => {
    const { data: org } = await supabase.from('plt_organizations').select('*, plan:plt_plans(*)').eq('id', orgId).maybeSingle()
    const { data: feats } = await supabase.from('plt_features').select('key, module_key')
    // Organización inexistente: sin módulos. Sin plan asignado: sin restricción (como antes).
    if (!org) { const st = { ...EMPTY, modules: [], features: [], loadedAt: Date.now() }; states.set(orgId, st); return st }
    if (!org.plan) { const st = { ...EMPTY, organization: { id: org.id, name: org.name, status: org.status }, loadedAt: Date.now() }; states.set(orgId, st); return st }
    const keys = new Set([...(org.plan.features || []), ...(org.extra_features || [])])
    const suspended = ['suspendida', 'cancelada'].includes(org.status)
    const modules = suspended ? [] : (feats || []).filter((f) => f.module_key && keys.has(f.key)).map((f) => f.module_key)
    const st = {
      modules: [...new Set(modules)], features: suspended ? [] : [...keys], loadedAt: Date.now(),
      plan: { id: org.plan.id, code: org.plan.code, name: org.plan.name, audience: org.plan.audience },
      organization: { id: org.id, name: org.name, status: org.status, billingCycle: org.billing_cycle, renewalDate: org.renewal_date }
    }
    states.set(orgId, st)
    return st
  }
  loader = load
  // Tras un cambio en la plataforma se recargan todas las organizaciones en caché.
  const refresh = async () => { await Promise.all([...states.keys()].map((id) => load(id).catch(() => {}))) }

  // ---------------------------------------------------------------- Acceso a la plataforma (superadministrador)
  const signPlatform = (u) => jwt.sign({ sub: String(u.id), plt: true }, JWT_SECRET, { expiresIn: '8h' })
  const pauth = async (req, res, next) => {
    try {
      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : null
      if (!token) return fail(res, 'Debes iniciar sesión en la plataforma', 401)
      let payload
      try { payload = jwt.verify(token, JWT_SECRET) } catch { return fail(res, 'Tu sesión expiró. Inicia sesión de nuevo.', 401) }
      if (!payload.plt) return fail(res, 'Sesión no válida para la plataforma', 401)
      const { data: u } = await supabase.from('users').select('id, name, last_name, username, email, avatar_url, active, platform_admin').eq('id', Number(payload.sub)).maybeSingle()
      if (!u || !u.active || !u.platform_admin) return fail(res, 'Sin acceso a la plataforma', 403)
      req.puser = u
      next()
    } catch (e) { fail(res, e) }
  }
  const puserDTO = (u) => ({ id: u.id, name: `${u.name} ${u.last_name}`.trim(), username: u.username, email: u.email, avatarUrl: u.avatar_url })
  app.post('/plataforma/login', hx(async (req, res) => {
    const { userName, password } = req.body || {}
    if (!clean(userName) || !password) return fail(res, 'Usuario y contraseña requeridos', 400)
    const { data: u } = await supabase.from('users').select('id, name, last_name, username, email, avatar_url, active, platform_admin, password_hash').eq('username', clean(userName)).maybeSingle()
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return fail(res, 'Usuario o contraseña incorrectos.', 401)
    if (!u.active || !u.platform_admin) return fail(res, 'Este usuario no tiene acceso a la plataforma.', 403)
    res.send({ token: signPlatform(u), user: puserDTO(u) })
  }))
  app.get('/plataforma/me', pauth, (req, res) => res.send(puserDTO(req.puser)))

  // ---------------------------------------------------------------- Funcionalidades
  const featDTO = (f) => ({ key: f.key, label: f.label, group: f.grp, groupLabel: GROUPS[f.grp], moduleKey: f.module_key, description: f.description, sortOrder: f.sort_order })
  const loadFeatures = async () => {
    const { data, error } = await supabase.from('plt_features').select('*').order('sort_order').order('label')
    if (error) throw error
    return data
  }
  app.get('/plataforma/funcionalidades', pauth, hx(async (req, res) => res.send({ groups: GROUPS, moduleKeys: MODULE_KEYS, features: (await loadFeatures()).map(featDTO) })))
  const featRow = (b) => {
    if (!clean(b.label)) throw httpError(400, 'El nombre es requerido')
    if (!GROUPS[b.group]) throw httpError(400, 'Grupo inválido')
    if (b.moduleKey && !MODULE_KEYS.includes(b.moduleKey)) throw httpError(400, 'Módulo del sistema inválido')
    return { label: clean(b.label), grp: b.group, module_key: b.moduleKey || null, description: clean(b.description), sort_order: Number(b.sortOrder) || 0 }
  }
  app.post('/plataforma/funcionalidades', pauth, hx(async (req, res) => {
    const key = clean(req.body?.key)?.toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (!key) return fail(res, 'La clave es requerida', 400)
    const { error } = await supabase.from('plt_features').insert({ key, ...featRow(req.body) })
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe esa clave', 409); throw error }
    res.status(201).send({ key })
  }))
  app.put('/plataforma/funcionalidades/:key', pauth, hx(async (req, res) => {
    const { error } = await supabase.from('plt_features').update(featRow(req.body || {})).eq('key', req.params.key)
    if (error) throw error
    await refresh(); res.send({ ok: true })
  }))
  app.delete('/plataforma/funcionalidades/:key', pauth, hx(async (req, res) => {
    const { data: plans } = await supabase.from('plt_plans').select('name').contains('features', [req.params.key])
    if (plans?.length) return fail(res, `La usan los planes: ${plans.map((p) => p.name).join(', ')}. Quítala de los planes primero.`, 409)
    const { error } = await supabase.from('plt_features').delete().eq('key', req.params.key)
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Planes
  const planDTO = (p, feats = []) => ({
    id: p.id, code: p.code, name: p.name, tagline: p.tagline, audience: p.audience, priceMonth: Number(p.price_month), annualDiscount: Number(p.annual_discount),
    priceYear: annual(p), priceYearMonthly: Math.round(annual(p) / 12 / 100) * 100,
    maxSites: p.max_sites, maxUsers: p.max_users, storageGb: p.storage_gb, support: p.support, highlight: p.highlight, badge: p.badge,
    bullets: p.bullets || [], features: p.features || [], featureLabels: (p.features || []).map((k) => feats.find((f) => f.key === k)).filter(Boolean).map(featDTO),
    sortOrder: p.sort_order, active: p.active, updatedAt: p.updated_at
  })
  const loadPlans = async (onlyActive = false) => {
    let q = supabase.from('plt_plans').select('*').order('sort_order').order('price_month')
    if (onlyActive) q = q.eq('active', true)
    const [{ data, error }, feats] = await Promise.all([q, loadFeatures()])
    if (error) throw error
    return data.map((p) => planDTO(p, feats))
  }
  app.get('/plataforma/planes', pauth, hx(async (req, res) => res.send(await loadPlans())))
  const planRow = async (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre es requerido')
    if (!(Number(b.priceMonth) >= 0)) e.push('Precio mensual inválido')
    const disc = Number(b.annualDiscount ?? 16.7)
    if (Number.isNaN(disc) || disc < 0 || disc > 90) e.push('Descuento anual inválido (0 a 90 %)')
    if (!['ips', 'esal'].includes(b.audience)) e.push('Tipo de cliente inválido')
    if (e.length) throw httpError(400, e.join('. '))
    const valid = new Set((await loadFeatures()).map((f) => f.key))
    const intOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))) || null)
    return {
      name: clean(b.name), tagline: clean(b.tagline), audience: b.audience, price_month: Math.round(Number(b.priceMonth)), annual_discount: disc,
      max_sites: intOrNull(b.maxSites), max_users: intOrNull(b.maxUsers), storage_gb: intOrNull(b.storageGb), support: clean(b.support),
      highlight: Boolean(b.highlight), badge: clean(b.badge), bullets: (b.bullets || []).map((x) => clean(x)).filter(Boolean).slice(0, 8),
      features: [...new Set((b.features || []).filter((k) => valid.has(k)))], sort_order: Number(b.sortOrder) || 0, active: b.active !== false, updated_at: new Date().toISOString()
    }
  }
  app.post('/plataforma/planes', pauth, hx(async (req, res) => {
    const code = clean(req.body?.code)?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    if (!code) return fail(res, 'El código es requerido', 400)
    const row = await planRow(req.body || {})
    if (row.highlight) await supabase.from('plt_plans').update({ highlight: false }).eq('audience', row.audience)
    const { data, error } = await supabase.from('plt_plans').insert({ ...row, code }).select('id').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un plan con ese código', 409); throw error }
    res.status(201).send({ id: data.id })
  }))
  app.put('/plataforma/planes/:id', pauth, hx(async (req, res) => {
    const row = await planRow(req.body || {})
    if (row.highlight) await supabase.from('plt_plans').update({ highlight: false }).eq('audience', row.audience).neq('id', Number(req.params.id))
    const { error } = await supabase.from('plt_plans').update(row).eq('id', Number(req.params.id))
    if (error) throw error
    await refresh(); res.send({ ok: true })
  }))
  app.delete('/plataforma/planes/:id', pauth, hx(async (req, res) => {
    const { count } = await supabase.from('plt_organizations').select('id', { count: 'exact', head: true }).eq('plan_id', Number(req.params.id))
    if (count) return fail(res, 'Hay organizaciones con este plan. Desactívalo en lugar de eliminarlo.', 409)
    const { error } = await supabase.from('plt_plans').delete().eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Organizaciones (clientes)
  const orgDTO = (o) => ({
    id: o.id, name: o.name, nit: o.nit, orgType: o.org_type, city: o.city, contactName: o.contact_name, contactEmail: o.contact_email, contactPhone: o.contact_phone,
    planId: o.plan_id, planName: o.plan?.name ?? null, planCode: o.plan?.code ?? null, billingCycle: o.billing_cycle, status: o.status,
    startDate: o.start_date, renewalDate: o.renewal_date, extraFeatures: o.extra_features || [], isCurrent: o.is_current, notes: o.notes,
    amount: o.plan ? (o.billing_cycle === 'anual' ? annual(o.plan) : Number(o.plan.price_month)) : 0,
    mrr: o.plan && o.status === 'activa' ? (o.billing_cycle === 'anual' ? Math.round(annual(o.plan) / 12) : Number(o.plan.price_month)) : 0
  })
  const loadOrgs = async () => {
    const [{ data, error }, { data: ready }, { data: people }] = await Promise.all([
      supabase.from('plt_organizations').select('*, plan:plt_plans(*)').order('is_current', { ascending: false }).order('name'),
      supabase.from('app_settings').select('org_id'),
      supabase.from('users').select('org_id')
    ])
    if (error) throw error
    const users = (people || []).reduce((a, u) => { a[u.org_id] = (a[u.org_id] || 0) + 1; return a }, {})
    return data.map((o) => ({ ...orgDTO(o), initialized: (ready || []).some((r) => r.org_id === o.id), users: users[o.id] || 0 }))
  }
  app.get('/plataforma/organizaciones', pauth, hx(async (req, res) => res.send(await loadOrgs())))
  const orgRow = async (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre es requerido')
    if (!['ips', 'esal'].includes(b.orgType)) e.push('Tipo de organización inválido')
    if (!['mensual', 'anual'].includes(b.billingCycle)) e.push('Ciclo de pago inválido')
    if (!['prueba', 'activa', 'suspendida', 'cancelada'].includes(b.status)) e.push('Estado inválido')
    for (const d of [b.startDate, b.renewalDate]) if (clean(d) && !ISO_DATE.test(d)) e.push('Fecha inválida')
    if (clean(b.contactEmail) && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(clean(b.contactEmail))) e.push('Correo inválido')
    if (Number(b.planId)) {
      const { data: p } = await supabase.from('plt_plans').select('audience, name').eq('id', Number(b.planId)).maybeSingle()
      if (!p) e.push('Plan inválido')
      else if (p.audience === 'esal' && b.orgType !== 'esal') e.push(`El plan ${p.name} solo se ofrece a entidades sin ánimo de lucro`)
    }
    if (e.length) throw httpError(400, e.join('. '))
    const valid = new Set((await loadFeatures()).map((f) => f.key))
    return {
      name: clean(b.name), nit: clean(b.nit), org_type: b.orgType, city: clean(b.city), contact_name: clean(b.contactName), contact_email: clean(b.contactEmail)?.toLowerCase() ?? null,
      contact_phone: clean(b.contactPhone), plan_id: Number(b.planId) || null, billing_cycle: b.billingCycle, status: b.status, start_date: clean(b.startDate), renewal_date: clean(b.renewalDate),
      extra_features: (b.extraFeatures || []).filter((k) => valid.has(k)), notes: clean(b.notes), updated_at: new Date().toISOString()
    }
  }
  const setCurrent = async (id, on) => {
    if (!on) return
    await supabase.from('plt_organizations').update({ is_current: false }).eq('is_current', true).neq('id', id)
    await supabase.from('plt_organizations').update({ is_current: true }).eq('id', id)
  }
  app.post('/plataforma/organizaciones', pauth, hx(async (req, res) => {
    const { data, error } = await supabase.from('plt_organizations').insert(await orgRow(req.body || {})).select('id').single()
    if (error) throw error
    await setCurrent(data.id, Boolean(req.body?.isCurrent)); await refresh()
    res.status(201).send({ id: data.id })
  }))
  app.put('/plataforma/organizaciones/:id', pauth, hx(async (req, res) => {
    const id = Number(req.params.id)
    const row = await orgRow(req.body || {})
    const { data: cur } = await supabase.from('plt_organizations').select('is_current').eq('id', id).maybeSingle()
    if (!cur) return fail(res, 'Organización no encontrada', 404)
    if (cur.is_current && req.body?.isCurrent === false) row.is_current = false
    const { error } = await supabase.from('plt_organizations').update(row).eq('id', id)
    if (error) throw error
    await setCurrent(id, Boolean(req.body?.isCurrent)); await refresh()
    res.send({ ok: true })
  }))
  // Alta de un cliente: configuración y catálogos iniciales, su primera sede (con bodega general) y su administrador.
  app.post('/plataforma/organizaciones/:id/inicializar', pauth, hx(async (req, res) => {
    const id = Number(req.params.id)
    const { data: org } = await supabase.from('plt_organizations').select('id, name').eq('id', id).maybeSingle()
    if (!org) return fail(res, 'Organización no encontrada', 404)
    const { data: done } = await supabase.from('app_settings').select('org_id').eq('org_id', id).maybeSingle()
    if (done) return fail(res, 'Esta organización ya fue inicializada', 409)
    const b = req.body || {}
    const e = []
    for (const [k, l] of [['siteName', 'Nombre de la sede'], ['municipality', 'Municipio'], ['adminName', 'Nombre del administrador'], ['adminLastName', 'Apellidos'], ['adminIdentification', 'Identificación'], ['adminUsername', 'Usuario']]) if (!clean(b[k])) e.push(`${l} es requerido`)
    if (!b.adminPassword || String(b.adminPassword).length < 8) e.push('La contraseña debe tener al menos 8 caracteres')
    if (clean(b.adminEmail) && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(clean(b.adminEmail))) e.push('Correo inválido')
    if (e.length) return fail(res, e.join('. '), 400)
    const { data: taken } = await supabase.from('users').select('id').eq('username', clean(b.adminUsername)).maybeSingle()
    if (taken) return fail(res, 'Ese nombre de usuario ya existe en la plataforma; elige otro', 409)
    const { error: se } = await supabase.rpc('seed_org', { p_org: id, p_name: org.name })
    if (se) throw se
    await tenant.runAsOrg(id, async () => {
      const { data: site, error: e1 } = await supabase.from('sites').insert({ type: 'seccional', name: clean(b.siteName), municipality: clean(b.municipality), has_ips: true }).select('id').single()
      if (e1) throw e1
      const { error: e2 } = await supabase.from('warehouses').insert({ site_id: site.id, name: `Bodega general ${clean(b.siteName)}`.slice(0, 120), code: 'BG-01', is_general: true })
      if (e2) throw e2
      const { error: e3 } = await supabase.from('users').insert({
        identification: clean(b.adminIdentification), name: clean(b.adminName), last_name: clean(b.adminLastName), username: clean(b.adminUsername),
        email: clean(b.adminEmail)?.toLowerCase() ?? null, password_hash: await bcrypt.hash(String(b.adminPassword), 10), role: 'administrador', site_id: site.id
      })
      if (e3) throw e3
    })
    await refresh()
    res.status(201).send({ ok: true })
  }))
  app.delete('/plataforma/organizaciones/:id', pauth, hx(async (req, res) => {
    const { data: cur } = await supabase.from('plt_organizations').select('is_current').eq('id', Number(req.params.id)).maybeSingle()
    if (cur?.is_current) return fail(res, 'Es la organización de esta instalación. Marca otra como actual antes de eliminarla.', 409)
    const { error } = await supabase.from('plt_organizations').delete().eq('id', Number(req.params.id))
    if (error) { if (error.code === '23503') return fail(res, 'La organización ya tiene datos (usuarios, sedes o registros). Cámbiala a estado cancelada en lugar de eliminarla.', 409); throw error }
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Resumen
  app.get('/plataforma/resumen', pauth, hx(async (req, res) => {
    const [orgs, plans] = await Promise.all([loadOrgs(), loadPlans()])
    const active = orgs.filter((o) => o.status === 'activa')
    const today = new Date().toISOString().slice(0, 10)
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    res.send({
      kpis: {
        organizations: orgs.length, active: active.length, trial: orgs.filter((o) => o.status === 'prueba').length, suspended: orgs.filter((o) => ['suspendida', 'cancelada'].includes(o.status)).length,
        mrr: active.reduce((a, o) => a + o.mrr, 0), arr: active.reduce((a, o) => a + o.mrr, 0) * 12, plans: plans.filter((p) => p.active).length,
        renewals: orgs.filter((o) => o.renewalDate && o.renewalDate >= today && o.renewalDate <= in30).length
      },
      byPlan: plans.map((p) => ({ id: p.id, name: p.name, audience: p.audience, organizations: orgs.filter((o) => o.planId === p.id).length, mrr: orgs.filter((o) => o.planId === p.id).reduce((a, o) => a + o.mrr, 0) })),
      byCycle: ['mensual', 'anual'].map((c) => ({ name: c === 'mensual' ? 'Mensual' : 'Anual', value: active.filter((o) => o.billingCycle === c).length })),
      renewals: orgs.filter((o) => o.renewalDate && o.renewalDate <= in30 && o.status !== 'cancelada').sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)).slice(0, 10),
      current: null
    })
  }))

  // ---------------------------------------------------------------- Público: página de precios
  app.get('/plataforma/precios', hx(async (req, res) => res.send({ groups: GROUPS, plans: await loadPlans(true) })))

  // Plan de esta instalación (para el sistema).
  app.get('/plan/actual', deps.auth(), hx(async (req, res) => res.send({ plan: state.plan, organization: state.organization, modules: state.modules, features: state.features })))


  // ---------------------------------------------------------------- Solicitudes de mejora de plan
  const REQ_STATUS = ['pendiente', 'contactado', 'aplicada', 'rechazada']
  const reqDTO = (r) => ({
    id: r.id, organizationId: r.organization_id, organizationName: r.org?.name ?? null, fromPlan: r.from?.name ?? null, toPlanId: r.to_plan_id, toPlan: r.to?.name ?? null,
    billingCycle: r.billing_cycle, message: r.message, contactPhone: r.contact_phone, requestedBy: r.user ? `${r.user.name} ${r.user.last_name}` : null, requestedEmail: r.user?.email ?? null,
    status: r.status, response: r.response, createdAt: r.created_at, updatedAt: r.updated_at
  })
  const REQ_SELECT = '*, org:plt_organizations(name), from:plt_plans!plt_upgrade_requests_from_plan_id_fkey(name), to:plt_plans!plt_upgrade_requests_to_plan_id_fkey(name), user:users(name, last_name, email)'
  // Opciones para el usuario del sistema: plan actual, planes disponibles y su última solicitud.
  app.get('/plan/opciones', deps.auth(), hx(async (req, res) => {
    const { data: org } = await supabase.from('plt_organizations').select('*, plan:plt_plans(*)').eq('id', tenant.currentOrg()).maybeSingle()
    const plans = (await loadPlans(true)).filter((p) => !org || org.org_type === 'esal' || p.audience === 'ips')
    const { data: last } = org ? await supabase.from('plt_upgrade_requests').select(REQ_SELECT).eq('organization_id', org.id).order('created_at', { ascending: false }).limit(1).maybeSingle() : { data: null }
    res.send({
      organization: org ? { name: org.name, orgType: org.org_type, billingCycle: org.billing_cycle, renewalDate: org.renewal_date, status: org.status } : null,
      current: org?.plan ? plans.find((p) => p.id === org.plan_id) || planDTO(org.plan) : null, plans, lastRequest: last ? reqDTO(last) : null, canRequest: req.user.role === 'administrador'
    })
  }))
  app.post('/plan/solicitud', deps.auth(['administrador']), hx(async (req, res) => {
    const { data: org } = await supabase.from('plt_organizations').select('id, plan_id, org_type').eq('id', tenant.currentOrg()).maybeSingle()
    if (!org) return fail(res, 'Esta instalación no tiene una organización asociada', 400)
    const b = req.body || {}
    const { data: plan } = await supabase.from('plt_plans').select('id, audience, active').eq('id', Number(b.planId)).maybeSingle()
    if (!plan || !plan.active) return fail(res, 'Plan inválido', 400)
    if (plan.audience === 'esal' && org.org_type !== 'esal') return fail(res, 'Ese plan es solo para entidades sin ánimo de lucro', 400)
    const { data: open } = await supabase.from('plt_upgrade_requests').select('id').eq('organization_id', org.id).in('status', ['pendiente', 'contactado']).maybeSingle()
    if (open) return fail(res, 'Ya tienes una solicitud en curso. Te contactaremos pronto.', 409)
    const { error } = await supabase.from('plt_upgrade_requests').insert({
      organization_id: org.id, from_plan_id: org.plan_id, to_plan_id: plan.id, billing_cycle: b.billingCycle === 'anual' ? 'anual' : 'mensual',
      message: clean(b.message)?.slice(0, 1000) ?? null, contact_phone: clean(b.contactPhone), requested_by: req.user.id
    })
    if (error) throw error
    res.status(201).send({ ok: true })
  }))
  app.get('/plataforma/solicitudes', pauth, hx(async (req, res) => {
    const { data, error } = await supabase.from('plt_upgrade_requests').select(REQ_SELECT).order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    res.send(data.map(reqDTO))
  }))
  app.put('/plataforma/solicitudes/:id', pauth, hx(async (req, res) => {
    const b = req.body || {}
    if (!REQ_STATUS.includes(b.status)) return fail(res, 'Estado inválido', 400)
    const { data: r } = await supabase.from('plt_upgrade_requests').select('*').eq('id', Number(req.params.id)).maybeSingle()
    if (!r) return fail(res, 'Solicitud no encontrada', 404)
    // Aplicar: cambia el plan y el ciclo de la organización.
    if (b.status === 'aplicada' && r.to_plan_id) {
      const { error: e2 } = await supabase.from('plt_organizations').update({ plan_id: r.to_plan_id, billing_cycle: r.billing_cycle, updated_at: new Date().toISOString() }).eq('id', r.organization_id)
      if (e2) throw e2
      await refresh()
    }
    const { error } = await supabase.from('plt_upgrade_requests').update({ status: b.status, response: clean(b.response), updated_at: new Date().toISOString() }).eq('id', r.id)
    if (error) throw error
    res.send({ ok: true })
  }))
  return { refresh, pauth }
}

module.exports = { state, stateOf, ensure, register }
