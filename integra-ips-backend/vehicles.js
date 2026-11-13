// =====================================================================
// Módulo de vehículos (flota) · Gestión de Socorro y Operaciones
// Hoja de vida (solo administrador), documentos con vencimiento (SOAT…),
// mantenimientos con repuestos, reportes diarios del conductor y dashboard.
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, scopeSite, applyScope, canAccessSite, targetSite } = deps

  const FLEET_VIEW = ['administrador', 'empleado', 'conductor'] // ven la flota
  const TRIP_ROLES = ['administrador', 'conductor'] // reportes diarios
  const DASH_ROLES = ['administrador', 'empleado', 'conductor']
  const TYPES = ['Ambulancia TAB', 'Ambulancia TAM', 'Camioneta', 'Automóvil', 'Motocicleta', 'Bus / buseta', 'Camión', 'Otro']
  const PHOTO_SLOTS = { front: 'photo_front', back: 'photo_back', left: 'photo_left', right: 'photo_right' }
  const IMG = ['image/png', 'image/jpeg', 'image/webp']

  // Umbrales de alerta (fáciles de ajustar o llevar a Configuración más adelante)
  const ALERT = { docDays: 30, maintDays: 15, maintKm: 500 }

  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
  const isNum = (v) => v !== null && !Number.isNaN(v)
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e }
  })
  const daysUntil = (iso) => {
    const t = todayBogota()
    return Math.round((Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(...t.split('-').map((n, i) => (i === 1 ? n - 1 : +n)))) / 86400000)
  }
  const fullName = (u) => (u ? `${u.name} ${u.last_name}` : null)
  // Ambulancias: Transporte Asistencial Básico (TAB) o Medicalizado (TAM).
  const ambulanceType = (type) => { const m = /\b(TAB|TAM)\b/i.exec(type || ''); return m ? m[1].toUpperCase() : null }

  // ---------------------------------------------------------------- DTOs
  const vehicleDTO = (v) => v && ({
    id: v.id, movil: v.movil, plate: v.plate, vehicleType: v.vehicle_type, brand: v.brand, line: v.line,
    modelYear: v.model_year, color: v.color, serial: v.serial, engineNumber: v.engine_number, owner: v.owner,
    fuelType: v.fuel_type, condition: v.condition, initialKm: Number(v.initial_km), currentKm: Number(v.current_km),
    purchaseDate: v.purchase_date, status: v.status, notes: v.notes,
    siteId: v.site_id, siteName: v.site?.name ?? null, ownerSiteId: v.owner_site_id, ownerSiteName: v.owner_site?.name ?? null,
    ambulanceType: ambulanceType(v.vehicle_type), isAmbulance: Boolean(ambulanceType(v.vehicle_type)),
    assignedDriverId: v.assigned_driver_id ?? null, assignedDriverName: v.assigned ? fullName(v.assigned) : null,
    photos: { front: v.photo_front, back: v.photo_back, left: v.photo_left, right: v.photo_right }
  })
  const docDTO = (d) => ({
    id: d.id, docType: d.doc_type, entity: d.entity, number: d.number, purchaseDate: d.purchase_date,
    expiryDate: d.expiry_date, price: d.price == null ? null : Number(d.price), notes: d.notes, daysLeft: daysUntil(d.expiry_date)
  })
  const maintDTO = (m) => ({
    id: m.id, type: m.type, date: m.date, km: m.km == null ? null : Number(m.km), description: m.description,
    workshop: m.workshop, technician: m.technician, driver: m.driver ? { id: m.driver.id, name: fullName(m.driver) } : null,
    laborCost: Number(m.labor_cost), partsCost: Number(m.parts_cost), total: Number(m.labor_cost) + Number(m.parts_cost),
    nextDueDate: m.next_due_date, nextDueKm: m.next_due_km == null ? null : Number(m.next_due_km), notes: m.notes,
    parts: (m.vehicle_maintenance_parts || []).sort((a, b) => a.id - b.id).map((p) => ({ id: p.id, name: p.name, quantity: Number(p.quantity), unitPrice: Number(p.unit_price), total: Number(p.quantity) * Number(p.unit_price) }))
  })
  const tripDTO = (t) => ({
    id: t.id, code: t.code, status: t.status, activity: t.activity,
    event: t.gso_events ? { id: t.gso_events.id, code: t.gso_events.code, name: t.gso_events.name, status: t.gso_events.status } : null,
    canClose: t.status === 'abierto' && (!t.gso_events || t.gso_events.status !== 'en_curso'),
    vehicle: t.vehicles ? { id: t.vehicles.id, movil: t.vehicles.movil, plate: t.vehicles.plate, vehicleType: t.vehicles.vehicle_type, brand: t.vehicles.brand, line: t.vehicles.line } : null,
    driver: t.driver ? { id: t.driver.id, name: fullName(t.driver), identification: t.driver.identification } : null,
    startedAt: t.started_at, endedAt: t.ended_at, kmOut: Number(t.km_out), kmIn: t.km_in == null ? null : Number(t.km_in),
    kmDiff: t.km_diff == null ? null : Number(t.km_diff), tachometerPhoto: t.tachometer_photo,
    fuelValue: t.fuel_value == null ? null : Number(t.fuel_value), fuelGallons: t.fuel_gallons == null ? null : Number(t.fuel_gallons),
    fuelTicketPhoto: t.fuel_ticket_photo, observation: t.observation,
    transfer: transferDTO(Array.isArray(t.vehicle_transfers) ? t.vehicle_transfers[0] : t.vehicle_transfers)
  })
  const transferDTO = (x) => x && ({
    patientName: x.patient_name, documentType: x.document_type, document: x.document, sex: x.sex, ageYears: x.age_years, phone: x.phone,
    eps: x.eps, regime: x.regime, transferType: x.transfer_type, priority: x.priority, origin: x.origin, destination: x.destination,
    diagnosis: x.diagnosis, patientCondition: x.patient_condition, companionName: x.companion_name, companionPhone: x.companion_phone,
    authorizationNumber: x.authorization_number, receivingProfessional: x.receiving_professional, notes: x.notes
  })
  const DOC_TYPES = ['CC', 'TI', 'RC', 'CE', 'PA', 'PPT', 'MS', 'AS']
  const REGIMES = ['contributivo', 'subsidiado', 'especial', 'particular', 'soat', 'otro']
  const validateTransfer = (x) => {
    const e = []
    for (const [k, l] of [['patientName', 'Nombre del paciente'], ['document', 'Número de identificación'], ['eps', 'EPS / aseguradora'], ['origin', 'Lugar de origen'], ['destination', 'Destino (IPS receptora)'], ['diagnosis', 'Diagnóstico o motivo del traslado']]) if (!clean(x[k])) e.push(`${l} es obligatorio`)
    if (!DOC_TYPES.includes(x.documentType)) e.push('Tipo de documento inválido')
    if (!REGIMES.includes(x.regime)) e.push('Régimen inválido')
    if (!['primario', 'secundario'].includes(x.transferType)) e.push('Tipo de traslado inválido')
    if (!['urgente', 'prioritario', 'programado'].includes(x.priority)) e.push('Prioridad inválida')
    if (x.sex && !['F', 'M', 'I'].includes(x.sex)) e.push('Sexo inválido')
    if (x.patientCondition && !['estable', 'inestable', 'critico'].includes(x.patientCondition)) e.push('Condición del paciente inválida')
    const age = num(x.ageYears); if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) e.push('Edad inválida')
    if (clean(x.phone) && !/^[0-9]{7,10}$/.test(clean(x.phone))) e.push('Teléfono del paciente inválido')
    if (clean(x.companionPhone) && !/^[0-9]{7,10}$/.test(clean(x.companionPhone))) e.push('Teléfono del acompañante inválido')
    return e
  }
  const transferRow = (x) => ({
    patient_name: clean(x.patientName), document_type: x.documentType, document: clean(x.document).replace(/\s+/g, ''), sex: x.sex || null,
    age_years: num(x.ageYears), phone: clean(x.phone), eps: clean(x.eps), regime: x.regime, transfer_type: x.transferType, priority: x.priority,
    origin: clean(x.origin), destination: clean(x.destination), diagnosis: clean(x.diagnosis), patient_condition: x.patientCondition || null,
    companion_name: clean(x.companionName), companion_phone: clean(x.companionPhone), authorization_number: clean(x.authorizationNumber),
    receiving_professional: clean(x.receivingProfessional), notes: clean(x.notes)
  })
  const TRIP_SELECT = '*, vehicle_transfers(*), vehicles(id, movil, plate, vehicle_type, brand, line), driver:users!vehicle_trips_driver_id_fkey(id, name, last_name, identification), gso_events(id, code, name, status)'

  // Alertas de un vehículo: SOAT/documentos por vencer y mantenimiento preventivo próximo (fecha o km).
  const alertsFor = (v, docs, maints) => {
    const out = []
    const latest = {}
    for (const d of docs) if (!latest[d.doc_type] || d.expiry_date > latest[d.doc_type].expiry_date) latest[d.doc_type] = d
    for (const d of Object.values(latest)) {
      const left = daysUntil(d.expiry_date)
      const label = d.doc_type === 'soat' ? 'SOAT' : d.doc_type === 'tecnomecanica' ? 'Revisión tecnomecánica' : 'Póliza'
      if (left < 0) out.push({ kind: d.doc_type, level: 'bad', message: `${label} vencido hace ${-left} día${left === -1 ? '' : 's'}`, date: d.expiry_date })
      else if (left <= ALERT.docDays) out.push({ kind: d.doc_type, level: 'warn', message: `${label} vence en ${left} día${left === 1 ? '' : 's'}`, date: d.expiry_date })
    }
    if (!latest.soat) out.push({ kind: 'soat', level: 'bad', message: 'Sin SOAT registrado' })
    const prev = maints.filter((m) => m.type === 'preventivo').sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    if (prev) {
      if (prev.next_due_date) {
        const left = daysUntil(prev.next_due_date)
        if (left < 0) out.push({ kind: 'mantenimiento', level: 'bad', message: `Mantenimiento preventivo vencido hace ${-left} día${left === -1 ? '' : 's'}`, date: prev.next_due_date })
        else if (left <= ALERT.maintDays) out.push({ kind: 'mantenimiento', level: 'warn', message: `Mantenimiento preventivo en ${left} día${left === 1 ? '' : 's'}`, date: prev.next_due_date })
      }
      if (prev.next_due_km != null) {
        const leftKm = Number(prev.next_due_km) - Number(v.current_km)
        if (leftKm < 0) out.push({ kind: 'mantenimiento', level: 'bad', message: `Mantenimiento por kilometraje vencido (${Math.round(-leftKm)} km de más)` })
        else if (leftKm <= ALERT.maintKm) out.push({ kind: 'mantenimiento', level: 'warn', message: `Mantenimiento por kilometraje en ${Math.round(leftKm)} km` })
      }
    }
    return out
  }

  const VEH_SELECT = '*, site:sites!vehicles_site_id_fkey(name), owner_site:sites!vehicles_owner_site_id_fkey(name), assigned:users!vehicles_assigned_driver_id_fkey(id, name, last_name)'
  const loadFleet = async (site) => {
    const [v, d, m, open] = await Promise.all([
      applyScope(supabase.from('vehicles').select(VEH_SELECT), site).order('movil'),
      supabase.from('vehicle_documents').select('*'),
      supabase.from('vehicle_maintenances').select('id, vehicle_id, type, date, next_due_date, next_due_km'),
      supabase.from('vehicle_trips').select('id, code, vehicle_id, activity, started_at, driver:users!vehicle_trips_driver_id_fkey(name, last_name)').eq('status', 'abierto')
    ])
    for (const r of [v, d, m, open]) if (r.error) throw r.error
    return v.data.map((veh) => {
      const docs = d.data.filter((x) => x.vehicle_id === veh.id)
      const maints = m.data.filter((x) => x.vehicle_id === veh.id)
      const soat = docs.filter((x) => x.doc_type === 'soat').sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1))[0]
      const trip = open.data.find((t) => t.vehicle_id === veh.id)
      return {
        ...vehicleDTO(veh),
        soat: soat ? docDTO(soat) : null,
        alerts: veh.status === 'fuera_servicio' ? [] : alertsFor(veh, docs, maints),
        openTrip: trip ? { id: trip.id, code: trip.code, activity: trip.activity, startedAt: trip.started_at, driver: fullName(trip.driver) } : null
      }
    })
  }

  // ================================================================ Hoja de vida
  const validateVehicle = (b) => {
    const e = []
    if (!clean(b.movil)) e.push('El número de móvil es requerido')
    if (!clean(b.plate)) e.push('La placa es requerida')
    if (!clean(b.vehicleType)) e.push('El tipo de vehículo es requerido')
    const y = num(b.modelYear); if (y !== null && (Number.isNaN(y) || y < 1950 || y > 2100)) e.push('Año inválido')
    const km = num(b.initialKm); if (!isNum(km) || km < 0) e.push('Kilometraje inicial inválido')
    if (b.condition && !['nuevo', 'usado'].includes(b.condition)) e.push('Condición inválida')
    if (b.status && !['activo', 'mantenimiento', 'fuera_servicio'].includes(b.status)) e.push('Estado inválido')
    if (clean(b.purchaseDate) && !ISO_DATE.test(b.purchaseDate)) e.push('Fecha de compra inválida')
    return e
  }
  const vehicleRow = (b) => ({
    movil: clean(String(b.movil ?? '')).replace(/^m[oó]vil\s*/i, ''), plate: clean(b.plate).toUpperCase().replace(/\s+/g, ''),
    vehicle_type: clean(b.vehicleType), brand: clean(b.brand), line: clean(b.line), model_year: num(b.modelYear),
    color: clean(b.color), serial: clean(b.serial)?.toUpperCase() ?? null, engine_number: clean(b.engineNumber)?.toUpperCase() ?? null,
    owner: clean(b.owner), fuel_type: clean(b.fuelType), condition: b.condition || 'usado',
    purchase_date: clean(b.purchaseDate), status: b.status || 'activo', notes: clean(b.notes), updated_at: new Date().toISOString(),
    assigned_driver_id: Number(b.assignedDriverId) || null
  })

  app.get('/vehiculos/tipos', auth(FLEET_VIEW), (req, res) => res.send(TYPES))

  app.get('/vehiculos', auth(FLEET_VIEW), hx(async (req, res) => res.send(await loadFleet(scopeSite(req)))))

  app.get('/vehiculos/buscar', auth(FLEET_VIEW), hx(async (req, res) => {
    const v = clean(req.query.movil)?.replace(/^m[oó]vil\s*/i, '')
    if (!v) return fail(res, 'Ingresa el número de móvil', 400)
    // Se busca en todas las sedes: un conductor visitante puede tomar un vehículo de otra sede.
    const fleet = await loadFleet(null)
    const found = fleet.find((x) => x.movil.toLowerCase() === v.toLowerCase() || x.plate.toLowerCase() === v.toLowerCase().replace(/\s+/g, ''))
    if (!found) return fail(res, `No hay un vehículo con el móvil ${v}`, 404)
    if (!['administrador', 'conductor'].includes(req.user.role) && !canAccessSite(req, found.siteId)) return fail(res, `No hay un vehículo con el móvil ${v} en tu sede`, 404)
    res.send({ ...found, visitor: req.user.role !== 'administrador' && found.siteId !== req.user.site_id, blockers: await tripBlockers(found.id) })
  }))

  app.get('/vehiculos/conductores', auth(FLEET_VIEW), hx(async (req, res) => {
    const [{ data, error }, open] = await Promise.all([
      applyScope(supabase.from('users').select('id, name, last_name, identification, site_id, site:sites(name)').eq('role', 'conductor').eq('active', true), req.query.todas ? null : scopeSite(req)).order('name'),
      supabase.from('vehicle_trips').select('id, code, driver_id, vehicles(movil)').eq('status', 'abierto')
    ])
    if (error) throw error
    if (open.error) throw open.error
    res.send(data.map((u) => {
      const t = open.data.find((x) => x.driver_id === u.id)
      return { id: u.id, name: fullName(u), identification: u.identification, siteId: u.site_id, siteName: u.site?.name, openTrip: t ? { id: t.id, code: t.code, movil: t.vehicles?.movil } : null }
    }))
  }))

  // Servicios existentes para asociar al reporte: solo los eventos de Socorro que están en curso.
  app.get('/vehiculos/actividades', auth(TRIP_ROLES), hx(async (req, res) => {
    // Servicios en curso de la sede del vehículo (?vehiculoSede=) o de la sede del usuario.
    const { data, error } = await applyScope(supabase.from('gso_events').select('id, code, name, place, status, started_at'), Number(req.query.vehiculoSede) || scopeSite(req))
      .eq('status', 'en_curso').order('started_at', { ascending: false }).limit(100)
    if (error) throw error
    res.send(data.map((e) => ({ id: e.id, code: e.code, name: e.name, place: e.place, status: e.status, startedAt: e.started_at })))
  }))

  app.get('/vehiculos/:id', auth(FLEET_VIEW), hx(async (req, res) => {
    const id = Number(req.params.id)
    const [v, d, m, t] = await Promise.all([
      supabase.from('vehicles').select(VEH_SELECT).eq('id', id).maybeSingle(),
      supabase.from('vehicle_documents').select('*').eq('vehicle_id', id).order('expiry_date', { ascending: false }),
      supabase.from('vehicle_maintenances').select('*, driver:users!vehicle_maintenances_driver_id_fkey(id, name, last_name), vehicle_maintenance_parts(*)').eq('vehicle_id', id).order('date', { ascending: false }),
      supabase.from('vehicle_trips').select(TRIP_SELECT).eq('vehicle_id', id).order('started_at', { ascending: false }).limit(15)
    ])
    for (const r of [v, d, m, t]) if (r.error) throw r.error
    if (!v.data || !canAccessSite(req, v.data.site_id)) return fail(res, 'Vehículo no encontrado', 404)
    const maints = m.data.map(maintDTO)
    res.send({
      ...vehicleDTO(v.data),
      documents: d.data.map(docDTO),
      maintenances: maints,
      trips: t.data.map(tripDTO),
      alerts: v.data.status === 'fuera_servicio' ? [] : alertsFor(v.data, d.data, m.data),
      totals: {
        maintenance: maints.reduce((a, x) => a + x.total, 0),
        preventive: maints.filter((x) => x.type === 'preventivo').reduce((a, x) => a + x.total, 0),
        corrective: maints.filter((x) => x.type === 'correctivo').reduce((a, x) => a + x.total, 0),
        documents: d.data.reduce((a, x) => a + Number(x.price || 0), 0),
        kmTraveled: Number(v.data.current_km) - Number(v.data.initial_km)
      }
    })
  }))

  const checkAssigned = async (b) => {
    if (!Number(b.assignedDriverId)) return null
    const { data: u } = await supabase.from('users').select('role, active').eq('id', Number(b.assignedDriverId)).maybeSingle()
    return u && u.role === 'conductor' && u.active ? null : 'El conductor asignado no es válido'
  }
  app.post('/vehiculos', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const errors = validateVehicle(b)
    const ae = await checkAssigned(b); if (ae) errors.push(ae)
    if (errors.length) return fail(res, errors.join('. '), 400)
    const row = vehicleRow(b)
    row.initial_km = b.condition === 'nuevo' ? 0 : num(b.initialKm)
    row.current_km = row.initial_km
    // Propiedad de la Seccional; adscrito a la sede indicada.
    row.site_id = await targetSite(req, b.siteId)
    const { data: own } = await supabase.from('sites').select('id').eq('type', 'seccional').order('id').limit(1)
    row.owner_site_id = Number(b.ownerSiteId) || own[0].id
    const { data, error } = await supabase.from('vehicles').insert(row).select(VEH_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un vehículo con ese número de móvil o placa', 409); throw error }
    res.status(201).send(vehicleDTO(data))
  }))

  app.put('/vehiculos/:id', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const errors = validateVehicle(b)
    const ae = await checkAssigned(b); if (ae) errors.push(ae)
    if (errors.length) return fail(res, errors.join('. '), 400)
    const id = Number(req.params.id)
    const { data: cur } = await supabase.from('vehicles').select('*').eq('id', id).maybeSingle()
    if (!cur) return fail(res, 'Vehículo no encontrado', 404)
    const row = vehicleRow(b)
    // El km inicial solo se puede corregir mientras no haya reportes.
    const { count } = await supabase.from('vehicle_trips').select('id', { count: 'exact', head: true }).eq('vehicle_id', id)
    const newInitial = b.condition === 'nuevo' ? 0 : num(b.initialKm)
    if (newInitial !== Number(cur.initial_km)) {
      if (count) return fail(res, 'El kilometraje inicial no se puede cambiar porque el vehículo ya tiene reportes', 400)
      row.initial_km = newInitial; row.current_km = newInitial
    }
    if (Number(b.siteId)) {
      if (Number(b.siteId) !== cur.site_id) {
        const { data: busy } = await supabase.from('vehicle_trips').select('code').eq('vehicle_id', id).eq('status', 'abierto').maybeSingle()
        if (busy) return fail(res, `No se puede cambiar la sede: el vehículo tiene la actividad ${busy.code} abierta`, 400)
      }
      row.site_id = Number(b.siteId)
    }
    const { data, error } = await supabase.from('vehicles').update(row).eq('id', id).select(VEH_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un vehículo con ese número de móvil o placa', 409); throw error }
    res.send(vehicleDTO(data))
  }))

  app.delete('/vehiculos/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count } = await supabase.from('vehicle_trips').select('id', { count: 'exact', head: true }).eq('vehicle_id', id)
    if (count) return fail(res, 'El vehículo tiene reportes diarios. Márcalo como "fuera de servicio" en lugar de eliminarlo.', 409)
    const { data: v } = await supabase.from('vehicles').select('*').eq('id', id).maybeSingle()
    if (!v) return fail(res, 'Vehículo no encontrado', 404)
    const { error } = await supabase.from('vehicles').delete().eq('id', id)
    if (error) throw error
    for (const col of Object.values(PHOTO_SLOTS)) await removeStoredFile('vehicles', v[col])
    res.send({ message: 'Vehículo eliminado' })
  }))

  app.post('/vehiculos/:id/fotos', auth(ADMIN), hx(async (req, res) => {
    const col = PHOTO_SLOTS[req.body?.slot]
    if (!col) return fail(res, 'Posición de foto inválida', 400)
    const id = Number(req.params.id)
    const { data: v } = await supabase.from('vehicles').select('*').eq('id', id).maybeSingle()
    if (!v) return fail(res, 'Vehículo no encontrado', 404)
    const url = await uploadImage('vehicles', `vehiculo-${id}-${req.body.slot}`, req.body?.image, IMG)
    if (!url) return fail(res, 'Imagen inválida (PNG, JPG o WEBP de máximo 2 MB)', 400)
    const { data, error } = await supabase.from('vehicles').update({ [col]: url, updated_at: new Date().toISOString() }).eq('id', id).select('*').single()
    if (error) throw error
    await removeStoredFile('vehicles', v[col])
    res.send(vehicleDTO(data))
  }))

  app.delete('/vehiculos/:id/fotos/:slot', auth(ADMIN), hx(async (req, res) => {
    const col = PHOTO_SLOTS[req.params.slot]
    if (!col) return fail(res, 'Posición de foto inválida', 400)
    const { data: v } = await supabase.from('vehicles').select('*').eq('id', Number(req.params.id)).maybeSingle()
    if (!v) return fail(res, 'Vehículo no encontrado', 404)
    const { data } = await supabase.from('vehicles').update({ [col]: null }).eq('id', v.id).select('*').single()
    await removeStoredFile('vehicles', v[col])
    res.send(vehicleDTO(data))
  }))

  // ---------- Documentos (SOAT y otros con vencimiento) ----------
  const docRow = (b) => {
    const e = []
    if (!['soat', 'tecnomecanica', 'poliza', 'otro'].includes(b.docType || 'soat')) e.push('Tipo de documento inválido')
    if (!ISO_DATE.test(b.expiryDate || '')) e.push('La fecha de vencimiento es requerida')
    if (clean(b.purchaseDate) && !ISO_DATE.test(b.purchaseDate)) e.push('Fecha de compra inválida')
    if (clean(b.purchaseDate) && b.expiryDate && b.purchaseDate > b.expiryDate) e.push('La compra no puede ser posterior al vencimiento')
    const price = num(b.price); if (price !== null && (Number.isNaN(price) || price < 0)) e.push('Precio inválido')
    if (e.length) throw httpError(400, e.join('. '))
    return { doc_type: b.docType || 'soat', entity: clean(b.entity), number: clean(b.number), purchase_date: clean(b.purchaseDate), expiry_date: b.expiryDate, price, notes: clean(b.notes) }
  }
  app.post('/vehiculos/:id/documentos', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('vehicle_documents').insert({ ...docRow(req.body || {}), vehicle_id: Number(req.params.id) }).select('*').single()
    if (error) throw error
    res.status(201).send(docDTO(data))
  }))
  app.put('/vehiculos/:id/documentos/:did', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('vehicle_documents').update(docRow(req.body || {})).eq('id', Number(req.params.did)).eq('vehicle_id', Number(req.params.id)).select('*').maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 'Documento no encontrado', 404)
    res.send(docDTO(data))
  }))
  app.delete('/vehiculos/:id/documentos/:did', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('vehicle_documents').delete().eq('id', Number(req.params.did)).eq('vehicle_id', Number(req.params.id))
    if (error) throw error
    res.send({ message: 'Documento eliminado' })
  }))

  // ---------- Mantenimientos ----------
  const saveMaintenance = async (vehicleId, b, userId, existingId) => {
    const e = []
    if (!['preventivo', 'correctivo'].includes(b.type)) e.push('Tipo de mantenimiento inválido')
    if (!ISO_DATE.test(b.date || '')) e.push('La fecha es requerida')
    if (!clean(b.description)) e.push('Describe el mantenimiento')
    const labor = num(b.laborCost) ?? 0; if (Number.isNaN(labor) || labor < 0) e.push('Costo de mano de obra inválido')
    const km = num(b.km); if (km !== null && (Number.isNaN(km) || km < 0)) e.push('Kilometraje inválido')
    if (clean(b.nextDueDate) && !ISO_DATE.test(b.nextDueDate)) e.push('Fecha del próximo mantenimiento inválida')
    const nextKm = num(b.nextDueKm); if (nextKm !== null && Number.isNaN(nextKm)) e.push('Km del próximo mantenimiento inválido')
    const parts = (b.parts || []).filter((p) => clean(p.name))
    for (const p of parts) if (!(Number(p.quantity) > 0) || Number(p.unitPrice) < 0 || Number.isNaN(Number(p.unitPrice))) e.push(`Revisa cantidad y precio de "${p.name}"`)
    // Conductor responsable de llevar el vehículo: debe estar disponible (sin actividad abierta).
    if (b.driverId) {
      const driverId = Number(b.driverId)
      let unchanged = false
      if (existingId) {
        const { data: cur } = await supabase.from('vehicle_maintenances').select('driver_id').eq('id', existingId).maybeSingle()
        unchanged = cur?.driver_id === driverId
      }
      const { data: u } = await supabase.from('users').select('id, role, active, name, last_name').eq('id', driverId).maybeSingle()
      if (!u || u.role !== 'conductor' || !u.active) e.push('El conductor responsable debe ser un conductor activo')
      else if (!unchanged) {
        const { data: busy } = await supabase.from('vehicle_trips').select('code, vehicles(movil)').eq('driver_id', driverId).eq('status', 'abierto').maybeSingle()
        if (busy) e.push(`${fullName(u)} no está disponible: tiene la Móvil ${busy.vehicles?.movil} en actividad (${busy.code})`)
      }
    }
    if (e.length) throw httpError(400, e.join('. '))
    const partsCost = parts.reduce((a, p) => a + Number(p.quantity) * Number(p.unitPrice), 0)
    const row = {
      vehicle_id: vehicleId, type: b.type, date: b.date, km, description: clean(b.description), workshop: clean(b.workshop),
      technician: clean(b.technician), driver_id: b.driverId ? Number(b.driverId) : null, labor_cost: labor, parts_cost: partsCost,
      next_due_date: b.type === 'preventivo' ? clean(b.nextDueDate) : null, next_due_km: b.type === 'preventivo' ? nextKm : null, notes: clean(b.notes)
    }
    let id = existingId
    if (existingId) {
      const { error } = await supabase.from('vehicle_maintenances').update(row).eq('id', existingId).eq('vehicle_id', vehicleId)
      if (error) throw error
      await supabase.from('vehicle_maintenance_parts').delete().eq('maintenance_id', existingId)
    } else {
      const { data, error } = await supabase.from('vehicle_maintenances').insert({ ...row, created_by: userId }).select('id').single()
      if (error) throw error
      id = data.id
    }
    if (parts.length) {
      const { error } = await supabase.from('vehicle_maintenance_parts').insert(parts.map((p) => ({ maintenance_id: id, name: clean(p.name), quantity: Number(p.quantity), unit_price: Number(p.unitPrice) })))
      if (error) throw error
    }
    const { data } = await supabase.from('vehicle_maintenances').select('*, driver:users!vehicle_maintenances_driver_id_fkey(id, name, last_name), vehicle_maintenance_parts(*)').eq('id', id).single()
    return maintDTO(data)
  }
  app.post('/vehiculos/:id/mantenimientos', auth(ADMIN), hx(async (req, res) => res.status(201).send(await saveMaintenance(Number(req.params.id), req.body || {}, req.user.id))))
  app.put('/vehiculos/:id/mantenimientos/:mid', auth(ADMIN), hx(async (req, res) => res.send(await saveMaintenance(Number(req.params.id), req.body || {}, req.user.id, Number(req.params.mid)))))
  app.delete('/vehiculos/:id/mantenimientos/:mid', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('vehicle_maintenances').delete().eq('id', Number(req.params.mid)).eq('vehicle_id', Number(req.params.id))
    if (error) throw error
    res.send({ message: 'Mantenimiento eliminado' })
  }))

  // ================================================================ Reportes diarios
  const loadTrip = async (id) => {
    const { data, error } = await supabase.from('vehicle_trips').select(TRIP_SELECT).eq('id', Number(id)).maybeSingle()
    if (error) throw error
    if (!data) throw httpError(404, 'Reporte no encontrado')
    return data
  }
  const canSeeTrip = (t, user) => user.role === 'administrador' || t.driver_id === user.id

  app.get('/vehiculos-reportes', auth(TRIP_ROLES), hx(async (req, res) => {
    const desde = clean(req.query.desde); const hasta = clean(req.query.hasta)
    if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
    // El conductor ve todos sus reportes (también los que hizo como visitante en otra sede).
    let q = applyScope(supabase.from('vehicle_trips').select(TRIP_SELECT), req.user.role === 'conductor' ? null : scopeSite(req)).order('started_at', { ascending: false }).limit(300)
    if (req.user.role !== 'administrador') q = q.eq('driver_id', req.user.id) // el conductor ve solo los suyos
    else if (req.query.conductor) q = q.eq('driver_id', Number(req.query.conductor))
    if (req.query.vehiculo) q = q.eq('vehicle_id', Number(req.query.vehiculo))
    if (req.query.estado) q = q.eq('status', req.query.estado)
    if (desde) q = q.gte('started_at', `${desde}T00:00:00${TZ_OFFSET}`)
    if (hasta) q = q.lte('started_at', `${hasta}T23:59:59${TZ_OFFSET}`)
    const { data, error } = await q
    if (error) throw error
    res.send(data.map(tripDTO))
  }))

  app.get('/vehiculos-reportes/:id', auth(TRIP_ROLES), hx(async (req, res) => {
    const t = await loadTrip(req.params.id)
    if (!canSeeTrip(t, req.user)) return fail(res, 'No tienes acceso a este reporte', 403)
    res.send(tripDTO(t))
  }))

  // Bloqueos para registrar servicios: SOAT vencido o que vence en 2 días o menos, y preoperacional de hoy NO APTO.
  const SOAT_BLOCK_DAYS = 2
  const tripBlockers = async (vehicleId) => {
    const [{ data: soats }, { data: pre }] = await Promise.all([
      supabase.from('vehicle_documents').select('expiry_date').eq('vehicle_id', vehicleId).eq('doc_type', 'soat').order('expiry_date', { ascending: false }).limit(1),
      supabase.from('vehicle_inspections').select('code, result, anomalies').eq('vehicle_id', vehicleId).eq('inspection_date', todayBogota()).order('inspected_at', { ascending: false }).limit(1)
    ])
    const out = []
    const soat = soats?.[0]
    if (!soat) out.push('El vehículo no tiene SOAT registrado')
    else {
      const left = daysUntil(soat.expiry_date)
      if (left < 0) out.push(`El SOAT está vencido desde el ${soat.expiry_date.split('-').reverse().join('/')}`)
      else if (left <= SOAT_BLOCK_DAYS) out.push(`El SOAT vence ${left === 0 ? 'hoy' : `en ${left} día${left === 1 ? '' : 's'}`} (${soat.expiry_date.split('-').reverse().join('/')}). Renuévalo antes de registrar servicios`)
    }
    if (pre?.[0]?.result === 'no_apto') out.push(`El preoperacional de hoy (${pre[0].code}) quedó NO APTO con ${pre[0].anomalies} anomalía${pre[0].anomalies === 1 ? '' : 's'}`)
    return out
  }

  // Abrir reporte: km de salida = km actual del vehículo; hora de salida automática.
  // Solo el conductor abre reportes diarios (el administrador los consulta).
  app.post('/vehiculos-reportes', auth(['conductor']), hx(async (req, res) => {
    const b = req.body || {}
    const { data: v } = await supabase.from('vehicles').select('*').eq('id', Number(b.vehicleId)).maybeSingle()
    if (!v) return fail(res, 'Busca el vehículo por su número de móvil', 400)
    if (v.status === 'fuera_servicio') return fail(res, 'El vehículo está fuera de servicio', 400)
    const driverId = req.user.id
    const blockers = await tripBlockers(v.id)
    if (blockers.length) return fail(res, `No se puede registrar el servicio con la Móvil ${v.movil}: ${blockers.join('. ')}.`, 409)
    // Un conductor solo puede tener una actividad abierta (un vehículo a la vez).
    const { data: busy } = await supabase.from('vehicle_trips').select('code, vehicles(movil)').eq('driver_id', driverId).eq('status', 'abierto').maybeSingle()
    if (busy) {
      const who = driverId === req.user.id ? 'Ya tienes' : 'El conductor ya tiene'
      return fail(res, `${who} la Móvil ${busy.vehicles?.movil} en actividad (${busy.code}). Debe cerrarla antes de tomar otro vehículo.`, 409)
    }
    let activity = clean(b.activity); let eventId = null
    if (b.eventId) {
      const { data: ev } = await supabase.from('gso_events').select('id, name, status, site_id').eq('id', Number(b.eventId)).maybeSingle()
      if (!ev || ev.site_id !== v.site_id) return fail(res, 'La actividad seleccionada no existe en la sede del vehículo', 400)
      if (ev.status !== 'en_curso') return fail(res, 'Ese servicio ya finalizó; elige uno en curso o registra una actividad nueva', 400)
      eventId = ev.id; activity = activity || ev.name
    }
    // Traslado asistencial: solo en ambulancias TAB/TAM y como actividad nueva.
    let transfer = null
    if (b.transfer) {
      if (!ambulanceType(v.vehicle_type)) return fail(res, 'Los traslados asistenciales solo se registran en ambulancias TAB o TAM', 400)
      if (eventId) return fail(res, 'Un traslado asistencial se registra como actividad nueva, no asociado a un servicio', 400)
      const te = validateTransfer(b.transfer)
      if (te.length) return fail(res, te.join('. '), 400)
      transfer = transferRow(b.transfer)
      activity = `Traslado asistencial ${ambulanceType(v.vehicle_type)}: ${transfer.patient_name} → ${transfer.destination}`
    }
    if (!activity) return fail(res, 'Selecciona una actividad o servicio, o escribe una nueva', 400)
    const { data, error } = await supabase.from('vehicle_trips').insert({
      vehicle_id: v.id, driver_id: driverId, event_id: eventId, activity, km_out: Number(v.current_km), observation: clean(b.observation), created_by: req.user.id, site_id: v.site_id
    }).select('id').single()
    if (error) {
      if (error.code === '23505') {
        return fail(res, /per_driver/.test(error.message) ? 'El conductor ya tiene un vehículo en actividad. Debe cerrarla antes de tomar otro.' : `La móvil ${v.movil} ya tiene una actividad abierta. Ciérrala antes de iniciar otra.`, 409)
      }
      throw error
    }
    if (transfer) {
      const { error: tErr } = await supabase.from('vehicle_transfers').insert({ ...transfer, trip_id: data.id })
      if (tErr) { await supabase.from('vehicle_trips').delete().eq('id', data.id); throw tErr }
    }
    const trip = tripDTO(await loadTrip(data.id))
    res.status(201).send(trip)
    deps.notify?.('vehicular', deps.notifyMsg().viaje(trip, 'iniciada'))
  }))

  // Cerrar: km de llegada (tacómetro), foto del tacómetro, combustible y foto del ticket.
  app.post('/vehiculos-reportes/:id/cerrar', auth(TRIP_ROLES), hx(async (req, res) => {
    const t = await loadTrip(req.params.id)
    if (!canSeeTrip(t, req.user)) return fail(res, 'Solo el conductor del reporte o un administrador puede cerrarlo', 403)
    if (t.status !== 'abierto') return fail(res, 'El reporte ya está cerrado', 400)
    // Si la actividad está asociada a un servicio de Socorro, solo se cierra cuando ese servicio ya finalizó.
    if (t.event_id) {
      const { data: ev } = await supabase.from('gso_events').select('code, name, status').eq('id', t.event_id).maybeSingle()
      if (ev && ev.status === 'en_curso') return fail(res, `El servicio ${ev.code} · ${ev.name} sigue en curso. La actividad del vehículo se podrá cerrar cuando el coordinador finalice el servicio.`, 409)
    }
    const b = req.body || {}
    const kmIn = num(b.kmIn)
    if (!isNum(kmIn)) return fail(res, 'Ingresa el kilometraje de llegada', 400)
    if (kmIn < Number(t.km_out)) return fail(res, `El km de llegada no puede ser menor al de salida (${Number(t.km_out)})`, 400)
    if (kmIn - Number(t.km_out) > 3000) return fail(res, 'La diferencia de kilometraje es demasiado alta; revisa el valor', 400)
    if (!b.tachometerImage) return fail(res, 'La foto del tacómetro es obligatoria como evidencia', 400)
    const fuel = num(b.fuelValue)
    if (fuel !== null && (Number.isNaN(fuel) || fuel < 0)) return fail(res, 'Valor de combustible inválido', 400)
    if (fuel && !b.fuelTicketImage) return fail(res, 'Adjunta la foto del ticket del tanqueo', 400)
    const gallons = num(b.fuelGallons)
    const tach = await uploadImage('vehicles', `tacometro-${t.code}`, b.tachometerImage, IMG)
    if (!tach) return fail(res, 'Foto del tacómetro inválida', 400)
    const ticket = fuel && b.fuelTicketImage ? await uploadImage('vehicles', `ticket-${t.code}`, b.fuelTicketImage, IMG) : null
    if (fuel && !ticket) return fail(res, 'Foto del ticket inválida', 400)
    const { error } = await supabase.from('vehicle_trips').update({
      status: 'cerrado', ended_at: new Date().toISOString(), km_in: kmIn, tachometer_photo: tach,
      fuel_value: fuel || null, fuel_gallons: fuel ? gallons : null, fuel_ticket_photo: ticket,
      observation: b.observation !== undefined ? clean(b.observation) : t.observation, updated_at: new Date().toISOString()
    }).eq('id', t.id)
    if (error) throw error
    // El km de llegada pasa a ser el km actual del vehículo.
    await supabase.from('vehicles').update({ current_km: kmIn, updated_at: new Date().toISOString() }).eq('id', t.vehicle_id)
    const closedTrip = tripDTO(await loadTrip(t.id))
    res.send(closedTrip)
    deps.notify?.('vehicular', deps.notifyMsg().viaje(closedTrip, 'cerrada'))
  }))

  app.put('/vehiculos-reportes/:id', auth(TRIP_ROLES), hx(async (req, res) => {
    const t = await loadTrip(req.params.id)
    if (!canSeeTrip(t, req.user)) return fail(res, 'No tienes acceso a este reporte', 403)
    if (t.status !== 'abierto' && req.user.role !== 'administrador') return fail(res, 'El reporte ya está cerrado', 400)
    const activity = clean(req.body?.activity)
    if (!activity) return fail(res, 'La actividad es requerida', 400)
    await supabase.from('vehicle_trips').update({ activity, observation: clean(req.body?.observation), updated_at: new Date().toISOString() }).eq('id', t.id)
    res.send(tripDTO(await loadTrip(t.id)))
  }))

  // Eliminar: abiertos (conductor dueño o admin); cerrados solo admin y si es el último del vehículo (revierte el km).
  app.delete('/vehiculos-reportes/:id', auth(TRIP_ROLES), hx(async (req, res) => {
    const t = await loadTrip(req.params.id)
    if (!canSeeTrip(t, req.user)) return fail(res, 'No tienes acceso a este reporte', 403)
    if (t.status === 'cerrado') {
      if (req.user.role !== 'administrador') return fail(res, 'Solo un administrador puede eliminar reportes cerrados', 403)
      const { data: last } = await supabase.from('vehicle_trips').select('id').eq('vehicle_id', t.vehicle_id).eq('status', 'cerrado').order('ended_at', { ascending: false }).limit(1)
      if (last[0]?.id !== t.id) return fail(res, 'Solo se puede eliminar el último reporte cerrado del vehículo (para no descuadrar el kilometraje)', 400)
      await supabase.from('vehicles').update({ current_km: Number(t.km_out) }).eq('id', t.vehicle_id)
    }
    await supabase.from('vehicle_trips').delete().eq('id', t.id)
    await removeStoredFile('vehicles', t.tachometer_photo)
    await removeStoredFile('vehicles', t.fuel_ticket_photo)
    res.send({ message: 'Reporte eliminado' })
  }))

  // ================================================================ Traslado asistencial (IPS · Ambulancias TAB/TAM)
  // El admin ve todas las ambulancias (o las de la sede filtrada); el conductor, la ambulancia que tiene asignada.
  app.get('/ambulancias-dashboard', auth(['administrador', 'conductor']), hx(async (req, res) => {
    const today = todayBogota()
    const ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : today.slice(0, 7)
    const [y, mo] = ym.split('-').map(Number)
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
    const sixAgo = new Date(Date.UTC(y, mo - 6, 1)).toISOString().slice(0, 10)
    const driver = req.user.role === 'conductor'
    let fleet = (await loadFleet(driver ? null : scopeSite(req))).filter((v) => v.isAmbulance)
    if (driver) fleet = fleet.filter((v) => v.assignedDriverId === req.user.id)
    const ids = fleet.map((v) => v.id)
    const empty = { data: [] }
    const [trips, preops] = await Promise.all([
      ids.length ? supabase.from('vehicle_trips').select('id, code, vehicle_id, driver_id, activity, status, started_at, ended_at, km_diff, fuel_value, vehicle_transfers(*), driver:users!vehicle_trips_driver_id_fkey(name, last_name)')
        .in('vehicle_id', ids).gte('started_at', `${sixAgo}T00:00:00${TZ_OFFSET}`).lt('started_at', `${next}T00:00:00${TZ_OFFSET}`).order('started_at', { ascending: false }) : empty,
      ids.length ? supabase.from('vehicle_inspections').select('id, code, vehicle_id, result, anomalies, inspected_at, inspection_date').in('vehicle_id', ids).order('inspected_at', { ascending: false }).limit(200) : empty
    ])
    for (const r of [trips, preops]) if (r.error) throw r.error
    const monthKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)).slice(0, 7)
    const tr = (t) => (Array.isArray(t.vehicle_transfers) ? t.vehicle_transfers[0] : t.vehicle_transfers) || null
    const all = trips.data
    const month = all.filter((t) => monthKey(t.started_at) === ym)
    const transfers = month.filter((t) => tr(t))
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, mo - 1 - i, 1)); const key = d.toISOString().slice(0, 7)
      const ts = all.filter((t) => monthKey(t.started_at) === key)
      months.push({ key, label: new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(d).replace('.', ''),
        TAB: ts.filter((t) => tr(t) && fleet.find((v) => v.id === t.vehicle_id)?.ambulanceType === 'TAB').length,
        TAM: ts.filter((t) => tr(t) && fleet.find((v) => v.id === t.vehicle_id)?.ambulanceType === 'TAM').length,
        other: ts.filter((t) => !tr(t)).length })
    }
    const count = (arr, f) => Object.entries(arr.reduce((a, x) => { const k = f(x); if (k) a[k] = (a[k] || 0) + 1; return a }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
    const ambulances = fleet.map((v) => {
      const ts = month.filter((t) => t.vehicle_id === v.id)
      const pre = preops.data.find((p) => p.vehicle_id === v.id)
      return {
        id: v.id, movil: v.movil, plate: v.plate, ambulanceType: v.ambulanceType, vehicleType: v.vehicleType, brand: v.brand, line: v.line, status: v.status,
        siteName: v.siteName, currentKm: v.currentKm, assignedDriverName: v.assignedDriverName, photo: v.photos.front, alerts: v.alerts, openTrip: v.openTrip, soat: v.soat,
        month: { transfers: ts.filter((t) => tr(t)).length, activities: ts.filter((t) => !tr(t)).length, km: ts.reduce((a, t) => a + Number(t.km_diff || 0), 0), fuel: ts.reduce((a, t) => a + Number(t.fuel_value || 0), 0) },
        lastPreop: pre ? { id: pre.id, code: pre.code, result: pre.result, anomalies: pre.anomalies, date: pre.inspection_date, today: pre.inspection_date === today } : null
      }
    })
    res.send({
      month: ym, driverView: driver,
      kpis: {
        ambulances: fleet.length, tab: fleet.filter((v) => v.ambulanceType === 'TAB').length, tam: fleet.filter((v) => v.ambulanceType === 'TAM').length,
        available: fleet.filter((v) => v.status === 'activo' && !v.openTrip).length, inService: fleet.filter((v) => v.openTrip).length,
        outOfService: fleet.filter((v) => v.status !== 'activo').length,
        transfers: transfers.length, urgent: transfers.filter((t) => tr(t).priority === 'urgente').length,
        km: month.reduce((a, t) => a + Number(t.km_diff || 0), 0), fuel: month.reduce((a, t) => a + Number(t.fuel_value || 0), 0),
        alerts: fleet.reduce((a, v) => a + v.alerts.length, 0), preopToday: ambulances.filter((a) => a.lastPreop?.today).length
      },
      ambulances,
      byMonth: months,
      byPriority: count(transfers, (t) => tr(t).priority),
      byType: count(transfers, (t) => tr(t).transfer_type),
      byEps: count(transfers, (t) => tr(t).eps).slice(0, 8),
      byDestination: count(transfers, (t) => tr(t).destination).slice(0, 6),
      recent: all.filter((t) => tr(t)).slice(0, 12).map((t) => {
        const x = tr(t); const v = fleet.find((f) => f.id === t.vehicle_id)
        return { id: t.id, code: t.code, status: t.status, startedAt: t.started_at, movil: v?.movil, ambulanceType: v?.ambulanceType, driver: fullName(t.driver),
          patientName: x.patient_name, document: `${x.document_type} ${x.document}`, eps: x.eps, origin: x.origin, destination: x.destination, priority: x.priority, transferType: x.transfer_type, kmDiff: t.km_diff == null ? null : Number(t.km_diff) }
      })
    })
  }))

  // ================================================================ Dashboard de flota
  app.get('/vehiculos-dashboard', auth(DASH_ROLES), hx(async (req, res) => {
    const today = todayBogota()
    const ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : today.slice(0, 7)
    const [y, mo] = ym.split('-').map(Number)
    const start = `${ym}-01`
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
    const sixAgo = new Date(Date.UTC(y, mo - 6, 1)).toISOString().slice(0, 10)
    const driverOnly = req.user.role === 'conductor'

    const site = scopeSite(req)
    const [fleet, trips, maints] = await Promise.all([
      loadFleet(site),
      applyScope(supabase.from('vehicle_trips').select('id, code, vehicle_id, driver_id, activity, status, started_at, ended_at, km_diff, fuel_value, vehicles(movil, plate), driver:users!vehicle_trips_driver_id_fkey(name, last_name)')
        .gte('started_at', `${sixAgo}T00:00:00${TZ_OFFSET}`).lt('started_at', `${next}T00:00:00${TZ_OFFSET}`), site).order('started_at', { ascending: false }),
      supabase.from('vehicle_maintenances').select('vehicle_id, type, date, labor_cost, parts_cost').gte('date', sixAgo).lt('date', next)
    ])
    for (const r of [trips, maints]) if (r.error) throw r.error
    const fleetIds = new Set(fleet.map((v) => v.id))
    maints.data = maints.data.filter((m) => fleetIds.has(m.vehicle_id))

    const monthKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)).slice(0, 7)
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, mo - 1 - i, 1))
      months.push({ key: d.toISOString().slice(0, 7), label: new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(d).replace('.', ''), km: 0, fuel: 0, maintenance: 0 })
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]))
    for (const t of trips.data) { const m = byKey[monthKey(t.started_at)]; if (m) { m.km += Number(t.km_diff || 0); m.fuel += Number(t.fuel_value || 0) } }
    for (const mt of maints.data) { const m = byKey[mt.date.slice(0, 7)]; if (m) m.maintenance += Number(mt.labor_cost) + Number(mt.parts_cost) }

    const monthTrips = trips.data.filter((t) => monthKey(t.started_at) === ym)
    const kmByVehicle = fleet.map((v) => ({
      name: `Móvil ${v.movil}`, plate: v.plate,
      km: monthTrips.filter((t) => t.vehicle_id === v.id).reduce((a, t) => a + Number(t.km_diff || 0), 0),
      trips: monthTrips.filter((t) => t.vehicle_id === v.id).length
    }))
    const monthMaint = maints.data.filter((m) => m.date.slice(0, 7) === ym)
    const alerts = fleet.flatMap((v) => v.alerts.map((a) => ({ ...a, vehicleId: v.id, movil: v.movil, plate: v.plate })))
      .sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1))
    let mine = monthTrips.filter((t) => t.driver_id === req.user.id)
    let mineOpen = trips.data.filter((t) => t.driver_id === req.user.id && t.status === 'abierto')
    if (driverOnly) { // incluye lo que hizo como visitante en otras sedes
      const { data: own } = await supabase.from('vehicle_trips').select('id, code, vehicle_id, driver_id, activity, status, started_at, ended_at, km_diff, fuel_value, vehicles(movil, plate), driver:users!vehicle_trips_driver_id_fkey(name, last_name)')
        .eq('driver_id', req.user.id).gte('started_at', `${sixAgo}T00:00:00${TZ_OFFSET}`).order('started_at', { ascending: false })
      mine = (own || []).filter((t) => monthKey(t.started_at) === ym)
      mineOpen = (own || []).filter((t) => t.status === 'abierto')
      trips.data = own || []
    }
    const tripRow = (t) => ({
      id: t.id, code: t.code, activity: t.activity, status: t.status, startedAt: t.started_at, endedAt: t.ended_at,
      kmDiff: t.km_diff == null ? null : Number(t.km_diff), fuelValue: t.fuel_value == null ? null : Number(t.fuel_value),
      movil: t.vehicles?.movil, plate: t.vehicles?.plate, driver: fullName(t.driver), mine: t.driver_id === req.user.id
    })

    res.send({
      month: ym,
      thresholds: ALERT,
      kpis: {
        vehicles: fleet.length,
        active: fleet.filter((v) => v.status === 'activo').length,
        inService: fleet.filter((v) => v.openTrip).length,
        monthKm: monthTrips.reduce((a, t) => a + Number(t.km_diff || 0), 0),
        monthTrips: monthTrips.length,
        monthFuel: monthTrips.reduce((a, t) => a + Number(t.fuel_value || 0), 0),
        monthMaintenance: monthMaint.reduce((a, m) => a + Number(m.labor_cost) + Number(m.parts_cost), 0),
        alerts: alerts.length
      },
      mine: driverOnly || req.user.role === 'administrador' ? {
        trips: mine.length, km: mine.reduce((a, t) => a + Number(t.km_diff || 0), 0), fuel: mine.reduce((a, t) => a + Number(t.fuel_value || 0), 0),
        open: mineOpen.map(tripRow)
      } : null,
      alerts,
      fleet: fleet.map((v) => ({ id: v.id, movil: v.movil, plate: v.plate, vehicleType: v.vehicleType, brand: v.brand, line: v.line, status: v.status, currentKm: v.currentKm, photo: v.photos.front, soat: v.soat, openTrip: v.openTrip, alerts: v.alerts.length })),
      byMonth: months,
      kmByVehicle,
      // El invitado y el empleado ven agregados; los reportes individuales son del admin y de cada conductor.
      recentTrips: req.user.role === 'administrador' ? trips.data.slice(0, 8).map(tripRow) : driverOnly ? trips.data.filter((t) => t.driver_id === req.user.id).slice(0, 8).map(tripRow) : []
    })
  }))
}
