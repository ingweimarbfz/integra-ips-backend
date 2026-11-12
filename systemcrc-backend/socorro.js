// =====================================================================
// Módulo Gestión de Socorro y Operaciones
// Personas (voluntarios), inventario con stock, eventos con personal,
// materiales (salen y regresan) e insumos (se consumen y descuentan stock).
// =====================================================================
const { pageQuery, setTotal } = require('./paging')
module.exports = (app, deps) => {
  const { userModules } = deps
  const { supabase, auth, h, fail, clean, ADMIN, STAFF, NO_DRIVER, EMAIL_RE, PHONE_RE, ISO_DATE, TZ, TZ_OFFSET, todayBogota, scopeSite, applyScope, canAccessSite, targetSite } = deps
  // Eventos: el voluntario también registra y coordina actividades de su municipio.
  const EVENTS = ['administrador', 'empleado', 'voluntario']
  const MIN_HOURS = 12 // horas mínimas al mes para el voluntario de base

  const BLOOD = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']
  // Medicamentos, dispositivos médicos y reactivos se consumen; los equipos (operacional / no operacional) salen y regresan.
  const CONSUMABLE = ['medicamento', 'dispositivo_medico', 'reactivo']
  const isConsumable = (i) => CONSUMABLE.includes(i.category)
  const AREAS = ['socorro', 'educacion']
  const ROLE_NAMES = { administrador: 'Administrador', empleado: 'Empleado', conductor: 'Conductor', voluntario: 'Voluntario' }
  // El seguro del voluntario debe estar vigente para participar en actividades.
  const insuranceProblem = (v) => (v.insurance_expiry && v.insurance_expiry < todayBogota()
    ? `El seguro de ${v.first_name} ${v.last_name} venció el ${v.insurance_expiry.split('-').reverse().join('/')}. Debe actualizarlo en Personas antes de registrarse en una actividad o servicio.` : null)
  // Horas de voluntariado: no cuentan para el personal remunerado (usuario con la misma identificación marcado como remunerado).
  const isPaid = async (document) => {
    if (!document) return false
    const { data } = await supabase.from('users').select('remunerado').eq('identification', document).eq('active', true).maybeSingle()
    return Boolean(data?.remunerado)
  }
  // Áreas (Socorro / Educación) que el usuario tiene habilitadas.
  const areasOf = (user) => AREAS.filter((a) => userModules(user).includes(a))
  const STATES = ['bueno', 'regular', 'malo', 'perdido']
  const AGRUPACIONES = ['Socorrismo', 'Damas Grises', 'Juventud']
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v))

  // ---------------------------------------------------------------- DTOs
  const volunteerDTO = (v) => v && ({
    id: v.id, document: v.document, carnet: v.carnet, firstName: v.first_name, lastName: v.last_name,
    fullName: `${v.first_name} ${v.last_name}`, bloodType: v.blood_type, agrupacion: v.agrupacion,
    phone: v.phone, email: v.email, active: v.active, siteId: v.site_id, siteName: v.site?.name ?? null,
    volunteerType: v.volunteer_type, joinedAt: v.joined_at, insuranceEntity: v.insurance_entity, insurancePolicy: v.insurance_policy,
    insuranceExpiry: v.insurance_expiry, inactiveReason: v.inactive_reason,
    autoCreated: Boolean(v.auto_created), missingData: missingData(v)
  })
  // Datos de voluntario que faltan (p. ej. en registros creados automáticamente desde un conductor).
  function missingData (v) {
    return [[!v.carnet, 'carnet'], [!v.agrupacion, 'agrupación'], [!v.blood_type, 'grupo sanguíneo'], [!v.phone, 'celular'], [!v.insurance_entity || !v.insurance_expiry, 'seguro (entidad y vencimiento)']]
      .filter(([miss]) => miss).map(([, l]) => l)
  }
  const itemDTO = (i) => i && ({
    id: i.id, code: i.code, name: i.name, category: i.category, unit: i.unit,
    stock: Number(i.stock), minStock: Number(i.min_stock), location: i.location, notes: i.notes, active: i.active,
    productId: i.product_id, lot: i.lot, expiryDate: i.expiry_date, consumable: isConsumable(i), warehouseId: i.warehouse_id, warehouseName: i.warehouse?.name ?? null,
    low: i.active && Number(i.stock) <= Number(i.min_stock)
  })

  // Llama a la función SQL que mueve stock de forma atómica.
  const moveStock = async (itemId, delta, type, eventId, userId, note) => {
    const { data, error } = await supabase.rpc('gso_move_stock', {
      p_item: itemId, p_delta: delta, p_type: type, p_event: eventId, p_user: userId, p_note: note || null
    })
    if (error) {
      if (/STOCK_INSUFICIENTE|stock_check|23514/.test(error.message + error.code)) {
        const e = new Error('Stock insuficiente para este elemento'); e.status = 400; throw e
      }
      throw error
    }
    return Number(data)
  }

  // Errores con status (400/403/404) se responden como mensaje, el resto como 500.
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) {
      if (e.status) return fail(res, e.message, e.status)
      throw e
    }
  })
  const httpError = (status, message) => Object.assign(new Error(message), { status })

  // Evento en curso en el que ya participa una persona (coordinador o voluntario), si existe.
  const activeEventOf = async (volunteerId, exceptEventId) => {
    let q = supabase.from('gso_event_personnel').select('gso_events!inner(id, code, name, status)')
      .eq('volunteer_id', volunteerId).eq('gso_events.status', 'en_curso')
    if (exceptEventId) q = q.neq('event_id', exceptEventId)
    const { data, error } = await q.limit(1)
    if (error) throw error
    const e = data[0]?.gso_events
    return e ? { id: e.id, code: e.code, name: e.name } : null
  }
  const busyMessage = (v, e) => `${v.first_name} ${v.last_name} ya está en el evento en curso ${e.code} · ${e.name}. Debe finalizar o retirarse de ese evento primero.`
  const isBusyError = (error) => /VOLUNTARIO_OCUPADO/.test(error?.message || '')

  // ================================================================ Personas
  const validateVolunteer = (b) => {
    const errors = []
    if (!clean(b.document)) errors.push('El documento es requerido')
    if (b.volunteerType && !['base', 'apoyo'].includes(b.volunteerType)) errors.push('Tipo de voluntario inválido')
    if (!AGRUPACIONES.includes(b.agrupacion)) errors.push('La agrupación debe ser Socorrismo, Damas Grises o Juventud')
    for (const k of ['joinedAt', 'insuranceExpiry']) if (clean(b[k]) && !ISO_DATE.test(b[k])) errors.push('Fecha inválida')
    if (!clean(b.firstName) || !clean(b.lastName)) errors.push('Nombres y apellidos son requeridos')
    if (b.bloodType && !BLOOD.includes(b.bloodType)) errors.push('Grupo sanguíneo inválido')
    if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) errors.push('El celular debe tener 10 dígitos')
    if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
    return errors
  }
  const volunteerRow = (b) => ({
    document: clean(b.document), carnet: clean(b.carnet)?.toUpperCase() ?? null,
    first_name: clean(b.firstName), last_name: clean(b.lastName), blood_type: b.bloodType || null,
    agrupacion: clean(b.agrupacion), phone: clean(b.phone), email: clean(b.email)?.toLowerCase() ?? null,
    active: b.active !== false, volunteer_type: b.volunteerType || 'base', joined_at: clean(b.joinedAt) || todayBogota(),
    insurance_entity: clean(b.insuranceEntity), insurance_policy: clean(b.insurancePolicy), insurance_expiry: clean(b.insuranceExpiry),
    updated_at: new Date().toISOString()
  })

  // ---------------------------------------------------------------- Horas de voluntariado
  // Horas = duración de los eventos finalizados en los que participó (personal o coordinador).
  const monthKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)).slice(0, 7)
  const hoursByVolunteer = async (ids, fromMonth) => {
    if (!ids.length) return {}
    const { data, error } = await supabase.from('gso_event_personnel')
      .select('volunteer_id, gso_events!inner(id, code, name, status, started_at, ended_at)')
      .in('volunteer_id', ids).eq('counts_hours', true).eq('gso_events.status', 'finalizado').gte('gso_events.started_at', `${fromMonth}-01T00:00:00${TZ_OFFSET}`)
    if (error) throw error
    const out = {}
    for (const r of data) {
      const e = r.gso_events
      const h = Math.max(0, (new Date(e.ended_at) - new Date(e.started_at)) / 3600000)
      const k = monthKey(e.started_at)
      out[r.volunteer_id] = out[r.volunteer_id] || {}
      out[r.volunteer_id][k] = (out[r.volunteer_id][k] || 0) + h
    }
    return out
  }
  const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7) }
  // Últimos 3 meses calendario completos (sin contar el mes en curso).
  const lastThreeMonths = () => { const cur = todayBogota().slice(0, 7); return [shiftMonth(cur, -3), shiftMonth(cur, -2), shiftMonth(cur, -1)] }

  // Regla: voluntario de base con 3 meses completos seguidos por debajo de 12 h queda inactivo.
  // Solo cuentan los meses posteriores a su ingreso o a su última reactivación.
  const evaluateVolunteers = async () => {
    const { data: all, error } = await supabase.from('volunteers').select('id, document, joined_at, reactivated_at').eq('active', true).eq('volunteer_type', 'base')
    if (error) throw error
    // El personal remunerado no acumula horas de voluntariado: no se evalúa por horas.
    const { data: paid } = await supabase.from('users').select('identification').eq('remunerado', true)
    const paidDocs = new Set((paid || []).map((u) => u.identification))
    const vols = all.filter((v) => !paidDocs.has(v.document))
    const months = lastThreeMonths()
    const hours = await hoursByVolunteer(vols.map((v) => v.id), months[0])
    const toDeactivate = []
    for (const v of vols) {
      const since = [v.joined_at, v.reactivated_at].filter(Boolean).sort().pop()
      if (since && since.slice(0, 7) >= months[0]) continue // aún no tiene 3 meses completos evaluables
      if (months.every((m) => (hours[v.id]?.[m] || 0) < MIN_HOURS)) toDeactivate.push(v.id)
    }
    if (toDeactivate.length) {
      await supabase.from('volunteers').update({
        active: false, updated_at: new Date().toISOString(),
        inactive_reason: `No cumplió ${MIN_HOURS} h mínimas en ${months.join(', ')}`
      }).in('id', toDeactivate)
      console.log(`Voluntarios inactivados por horas: ${toDeactivate.length}`)
    }
    return toDeactivate.length
  }
  // Se revisa al iniciar el servidor y cada 6 horas.
  setTimeout(() => evaluateVolunteers().catch((e) => console.error('evaluateVolunteers', e.message)), 3000)
  setInterval(() => evaluateVolunteers().catch((e) => console.error('evaluateVolunteers', e.message)), 6 * 3600 * 1000)

  app.get('/socorro/personas', auth(STAFF), hx(async (req, res) => {
    const { data, error } = await applyScope(supabase.from('volunteers').select('*, site:sites(name)'), scopeSite(req)).order('first_name')
    if (error) throw error
    const cur = todayBogota().slice(0, 7)
    const hours = await hoursByVolunteer(data.map((v) => v.id), cur)
    res.send(data.map((v) => ({ ...volunteerDTO(v), monthHours: Math.round((hours[v.id]?.[cur] || 0) * 10) / 10 })))
  }))

  // Búsqueda exacta por número de carnet o documento (para coordinador y personal).
  app.get('/socorro/personas/buscar', auth(EVENTS), hx(async (req, res) => {
    const v = clean(req.query.valor)
    if (!v) return fail(res, 'Ingresa un carnet o documento', 400)
    const safe = v.replace(/[,()]/g, '')
    const { data, error } = await supabase.from('volunteers').select('*, site:sites(name)')
      .or(`document.eq.${safe},carnet.eq.${safe.toUpperCase()}`).limit(1).maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 'No hay una persona registrada con ese carnet o documento', 404)
    // Puede ser visitante: un voluntario de otra sede también puede asistir a actividades.
    const site = Number(req.query.sede) || req.user.site_id || null
    if (!data.active) return fail(res, `La persona está inactiva${data.inactive_reason ? `: ${data.inactive_reason}` : ''}. No puede participar en actividades.`, 400)
    res.send({ ...volunteerDTO(data), visitor: Boolean(site && data.site_id !== site), activeEvent: await activeEventOf(data.id), insuranceExpired: Boolean(insuranceProblem(data)), paid: await isPaid(data.document) })
  }))

  app.post('/socorro/personas', auth(STAFF), hx(async (req, res) => {
    const errors = validateVolunteer(req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { data, error } = await supabase.from('volunteers').insert({ ...volunteerRow(req.body), site_id: await targetSite(req, req.body?.siteId) }).select('*, site:sites(name)').single()
    if (error) {
      if (error.code === '23505') return fail(res, 'Ya existe una persona con ese documento o carnet', 409)
      throw error
    }
    res.status(201).send(volunteerDTO(data))
  }))

  app.put('/socorro/personas/:id', auth(STAFF), hx(async (req, res) => {
    const errors = validateVolunteer(req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { data: cur } = await supabase.from('volunteers').select('site_id, active').eq('id', Number(req.params.id)).maybeSingle()
    if (!cur || !canAccessSite(req, cur.site_id)) return fail(res, 'Persona no encontrada', 404)
    const row = volunteerRow(req.body)
    if (req.user.role === 'administrador' && Number(req.body.siteId)) row.site_id = Number(req.body.siteId)
    // Reactivar reinicia la ventana de evaluación de horas.
    if (!cur.active && row.active) { row.reactivated_at = todayBogota(); row.inactive_reason = null }
    if (cur.active && !row.active) row.inactive_reason = clean(req.body.inactiveReason) || 'Inactivado manualmente'
    const { data, error } = await supabase.from('volunteers').update(row).eq('id', Number(req.params.id)).select('*, site:sites(name)').maybeSingle()
    if (error) {
      if (error.code === '23505') return fail(res, 'Ya existe una persona con ese documento o carnet', 409)
      throw error
    }
    if (!data) return fail(res, 'Persona no encontrada', 404)
    res.send(volunteerDTO(data))
  }))

  app.delete('/socorro/personas/:id', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('volunteers').delete().eq('id', Number(req.params.id))
    if (error) {
      if (error.code === '23503') return fail(res, 'La persona tiene eventos registrados. Márcala como inactiva en lugar de eliminarla.', 409)
      throw error
    }
    res.send({ message: 'Persona eliminada' })
  }))

  // ================================================================ Inventario (lectura para eventos; la gestión está en inventory.js)
  app.get('/socorro/inventario', auth(EVENTS), hx(async (req, res) => {
    const site = Number(req.query.evento)
      ? (await supabase.from('gso_events').select('site_id').eq('id', Number(req.query.evento)).maybeSingle()).data?.site_id
      : scopeSite(req)
    if (site && !canAccessSite(req, site)) return fail(res, 'Sin acceso', 403)
    const { data, error } = await applyScope(supabase.from('inventory_items').select('*, warehouse:warehouses(name, active)'), site).gt('stock', 0).order('category').order('name').order('expiry_date', { nullsFirst: false })
    if (error) throw error
    // Cantidad que está afuera en eventos en curso (materiales sin devolver).
    const { data: out, error: e2 } = await supabase.from('gso_event_materials')
      .select('item_id, quantity, gso_events!inner(status)').eq('gso_events.status', 'en_curso')
    if (e2) throw e2
    const inUse = {}
    for (const m of out) inUse[m.item_id] = (inUse[m.item_id] || 0) + Number(m.quantity)
    res.send(data.map((i) => ({ ...itemDTO(i), inUse: inUse[i.id] || 0 })))
  }))

  // ================================================================ Eventos
  const EVENT_SELECT = `*, site:sites(id, name, municipality), coordinator:volunteers!gso_events_coordinator_id_fkey(*),
    gso_event_personnel(id, created_at, user_id, counts_hours, role_label, volunteers(*, site:sites(name)), usr:users!gso_event_personnel_user_id_fkey(id, name, last_name, identification, role, remunerado, site:sites(name))),
    gso_event_materials(id, quantity, returned, state, observation, created_at, inventory_items(*)),
    gso_event_supplies(id, quantity, observation, created_at, inventory_items(*), users(name, last_name))`

  const isCoordinator = (event, user) => event.coordinator?.document === user.identification
  const canManage = (event, user) => user.role === 'administrador' || isCoordinator(event, user)

  const eventDTO = (e, user) => ({
    id: e.id, code: e.code, name: e.name, place: e.place, area: e.area, status: e.status, siteId: e.site_id, siteName: e.site?.name, municipality: e.site?.municipality,
    startedAt: e.started_at, endedAt: e.ended_at, materialsComplete: e.materials_complete,
    generalObservation: e.general_observation,
    coordinator: volunteerDTO(e.coordinator),
    personnel: (e.gso_event_personnel || []).sort((a, b) => a.id - b.id).map((p) => (p.volunteers
      ? { ...volunteerDTO(p.volunteers), id: p.id, personId: p.volunteers.id, userId: null, countsHours: p.counts_hours, roleLabel: p.role_label }
      : { id: p.id, personId: null, userId: p.usr.id, fullName: `${p.usr.name} ${p.usr.last_name}`, document: p.usr.identification, carnet: null, bloodType: null,
          agrupacion: p.role_label || ROLE_NAMES[p.usr.role], siteName: p.usr.site?.name ?? null, countsHours: p.counts_hours, roleLabel: p.role_label || ROLE_NAMES[p.usr.role], remunerado: p.usr.remunerado })),
    materials: (e.gso_event_materials || []).sort((a, b) => a.id - b.id).map((m) => ({
      id: m.id, quantity: Number(m.quantity), returned: m.returned == null ? null : Number(m.returned), state: m.state,
      observation: m.observation, item: itemDTO(m.inventory_items)
    })),
    supplies: (e.gso_event_supplies || []).sort((a, b) => a.id - b.id).map((s) => ({
      id: s.id, quantity: Number(s.quantity), observation: s.observation, createdAt: s.created_at,
      item: itemDTO(s.inventory_items), user: s.users ? `${s.users.name} ${s.users.last_name}` : null
    })),
    permissions: user ? {
      manage: canManage(e, user) && (e.status === 'en_curso' || user.role === 'administrador'),
      isCoordinator: isCoordinator(e, user),
      addPersonnel: e.status === 'en_curso',
      delete: user.role === 'administrador' || (isCoordinator(e, user) && e.status === 'en_curso')
    } : undefined
  })

  // Carga el evento validando que pertenezca a la sede del usuario.
  const loadEventFor = async (req) => {
    const e = await loadEvent(req.params.id)
    if (!canAccessSite(req, e.site_id)) throw httpError(404, 'Evento no encontrado')
    if (!areasOf(req.user).includes(e.area)) throw httpError(403, `No tienes habilitado el módulo de ${e.area === 'educacion' ? 'Educación' : 'Socorro'}`)
    return e
  }
  const loadEvent = async (id) => {
    const { data, error } = await supabase.from('gso_events').select(EVENT_SELECT).eq('id', Number(id)).maybeSingle()
    if (error) throw error
    if (!data) throw httpError(404, 'Evento no encontrado')
    return data
  }
  const requireManage = (event, user) => {
    if (!canManage(event, user)) throw httpError(403, 'Solo el coordinador del evento (o un administrador) puede hacer este cambio')
    if (event.status !== 'en_curso' && user.role !== 'administrador') throw httpError(400, 'El evento ya finalizó')
  }
  const requireOpen = (event) => {
    if (event.status !== 'en_curso') throw httpError(400, 'El evento ya finalizó; no se pueden mover materiales ni insumos')
  }

  app.get('/socorro/eventos', auth(EVENTS), hx(async (req, res) => {
    const estado = clean(req.query.estado); const q = clean(req.query.q)
    const desde = clean(req.query.desde); const hasta = clean(req.query.hasta)
    if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
    let query = applyScope(supabase.from('gso_events')
      .select('id, code, name, place, area, status, started_at, ended_at, site_id, site:sites(name), coordinator:volunteers!gso_events_coordinator_id_fkey(first_name, last_name, carnet), gso_event_personnel(count), gso_event_supplies(count), gso_event_materials(count)', { count: 'exact' }), scopeSite(req))
      .order('started_at', { ascending: false })
    if (estado) query = query.eq('status', estado)
    const allowed = areasOf(req.user)
    if (AREAS.includes(req.query.area)) {
      if (!allowed.includes(req.query.area)) return fail(res, 'No tienes habilitado este módulo', 403)
      query = query.eq('area', req.query.area)
    } else query = query.in('area', allowed)
    if (desde) query = query.gte('started_at', `${desde}T00:00:00${TZ_OFFSET}`)
    if (hasta) query = query.lte('started_at', `${hasta}T23:59:59${TZ_OFFSET}`)
    if (q) { const s = q.replace(/[%_,()]/g, ''); query = query.or(`name.ilike.%${s}%,place.ilike.%${s}%,code.ilike.%${s}%`) }
    const { data, error, count } = await pageQuery(req, query, 300)
    if (!error) setTotal(res, count)
    if (error) throw error
    res.send(data.map((e) => ({
      id: e.id, code: e.code, name: e.name, place: e.place, area: e.area, status: e.status, startedAt: e.started_at, endedAt: e.ended_at,
      coordinator: e.coordinator ? `${e.coordinator.first_name} ${e.coordinator.last_name}` : null,
      coordinatorCarnet: e.coordinator?.carnet, siteId: e.site_id, siteName: e.site?.name,
      personnelCount: e.gso_event_personnel?.[0]?.count ?? 0,
      materialsCount: e.gso_event_materials?.[0]?.count ?? 0,
      suppliesCount: e.gso_event_supplies?.[0]?.count ?? 0
    })))
  }))

  // Crear evento: la hora de inicio la pone el servidor; el coordinador queda como parte del personal.
  app.post('/socorro/eventos', auth(EVENTS), hx(async (req, res) => {
    const b = req.body || {}
    if (!clean(b.name) || !clean(b.place)) return fail(res, 'Evento y lugar son requeridos', 400)
    if (!areasOf(req.user).includes(AREAS.includes(b.area) ? b.area : 'socorro')) return fail(res, 'No tienes habilitado este módulo', 403)
    const coordinatorId = Number(b.coordinatorId)
    const { data: coord } = await supabase.from('volunteers').select('id, active, first_name, last_name, site_id, document, insurance_expiry').eq('id', coordinatorId).maybeSingle()
    if (!coord || !coord.active) return fail(res, 'Selecciona un coordinador registrado y activo', 400)
    const insC = insuranceProblem(coord); if (insC) return fail(res, insC, 400)
    // El evento queda en la sede del usuario (el admin lo crea en la sede del coordinador).
    const siteId = req.user.role === 'administrador' ? (Number(b.siteId) || coord.site_id) : req.user.site_id
    if (coord.site_id !== siteId) return fail(res, 'El coordinador debe pertenecer a la misma sede del evento', 400)
    const busy = await activeEventOf(coordinatorId)
    if (busy) return fail(res, busyMessage(coord, busy), 409)
    const { data, error } = await supabase.from('gso_events').insert({
      name: clean(b.name), place: clean(b.place), area: AREAS.includes(b.area) ? b.area : 'socorro', coordinator_id: coordinatorId, created_by: req.user.id, site_id: siteId
    }).select('id').single()
    if (error) throw error
    const { error: pErr } = await supabase.from('gso_event_personnel').insert({ event_id: data.id, volunteer_id: coordinatorId, added_by: req.user.id, counts_hours: !(await isPaid(coord.document)) })
    if (pErr) { // carrera: alguien lo asignó a otro evento entre la validación y el registro
      await supabase.from('gso_events').delete().eq('id', data.id)
      if (isBusyError(pErr)) return fail(res, `${coord.first_name} ${coord.last_name} ya está en otro evento en curso.`, 409)
      throw pErr
    }
    res.status(201).send(eventDTO(await loadEvent(data.id), req.user))
  }))

  app.get('/socorro/eventos/:id', auth(EVENTS), hx(async (req, res) => {
    res.send(eventDTO(await loadEventFor(req), req.user))
  }))

  app.put('/socorro/eventos/:id', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user)
    const b = req.body || {}
    if (!clean(b.name) || !clean(b.place)) return fail(res, 'Evento y lugar son requeridos', 400)
    const patch = { name: clean(b.name), place: clean(b.place), general_observation: clean(b.generalObservation), updated_at: new Date().toISOString() }
    if (b.coordinatorId && Number(b.coordinatorId) !== event.coordinator_id) {
      if (req.user.role !== 'administrador') return fail(res, 'Solo un administrador puede cambiar el coordinador', 403)
      patch.coordinator_id = Number(b.coordinatorId)
      if (event.status === 'en_curso') {
        const { data: nv } = await supabase.from('volunteers').select('first_name, last_name').eq('id', patch.coordinator_id).maybeSingle()
        const busy = await activeEventOf(patch.coordinator_id, event.id)
        if (busy) return fail(res, busyMessage(nv || { first_name: 'La persona', last_name: '' }, busy), 409)
      }
      const { error: upErr } = await supabase.from('gso_event_personnel').upsert({ event_id: event.id, volunteer_id: patch.coordinator_id, added_by: req.user.id }, { onConflict: 'event_id,volunteer_id', ignoreDuplicates: true })
      if (upErr) { if (isBusyError(upErr)) return fail(res, 'El nuevo coordinador ya está en otro evento en curso.', 409); throw upErr }
    }
    const { error } = await supabase.from('gso_events').update(patch).eq('id', event.id)
    if (error) throw error
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // Eliminar: revierte el stock de lo que no regresó y de los insumos consumidos.
  app.delete('/socorro/eventos/:id', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    const dto = eventDTO(event, req.user)
    if (!dto.permissions.delete) return fail(res, 'Solo el coordinador (con el evento en curso) o un administrador puede eliminarlo', 403)
    for (const m of dto.materials) {
      const back = m.quantity - (event.status === 'finalizado' ? (m.returned ?? 0) : 0)
      if (back > 0) await moveStock(m.item.id, back, 'reverso', null, req.user.id, `Eliminación del evento ${event.code}`)
    }
    for (const s of dto.supplies) await moveStock(s.item.id, s.quantity, 'reverso', null, req.user.id, `Eliminación del evento ${event.code}`)
    const { error } = await supabase.from('gso_events').delete().eq('id', event.id)
    if (error) throw error
    res.send({ message: 'Evento eliminado y stock restituido' })
  }))

  // ---------- Personal ----------
  // Pueden agregar: el coordinador, un administrador o la propia persona (por su documento).
  app.post('/socorro/eventos/:id/personal', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    if (event.status !== 'en_curso') return fail(res, 'El evento ya finalizó', 400)
    let vol = null; let usr = null
    if (Number(req.body?.userId)) {
      // Conductor u otro usuario del sistema. Si también es voluntario, se registra como voluntario.
      const { data: u } = await supabase.from('users').select('id, name, last_name, identification, role, remunerado, active').eq('id', Number(req.body.userId)).maybeSingle()
      if (!u || !u.active) return fail(res, 'Usuario no disponible', 400)
      const { data: v } = await supabase.from('volunteers').select('*').eq('document', u.identification).maybeSingle()
      if (v) vol = v
      else if (!u.remunerado) {
        // Usuario no remunerado sin registro de voluntario: se crea automáticamente como voluntario de apoyo
        // para que sume horas; queda marcado con los datos que faltan por completar.
        const { data: full } = await supabase.from('users').select('email, site_id').eq('id', u.id).single()
        const { data: created, error: cErr } = await supabase.from('volunteers').insert({
          document: u.identification, first_name: u.name, last_name: u.last_name, email: full.email || null,
          site_id: full.site_id || event.site_id, volunteer_type: 'apoyo', joined_at: todayBogota(), active: true, auto_created: true
        }).select('*').single()
        if (cErr) throw cErr
        vol = created
      } else usr = u
    } else {
      const { data: v } = await supabase.from('volunteers').select('*').eq('id', Number(req.body?.volunteerId)).maybeSingle()
      vol = v
    }
    if (!vol && !usr) return fail(res, 'Persona no registrada', 400)
    const self = vol ? vol.document === req.user.identification : usr.id === req.user.id
    if (!canManage(event, req.user) && !self) return fail(res, 'Solo el coordinador puede agregar a otras personas; tú puedes registrarte a ti mismo', 403)
    let row
    if (vol) {
      if (!vol.active) return fail(res, `${vol.first_name} ${vol.last_name} está inactiva${vol.inactive_reason ? ` (${vol.inactive_reason})` : ''} y no puede participar en actividades.`, 400)
      const ins = insuranceProblem(vol); if (ins) return fail(res, ins, 400)
      if (event.gso_event_personnel.some((p) => p.volunteers?.id === vol.id)) return fail(res, 'La persona ya está en el evento', 409)
      const busy = await activeEventOf(vol.id, event.id)
      if (busy) return fail(res, busyMessage(vol, busy), 409)
      const paid = await isPaid(vol.document)
      row = { event_id: event.id, volunteer_id: vol.id, added_by: req.user.id, counts_hours: !paid, role_label: usr ? ROLE_NAMES[usr.role] : (req.body?.roleLabel ? clean(req.body.roleLabel) : null) }
      if (req.body?.userId) { const { data: u2 } = await supabase.from('users').select('role').eq('id', Number(req.body.userId)).maybeSingle(); row.role_label = ROLE_NAMES[u2?.role] || null }
    } else {
      if (event.gso_event_personnel.some((p) => p.user_id === usr.id)) return fail(res, 'La persona ya está en el evento', 409)
      // Usuario que no es voluntario: no tiene registro de horas de voluntariado.
      row = { event_id: event.id, user_id: usr.id, added_by: req.user.id, counts_hours: false, role_label: ROLE_NAMES[usr.role] }
    }
    const { error } = await supabase.from('gso_event_personnel').insert(row)
    if (error) {
      const who = vol ? `${vol.first_name} ${vol.last_name}` : `${usr.name} ${usr.last_name}`
      if (error.code === '23505') return fail(res, 'La persona ya está en el evento', 409)
      if (isBusyError(error)) return fail(res, `${who} ya está en otro evento en curso.`, 409)
      throw error
    }
    res.status(201).send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // Buscar conductores y demás usuarios del sistema para agregarlos al personal del evento.
  app.get('/socorro/usuarios/buscar', auth(EVENTS), hx(async (req, res) => {
    const q = clean(req.query.q)?.replace(/[%_,()]/g, '')
    if (!q || q.length < 3) return res.send([])
    const { data, error } = await supabase.from('users').select('id, name, last_name, identification, role, remunerado, site:sites(name)')
      .eq('active', true).or(`identification.ilike.%${q}%,name.ilike.%${q}%,last_name.ilike.%${q}%`).order('name').limit(15)
    if (error) throw error
    const docs = data.map((u) => u.identification)
    const { data: vols } = docs.length ? await supabase.from('volunteers').select('document, insurance_expiry, active').in('document', docs) : { data: [] }
    res.send(data.map((u) => {
      const v = (vols || []).find((x) => x.document === u.identification)
      return { id: u.id, fullName: `${u.name} ${u.last_name}`, identification: u.identification, role: u.role, roleLabel: ROLE_NAMES[u.role], remunerado: u.remunerado, siteName: u.site?.name ?? null,
        isVolunteer: Boolean(v), insuranceExpired: Boolean(v?.insurance_expiry && v.insurance_expiry < todayBogota()), countsHours: Boolean(v) && !u.remunerado }
    }))
  }))

  app.delete('/socorro/eventos/:id/personal/:pid', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user)
    const row = event.gso_event_personnel.find((p) => p.id === Number(req.params.pid))
    if (!row) return fail(res, 'Registro no encontrado', 404)
    if (row.volunteers?.id === event.coordinator_id) return fail(res, 'El coordinador no se puede retirar del evento', 400)
    await supabase.from('gso_event_personnel').delete().eq('id', row.id)
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // ---------- Materiales (salen del inventario y regresan al finalizar) ----------
  const validMaterial = (b, { partial } = {}) => {
    if (!partial && !Number(b.itemId)) return 'Selecciona un elemento'
    if (b.quantity !== undefined && (Number.isNaN(num(b.quantity)) || num(b.quantity) <= 0)) return 'Cantidad inválida'
    if (b.state && !STATES.includes(b.state)) return 'Estado inválido'
    return null
  }

  app.post('/socorro/eventos/:id/materiales', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user); requireOpen(event)
    const b = req.body || {}
    const err = validMaterial(b); if (err) return fail(res, err, 400)
    const { data: item } = await supabase.from('inventory_items').select('*').eq('id', Number(b.itemId)).maybeSingle()
    if (!item || !item.active || item.site_id !== event.site_id) return fail(res, 'Elemento no disponible en el inventario de esta sede', 400)
    if (isConsumable(item)) return fail(res, 'Los medicamentos, dispositivos médicos y reactivos se registran como consumo, no como material', 400)
    if (event.gso_event_materials.some((m) => m.inventory_items.id === item.id)) return fail(res, 'El elemento ya está en la lista; edita su cantidad', 409)
    await moveStock(item.id, -num(b.quantity), 'salida', event.id, req.user.id, `Salida a ${event.code}`)
    const { error } = await supabase.from('gso_event_materials').insert({
      event_id: event.id, item_id: item.id, quantity: num(b.quantity), state: b.state || 'bueno', observation: clean(b.observation)
    })
    if (error) { await moveStock(item.id, num(b.quantity), 'reverso', event.id, req.user.id, 'Reverso por error'); throw error }
    res.status(201).send(eventDTO(await loadEvent(event.id), req.user))
  }))

  app.put('/socorro/eventos/:id/materiales/:mid', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user)
    const b = req.body || {}
    const err = validMaterial(b, { partial: true }); if (err) return fail(res, err, 400)
    const row = event.gso_event_materials.find((m) => m.id === Number(req.params.mid))
    if (!row) return fail(res, 'Material no encontrado', 404)
    const patch = { state: b.state || row.state, observation: b.observation !== undefined ? clean(b.observation) : row.observation }
    if (b.quantity !== undefined && num(b.quantity) !== Number(row.quantity)) {
      requireOpen(event)
      const diff = num(b.quantity) - Number(row.quantity)
      await moveStock(row.inventory_items.id, -diff, diff > 0 ? 'salida' : 'devolucion', event.id, req.user.id, `Ajuste de cantidad en ${event.code}`)
      patch.quantity = num(b.quantity)
    }
    const { error } = await supabase.from('gso_event_materials').update(patch).eq('id', row.id)
    if (error) throw error
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  app.delete('/socorro/eventos/:id/materiales/:mid', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user); requireOpen(event)
    const row = event.gso_event_materials.find((m) => m.id === Number(req.params.mid))
    if (!row) return fail(res, 'Material no encontrado', 404)
    await moveStock(row.inventory_items.id, Number(row.quantity), 'devolucion', event.id, req.user.id, `Retirado de ${event.code}`)
    await supabase.from('gso_event_materials').delete().eq('id', row.id)
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // ---------- Insumos consumidos (descuentan stock de inmediato) ----------
  app.post('/socorro/eventos/:id/insumos', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user); requireOpen(event)
    const b = req.body || {}
    const q = num(b.quantity)
    if (!Number(b.itemId)) return fail(res, 'Selecciona un insumo', 400)
    if (Number.isNaN(q) || q <= 0) return fail(res, 'Cantidad inválida', 400)
    const { data: item } = await supabase.from('inventory_items').select('*').eq('id', Number(b.itemId)).maybeSingle()
    if (!item || !item.active || item.site_id !== event.site_id) return fail(res, 'Insumo no disponible en el inventario de esta sede', 400)
    if (!isConsumable(item)) return fail(res, 'Solo medicamentos, dispositivos médicos y reactivos se registran como consumo', 400)
    if (item.expiry_date && item.expiry_date < todayBogota()) return fail(res, `${item.name} (lote ${item.lot}) está vencido y no se puede usar`, 400)
    await moveStock(item.id, -q, 'consumo', event.id, req.user.id, `Consumo en ${event.code}`)
    const { error } = await supabase.from('gso_event_supplies').insert({ event_id: event.id, item_id: item.id, quantity: q, observation: clean(b.observation), created_by: req.user.id })
    if (error) { await moveStock(item.id, q, 'reverso', event.id, req.user.id, 'Reverso por error'); throw error }
    res.status(201).send(eventDTO(await loadEvent(event.id), req.user))
  }))

  app.delete('/socorro/eventos/:id/insumos/:sid', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user); requireOpen(event)
    const row = event.gso_event_supplies.find((s) => s.id === Number(req.params.sid))
    if (!row) return fail(res, 'Registro no encontrado', 404)
    await moveStock(row.inventory_items.id, Number(row.quantity), 'reverso', event.id, req.user.id, `Anulación de consumo en ${event.code}`)
    await supabase.from('gso_event_supplies').delete().eq('id', row.id)
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // ---------- Finalizar servicio: hora final automática y devolución de materiales ----------
  app.post('/socorro/eventos/:id/finalizar', auth(EVENTS), hx(async (req, res) => {
    const event = await loadEventFor(req)
    requireManage(event, req.user); requireOpen(event)
    const b = req.body || {}
    const returns = new Map((b.returns || []).map((r) => [Number(r.id), r]))
    // Validar todo antes de mover stock.
    for (const m of event.gso_event_materials) {
      const r = returns.get(m.id)
      const qty = r ? num(r.returned) : Number(m.quantity)
      if (Number.isNaN(qty) || qty < 0 || qty > Number(m.quantity)) return fail(res, `Cantidad devuelta inválida para ${m.inventory_items.name}`, 400)
      if (r?.state && !STATES.includes(r.state)) return fail(res, 'Estado inválido', 400)
    }
    let complete = true
    for (const m of event.gso_event_materials) {
      const r = returns.get(m.id) || {}
      const qty = r.returned !== undefined ? num(r.returned) : Number(m.quantity)
      if (qty < Number(m.quantity)) complete = false
      if (qty > 0) await moveStock(m.inventory_items.id, qty, 'devolucion', event.id, req.user.id, `Entrada de ${event.code}`)
      const missing = Number(m.quantity) - qty
      await supabase.from('gso_event_materials').update({
        returned: qty,
        state: r.state || (missing > 0 && qty === 0 ? 'perdido' : m.state),
        observation: r.observation !== undefined ? clean(r.observation) : m.observation
      }).eq('id', m.id)
    }
    const { error } = await supabase.from('gso_events').update({
      status: 'finalizado', ended_at: new Date().toISOString(),
      materials_complete: b.materialsComplete !== undefined ? Boolean(b.materialsComplete) && complete : complete,
      general_observation: b.generalObservation !== undefined ? clean(b.generalObservation) : event.general_observation,
      updated_at: new Date().toISOString()
    }).eq('id', event.id)
    if (error) throw error
    res.send(eventDTO(await loadEvent(event.id), req.user))
  }))

  // ================================================================ Panel del voluntario
  const daysTo = (iso) => {
    const u = (x) => { const [y, m, d] = x.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
    return Math.round((u(iso) - u(todayBogota())) / 86400000)
  }
  app.get('/voluntario/panel', auth(['administrador', 'empleado', 'voluntario']), hx(async (req, res) => {
    let q = supabase.from('volunteers').select('*, site:sites(id, name, municipality, type)')
    q = req.user.role === 'voluntario' || !req.query.id ? q.eq('document', req.user.identification) : q.eq('id', Number(req.query.id))
    const { data: v, error } = await q.maybeSingle()
    if (error) throw error
    if (!v) return fail(res, 'No encontramos tu registro de voluntario. Pide al administrador que te registre en Personas con tu número de documento.', 404)
    if (!canAccessSite(req, v.site_id)) return fail(res, 'Sin acceso', 403)

    const cur = todayBogota().slice(0, 7)
    const from = shiftMonth(cur, -5)
    const hours = (await hoursByVolunteer([v.id], from))[v.id] || {}
    const since = [v.joined_at, v.reactivated_at].filter(Boolean).sort().pop()
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(cur, i - 5)).map((k) => {
      const [y, m] = k.split('-').map(Number)
      const h = Math.round((hours[k] || 0) * 10) / 10
      return {
        key: k, label: new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15))).replace('.', ''),
        hours: h, met: h >= MIN_HOURS, current: k === cur, counts: !since || k > since.slice(0, 7) // solo meses completos después del ingreso
      }
    })
    const lastThree = months.filter((m) => !m.current).slice(-3)
    const shortStreak = (() => { let n = 0; for (const m of [...lastThree].reverse()) { if (m.counts && !m.met) n++; else break } return n })()

    const { data: parts, error: e2 } = await supabase.from('gso_event_personnel')
      .select('created_at, gso_events!inner(id, code, name, place, status, started_at, ended_at, coordinator_id)')
      .eq('volunteer_id', v.id).order('created_at', { ascending: false }).limit(12)
    if (e2) throw e2
    const { data: open, error: e3 } = await supabase.from('gso_events').select('id, code, name, place, started_at, gso_event_personnel(count)')
      .eq('site_id', v.site_id).eq('status', 'en_curso').order('started_at', { ascending: false })
    if (e3) throw e3

    const insuranceDays = v.insurance_expiry ? daysTo(v.insurance_expiry) : null
    res.send({
      volunteer: { ...volunteerDTO(v), site: v.site },
      minHours: MIN_HOURS,
      monthHours: months[months.length - 1].hours,
      months,
      requirement: v.volunteer_type === 'base' ? {
        applies: true, shortStreak, monthsToInactive: Math.max(0, 3 - shortStreak),
        message: !v.active ? 'Inactivo' : shortStreak === 0 ? 'Al día con las horas mínimas' : `${shortStreak} mes${shortStreak === 1 ? '' : 'es'} seguido${shortStreak === 1 ? '' : 's'} por debajo de ${MIN_HOURS} h`
      } : { applies: false, message: 'Voluntario de apoyo: sin horas mínimas obligatorias' },
      insurance: {
        entity: v.insurance_entity, policy: v.insurance_policy, expiry: v.insurance_expiry, daysLeft: insuranceDays,
        status: insuranceDays == null ? 'sin_seguro' : insuranceDays < 0 ? 'vencido' : insuranceDays <= 30 ? 'por_vencer' : 'vigente'
      },
      participations: parts.map((p) => {
        const e = p.gso_events
        return {
          id: e.id, code: e.code, name: e.name, place: e.place, area: e.area, status: e.status, startedAt: e.started_at, endedAt: e.ended_at,
          role: e.coordinator_id === v.id ? 'Coordinador' : 'Personal',
          hours: e.ended_at ? Math.round(((new Date(e.ended_at) - new Date(e.started_at)) / 3600000) * 10) / 10 : null
        }
      }),
      openEvents: open.map((e) => ({ id: e.id, code: e.code, name: e.name, place: e.place, startedAt: e.started_at, personnelCount: e.gso_event_personnel?.[0]?.count ?? 0 }))
    })
  }))

  // Revisión manual de la regla de horas (administrador).
  app.post('/voluntarios/evaluar', auth(ADMIN), hx(async (req, res) => res.send({ inactivated: await evaluateVolunteers() })))

  // ================================================================ Dashboard de Socorro
  // ---------------------------------------------------------------- Reporte general de voluntarios
  // Filtros: agrupación, sede (o tipo de sede), tipo de voluntario, estado y rango de fechas (horas y participaciones).
  app.get('/socorro/reporte-voluntarios', auth(['administrador', 'empleado', 'voluntario']), hx(async (req, res) => {
    const today = todayBogota()
    const desde = ISO_DATE.test(req.query.desde || '') ? req.query.desde : `${today.slice(0, 7)}-01`
    const hasta = ISO_DATE.test(req.query.hasta || '') ? req.query.hasta : today
    if (desde > hasta) return fail(res, 'La fecha inicial no puede ser mayor que la final', 400)
    const admin = req.user.role === 'administrador'
    const site = admin ? (Number(req.query.sede) || null) : req.user.site_id
    const siteType = admin && ['seccional', 'unidad_municipal', 'grupo_apoyo'].includes(req.query.tipoSede) ? req.query.tipoSede : null
    let q = supabase.from('volunteers').select('*, site:sites!inner(id, name, type)')
    if (site) q = q.eq('site_id', site)
    if (siteType) q = q.eq('site.type', siteType)
    if (AGRUPACIONES.includes(req.query.agrupacion)) q = q.eq('agrupacion', req.query.agrupacion)
    if (['base', 'apoyo'].includes(req.query.tipo)) q = q.eq('volunteer_type', req.query.tipo)
    if (req.query.estado === 'activos') q = q.eq('active', true)
    if (req.query.estado === 'inactivos') q = q.eq('active', false)
    const { data: vols, error } = await q.order('first_name')
    if (error) throw error
    const ids = vols.map((v) => v.id)
    const { data: parts, error: e2 } = ids.length
      ? await supabase.from('gso_event_personnel').select('volunteer_id, counts_hours, gso_events!inner(id, area, status, started_at, ended_at)')
        .in('volunteer_id', ids).eq('gso_events.status', 'finalizado')
        .gte('gso_events.started_at', `${desde}T00:00:00${TZ_OFFSET}`).lte('gso_events.started_at', `${hasta}T23:59:59${TZ_OFFSET}`)
      : { data: [] }
    if (e2) throw e2
    const { data: paidUsers } = await supabase.from('users').select('identification').eq('remunerado', true)
    const paid = new Set((paidUsers || []).map((u) => u.identification))
    const stat = {}
    const months = {}
    for (const p of parts) {
      const e = p.gso_events
      const h = Math.max(0, (new Date(e.ended_at) - new Date(e.started_at)) / 3600000)
      const s0 = stat[p.volunteer_id] || (stat[p.volunteer_id] = { hours: 0, events: 0, socorro: 0, educacion: 0 })
      s0.events += 1; s0[e.area === 'educacion' ? 'educacion' : 'socorro'] += 1
      if (p.counts_hours) {
        s0.hours += h
        const k = monthKey(e.started_at); months[k] = (months[k] || 0) + h
      }
    }
    const insurance = (v) => (!v.insurance_expiry ? 'sin_seguro' : v.insurance_expiry < today ? 'vencido' : v.insurance_expiry <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) ? 'por_vencer' : 'vigente')
    const rows = vols.map((v) => {
      const st = stat[v.id] || { hours: 0, events: 0, socorro: 0, educacion: 0 }
      return {
        id: v.id, fullName: `${v.first_name} ${v.last_name}`, document: v.document, carnet: v.carnet, agrupacion: v.agrupacion, bloodType: v.blood_type,
        volunteerType: v.volunteer_type, active: v.active, siteId: v.site_id, siteName: v.site?.name, siteType: v.site?.type, joinedAt: v.joined_at,
        insurance: insurance(v), insuranceExpiry: v.insurance_expiry, paid: paid.has(v.document), missingData: missingData(v),
        hours: Math.round(st.hours * 10) / 10, events: st.events, socorro: st.socorro, educacion: st.educacion
      }
    })
    const group = (key, labelFn = (k) => k) => Object.values(rows.reduce((acc, r) => {
      const k = r[key] ?? 'Sin dato'
      const g = acc[k] || (acc[k] = { name: labelFn(k), count: 0, active: 0, hours: 0, events: 0 })
      g.count += 1; if (r.active) g.active += 1; g.hours += r.hours; g.events += r.events
      return acc
    }, {})).map((g) => ({ ...g, hours: Math.round(g.hours * 10) / 10 })).sort((a, b) => b.count - a.count)
    // Horas por mes dentro del rango (incluye meses sin horas)
    const monthList = []
    for (let d = new Date(`${desde.slice(0, 7)}-01T12:00:00Z`); d.toISOString().slice(0, 7) <= hasta.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
      const k = d.toISOString().slice(0, 7)
      monthList.push({ key: k, label: new Intl.DateTimeFormat('es-CO', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(d).replace('.', ''), hours: Math.round((months[k] || 0) * 10) / 10 })
      if (monthList.length > 36) break
    }
    const INS = { vigente: 'Vigente', por_vencer: 'Vence en 30 días', vencido: 'Vencido', sin_seguro: 'Sin seguro' }
    res.send({
      filters: { desde, hasta, sede: site, tipoSede: siteType, agrupacion: req.query.agrupacion || null, tipo: req.query.tipo || null, estado: req.query.estado || null },
      kpis: {
        total: rows.length, active: rows.filter((r) => r.active).length, inactive: rows.filter((r) => !r.active).length,
        base: rows.filter((r) => r.volunteerType === 'base').length, apoyo: rows.filter((r) => r.volunteerType === 'apoyo').length,
        hours: Math.round(rows.reduce((a, r) => a + r.hours, 0) * 10) / 10,
        participants: rows.filter((r) => r.events > 0).length, events: new Set(parts.map((p) => p.gso_events.id)).size,
        insuranceProblems: rows.filter((r) => r.active && (r.insurance === 'vencido' || r.insurance === 'sin_seguro')).length,
        incomplete: rows.filter((r) => r.active && r.missingData.length).length
      },
      byAgrupacion: group('agrupacion'),
      bySite: group('siteName'),
      byType: group('volunteerType', (k) => (k === 'base' ? 'Base' : 'Apoyo')),
      byInsurance: group('insurance', (k) => INS[k] || k),
      byMonth: monthList,
      top: [...rows].filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 10).map((r) => ({ name: r.fullName, hours: r.hours, events: r.events })),
      rows
    })
  }))

  app.get('/socorro/dashboard', auth(NO_DRIVER), hx(async (req, res) => {
    const today = todayBogota()
    const ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : today.slice(0, 7)
    const [y, mo] = ym.split('-').map(Number)
    const start = `${ym}-01`
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
    const sixAgo = new Date(Date.UTC(y, mo - 6, 1)).toISOString().slice(0, 10)

    const site = scopeSite(req)
    const sc = (q) => applyScope(q, site)
    const scJoin = (q) => (site ? q.eq('gso_events.site_id', site) : q)
    const [items, monthEvents, open, recentEvents, consumption, volunteers, personnel] = await Promise.all([
      sc(supabase.from('inventory_items').select('*').eq('active', true)),
      sc(supabase.from('gso_events').select('id, started_at, ended_at, status, area'))
        .gte('started_at', `${sixAgo}T00:00:00${TZ_OFFSET}`).lt('started_at', `${next}T00:00:00${TZ_OFFSET}`),
      sc(supabase.from('gso_events').select('id, code, name, place, started_at, site:sites(name), coordinator:volunteers!gso_events_coordinator_id_fkey(first_name, last_name), gso_event_personnel(count)'))
        .eq('status', 'en_curso').order('started_at', { ascending: false }),
      sc(supabase.from('gso_events').select('id, code, name, place, area, status, started_at, ended_at, site:sites(name), gso_event_personnel(count)'))
        .order('started_at', { ascending: false }).limit(6),
      scJoin(supabase.from('gso_event_supplies').select('quantity, created_at, inventory_items(name, unit), gso_events!inner(site_id)')
        .gte('created_at', `${start}T00:00:00${TZ_OFFSET}`).lt('created_at', `${next}T00:00:00${TZ_OFFSET}`)),
      sc(supabase.from('volunteers').select('id', { count: 'exact', head: true }).eq('active', true)),
      scJoin(supabase.from('gso_event_personnel').select('volunteer_id, gso_events!inner(started_at, site_id)')
        .gte('gso_events.started_at', `${start}T00:00:00${TZ_OFFSET}`).lt('gso_events.started_at', `${next}T00:00:00${TZ_OFFSET}`))
    ])
    for (const r of [items, monthEvents, open, recentEvents, consumption, volunteers, personnel]) if (r.error) throw r.error

    const all = items.data.map(itemDTO)
    const low = all.filter((i) => i.low).sort((a, b) => (a.stock / (a.minStock || 1)) - (b.stock / (b.minStock || 1)))

    // Eventos por mes (últimos 6 meses)
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, mo - 1 - i, 1))
      const key = d.toISOString().slice(0, 7)
      months.push({ key, label: new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(d).replace('.', ''), value: 0 })
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]))
    const monthKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)).slice(0, 7)
    for (const e of monthEvents.data) { const k = monthKey(e.started_at); if (byKey[k]) byKey[k].value += 1 }
    const thisMonth = monthEvents.data.filter((e) => monthKey(e.started_at) === ym)
    const hours = thisMonth.filter((e) => e.ended_at).reduce((a, e) => a + (new Date(e.ended_at) - new Date(e.started_at)) / 3600000, 0)

    // Insumos más consumidos del mes
    const cons = {}
    for (const s of consumption.data) {
      const k = s.inventory_items.name
      cons[k] = cons[k] || { name: k, unit: s.inventory_items.unit, value: 0 }
      cons[k].value += Number(s.quantity)
    }
    const topConsumption = Object.values(cons).sort((a, b) => b.value - a.value).slice(0, 8)

    const byCategory = [...CONSUMABLE, 'operacional', 'no_operacional'].map((c) => ({
      name: c, items: all.filter((i) => i.category === c).length, low: all.filter((i) => i.category === c && i.low).length
    }))

    // Recordatorio: voluntarios activos con datos incompletos (p. ej. creados automáticamente desde un conductor).
    const { data: volsAll } = await sc(supabase.from('volunteers').select('id, first_name, last_name, document, carnet, agrupacion, blood_type, phone, insurance_entity, insurance_expiry, auto_created').eq('active', true))
    const incompleteVolunteers = (volsAll || []).map((v) => ({ id: v.id, fullName: `${v.first_name} ${v.last_name}`, document: v.document, autoCreated: v.auto_created, missing: missingData(v) }))
      .filter((v) => v.missing.length).sort((a, b) => Number(b.autoCreated) - Number(a.autoCreated))

    res.send({
      month: ym,
      incompleteVolunteers,
      kpis: {
        openEvents: open.data.length,
        monthEvents: thisMonth.length,
        serviceHours: Math.round(hours * 10) / 10,
        activeVolunteers: volunteers.count,
        volunteersInMonth: new Set(personnel.data.map((p) => p.volunteer_id).filter(Boolean)).size,
        lowStock: low.length,
        totalItems: all.length,
        monthSocorro: thisMonth.filter((e) => e.area === 'socorro').length,
        monthEducacion: thisMonth.filter((e) => e.area === 'educacion').length
      },
      lowStock: low,
      openEvents: open.data.map((e) => ({
        id: e.id, code: e.code, name: e.name, place: e.place, startedAt: e.started_at,
        coordinator: e.coordinator ? `${e.coordinator.first_name} ${e.coordinator.last_name}` : null,
        personnelCount: e.gso_event_personnel?.[0]?.count ?? 0
      })),
      eventsByMonth: months.map(({ label, value, key }) => ({ label, value, key })),
      topConsumption,
      byCategory,
      recentEvents: recentEvents.data.map((e) => ({
        id: e.id, code: e.code, name: e.name, place: e.place, area: e.area, status: e.status, startedAt: e.started_at, endedAt: e.ended_at,
        personnelCount: e.gso_event_personnel?.[0]?.count ?? 0
      }))
    })
  }))
}
