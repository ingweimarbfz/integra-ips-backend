// =====================================================================
// Módulo IPS · Hoja de vida de equipos
// Biomédicos, refrigeración (neveras de vacunas), climatización, eléctricos…
// Ficha técnica, garantía, estado, stock y mantenimientos con responsable.
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, uploadImage, removeStoredFile, scopeSite, applyScope, canAccessSite, targetSite } = deps
  // El empleado ve los equipos si su sede tiene al menos un servicio de IPS activo.
  const siteHasEquipment = (req, res, next) => {
    if (req.user.role === 'administrador') return next()
    const ok = (req.user.site?.site_services || []).some((x) => x.service?.active)
    if (!ok) return fail(res, 'Tu sede no tiene servicios de IPS habilitados', 403)
    next()
  }
  const SEL = '*, site:sites(name), service:ips_services(id, code, name)'

  const VIEW = ['administrador', 'empleado']
  const DASH = ['administrador', 'empleado']
  const CATEGORIES = {
    biomedico: 'Biomédico', refrigeracion: 'Refrigeración / cadena de frío', climatizacion: 'Aire acondicionado',
    electrico: 'Eléctrico / planta', computo: 'Cómputo', mobiliario: 'Mobiliario clínico', otro: 'Otro'
  }
  const STATUSES = ['operativo', 'en_mantenimiento', 'fuera_servicio', 'dado_de_baja']
  const RESPONSIBLE = ['taller', 'biomedico', 'interno']
  // Umbrales de alerta
  const ALERT = { maintDays: 15, warrantyDays: 30 }

  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e }
  })
  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const addMonths = (iso, months) => {
    const [y, m, d] = iso.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1 + months, d))
    return dt.toISOString().slice(0, 10)
  }

  const equipmentDTO = (e) => e && ({
    id: e.id, code: e.code, name: e.name, category: e.category, categoryLabel: CATEGORIES[e.category], brand: e.brand, model: e.model,
    serial: e.serial, invima: e.invima, riskClass: e.risk_class, serviceId: e.service_id, area: e.service?.name ?? e.area ?? null, serviceCode: e.service?.code ?? null, supplier: e.supplier, purchaseDate: e.purchase_date,
    purchasePrice: e.purchase_price == null ? null : Number(e.purchase_price), warrantyUntil: e.warranty_until,
    quantity: e.quantity, minQuantity: e.min_quantity, status: e.status, maintenanceMonths: e.maintenance_months,
    technicalSpecs: e.technical_specs, photo: e.photo, notes: e.notes, siteId: e.site_id, siteName: e.site?.name ?? null
  })
  const maintDTO = (m) => ({
    id: m.id, type: m.type, date: m.date, description: m.description, responsibleType: m.responsible_type,
    responsibleName: m.responsible_name, company: m.company, reportNumber: m.report_number,
    laborCost: Number(m.labor_cost), partsCost: Number(m.parts_cost), total: Number(m.labor_cost) + Number(m.parts_cost),
    result: m.result, nextDueDate: m.next_due_date, notes: m.notes,
    parts: (m.equipment_maintenance_parts || []).sort((a, b) => a.id - b.id).map((p) => ({ id: p.id, name: p.name, quantity: Number(p.quantity), unitPrice: Number(p.unit_price), total: Number(p.quantity) * Number(p.unit_price) }))
  })

  // Próximo preventivo: el que se indicó en el último preventivo o, si no, última fecha + frecuencia.
  const nextPreventive = (e, maints) => {
    const prev = maints.filter((m) => m.type === 'preventivo').sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    if (prev?.next_due_date) return prev.next_due_date
    if (e.maintenance_months) {
      const base = prev?.date || e.purchase_date
      if (base) return addMonths(base, e.maintenance_months)
    }
    return null
  }

  const alertsFor = (e, maints) => {
    if (e.status === 'dado_de_baja') return []
    const out = []
    // Un equipo fuera de servicio no se alerta por preventivo: la alerta es su estado.
    const next = e.status === 'fuera_servicio' ? null : nextPreventive(e, maints)
    if (e.status === 'fuera_servicio') { /* sin alerta de preventivo */ } else if (next) {
      const left = daysUntil(next)
      if (left < 0) out.push({ kind: 'mantenimiento', level: 'bad', message: `Mantenimiento preventivo vencido hace ${-left} día${left === -1 ? '' : 's'}`, date: next })
      else if (left <= ALERT.maintDays) out.push({ kind: 'mantenimiento', level: 'warn', message: `Mantenimiento preventivo en ${left} día${left === 1 ? '' : 's'}`, date: next })
    } else if (e.category === 'biomedico' || e.category === 'refrigeracion') {
      out.push({ kind: 'mantenimiento', level: 'warn', message: 'Sin plan de mantenimiento preventivo' })
    }
    if (e.warranty_until) {
      const left = daysUntil(e.warranty_until)
      if (left >= 0 && left <= ALERT.warrantyDays) out.push({ kind: 'garantia', level: 'warn', message: `La garantía vence en ${left} día${left === 1 ? '' : 's'}`, date: e.warranty_until })
    }
    if (e.status === 'fuera_servicio') out.push({ kind: 'estado', level: 'bad', message: 'Equipo fuera de servicio' })
    if (e.status === 'en_mantenimiento') out.push({ kind: 'estado', level: 'warn', message: 'Equipo en mantenimiento' })
    if (e.min_quantity > 0 && e.quantity <= e.min_quantity) out.push({ kind: 'stock', level: e.quantity === 0 ? 'bad' : 'warn', message: `Stock bajo: ${e.quantity} de mínimo ${e.min_quantity}` })
    return out
  }

  const loadAll = async (site, serviceId) => {
    let q = applyScope(supabase.from('equipment').select(SEL), site)
    if (serviceId === 'none') q = q.is('service_id', null)
    else if (Number(serviceId)) q = q.eq('service_id', Number(serviceId))
    const [eq, m] = await Promise.all([
      q.order('category').order('name'),
      supabase.from('equipment_maintenances').select('id, equipment_id, type, date, next_due_date, labor_cost, parts_cost')
    ])
    if (eq.error) throw eq.error
    if (m.error) throw m.error
    return eq.data.map((e) => {
      const ms = m.data.filter((x) => x.equipment_id === e.id)
      const last = ms.sort((a, b) => (a.date < b.date ? 1 : -1))[0]
      const warrantyDays = e.warranty_until ? daysUntil(e.warranty_until) : null
      return {
        ...equipmentDTO(e), nextPreventive: nextPreventive(e, ms), lastMaintenance: last ? { date: last.date, type: last.type } : null,
        warrantyActive: warrantyDays != null && warrantyDays >= 0, alerts: alertsFor(e, ms),
        maintenanceCost: ms.reduce((a, x) => a + Number(x.labor_cost) + Number(x.parts_cost), 0)
      }
    })
  }

  // ---------------------------------------------------------------- Equipos
  const validate = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre del equipo es requerido')
    if (!CATEGORIES[b.category]) e.push('Categoría inválida')
    if (b.status && !STATUSES.includes(b.status)) e.push('Estado inválido')
    if (b.riskClass && !['I', 'IIa', 'IIb', 'III'].includes(b.riskClass)) e.push('Clase de riesgo inválida')
    for (const [k, l] of [['purchaseDate', 'compra'], ['warrantyUntil', 'garantía']]) if (clean(b[k]) && !ISO_DATE.test(b[k])) e.push(`Fecha de ${l} inválida`)
    if (clean(b.purchaseDate) && clean(b.warrantyUntil) && b.warrantyUntil < b.purchaseDate) e.push('La garantía no puede terminar antes de la compra')
    const q = num(b.quantity); if (q === null || Number.isNaN(q) || q < 0 || !Number.isInteger(q)) e.push('Cantidad inválida')
    const mq = num(b.minQuantity); if (mq !== null && (Number.isNaN(mq) || mq < 0)) e.push('Stock mínimo inválido')
    const mm = num(b.maintenanceMonths); if (mm !== null && (Number.isNaN(mm) || mm < 1 || mm > 60)) e.push('Frecuencia de mantenimiento inválida (1 a 60 meses)')
    const pp = num(b.purchasePrice); if (pp !== null && (Number.isNaN(pp) || pp < 0)) e.push('Precio de compra inválido')
    if (!Number(b.serviceId)) e.push('Selecciona el área / servicio de IPS')
    return e
  }
  // El servicio debe existir; se guarda también su nombre como área.
  const checkService = async (b) => {
    const { data } = await supabase.from('ips_services').select('id, name').eq('id', Number(b.serviceId)).maybeSingle()
    if (!data) throw httpError(400, 'Área / servicio inválido')
    return data
  }
  const row = (b) => ({
    name: clean(b.name), category: b.category, brand: clean(b.brand), model: clean(b.model), serial: clean(b.serial)?.toUpperCase() ?? null,
    invima: clean(b.invima), risk_class: b.riskClass || null, service_id: Number(b.serviceId), supplier: clean(b.supplier),
    purchase_date: clean(b.purchaseDate), purchase_price: num(b.purchasePrice), warranty_until: clean(b.warrantyUntil),
    quantity: num(b.quantity), min_quantity: num(b.minQuantity) ?? 0, status: b.status || 'operativo',
    maintenance_months: num(b.maintenanceMonths), technical_specs: clean(b.technicalSpecs), notes: clean(b.notes), updated_at: new Date().toISOString()
  })

  app.get('/equipos/catalogos', auth(VIEW), siteHasEquipment, (req, res) => res.send({ categories: CATEGORIES, statuses: STATUSES }))
  app.get('/equipos', auth(VIEW), siteHasEquipment, hx(async (req, res) => res.send(await loadAll(scopeSite(req), req.query.servicio))))

  app.get('/equipos/:id', auth(VIEW), siteHasEquipment, hx(async (req, res) => {
    const id = Number(req.params.id)
    const [e, m] = await Promise.all([
      supabase.from('equipment').select(SEL).eq('id', id).maybeSingle(),
      supabase.from('equipment_maintenances').select('*, equipment_maintenance_parts(*)').eq('equipment_id', id).order('date', { ascending: false })
    ])
    if (e.error) throw e.error
    if (m.error) throw m.error
    if (!e.data || !canAccessSite(req, e.data.site_id)) return fail(res, 'Equipo no encontrado', 404)
    const maints = m.data.map(maintDTO)
    res.send({
      ...equipmentDTO(e.data), maintenances: maints, alerts: alertsFor(e.data, m.data), nextPreventive: nextPreventive(e.data, m.data),
      warrantyDays: e.data.warranty_until ? daysUntil(e.data.warranty_until) : null,
      totals: {
        maintenance: maints.reduce((a, x) => a + x.total, 0),
        preventive: maints.filter((x) => x.type === 'preventivo').length,
        corrective: maints.filter((x) => x.type === 'correctivo').length
      }
    })
  }))

  app.post('/equipos', auth(ADMIN), hx(async (req, res) => {
    const errors = validate(req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const svc = await checkService(req.body)
    const { data, error } = await supabase.from('equipment').insert({ ...row(req.body), area: svc.name, site_id: await targetSite(req, req.body.siteId) }).select(SEL).single()
    if (error) throw error
    res.status(201).send(equipmentDTO(data))
  }))

  app.put('/equipos/:id', auth(ADMIN), hx(async (req, res) => {
    const errors = validate(req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const svc = await checkService(req.body)
    const patch = { ...row(req.body), area: svc.name }
    if (Number(req.body.siteId)) patch.site_id = Number(req.body.siteId) // reasignar a otra sede
    const { data, error } = await supabase.from('equipment').update(patch).eq('id', Number(req.params.id)).select(SEL).maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 'Equipo no encontrado', 404)
    res.send(equipmentDTO(data))
  }))

  app.delete('/equipos/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { data: e } = await supabase.from('equipment').select('photo').eq('id', id).maybeSingle()
    if (!e) return fail(res, 'Equipo no encontrado', 404)
    const { count } = await supabase.from('equipment_maintenances').select('id', { count: 'exact', head: true }).eq('equipment_id', id)
    if (count) return fail(res, 'El equipo tiene mantenimientos registrados. Cámbialo a "dado de baja" para conservar su historial.', 409)
    const { error } = await supabase.from('equipment').delete().eq('id', id)
    if (error) throw error
    await removeStoredFile('equipment', e.photo)
    res.send({ message: 'Equipo eliminado' })
  }))

  app.post('/equipos/:id/foto', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { data: e } = await supabase.from('equipment').select('photo').eq('id', id).maybeSingle()
    if (!e) return fail(res, 'Equipo no encontrado', 404)
    const url = await uploadImage('equipment', `equipo-${id}`, req.body?.image, ['image/png', 'image/jpeg', 'image/webp'])
    if (!url) return fail(res, 'Imagen inválida (PNG, JPG o WEBP de máximo 2 MB)', 400)
    const { data } = await supabase.from('equipment').update({ photo: url }).eq('id', id).select('*').single()
    await removeStoredFile('equipment', e.photo)
    res.send(equipmentDTO(data))
  }))

  // ---------------------------------------------------------------- Mantenimientos
  const saveMaintenance = async (equipmentId, b, userId, existingId) => {
    const e = []
    if (!['preventivo', 'correctivo'].includes(b.type)) e.push('Tipo de mantenimiento inválido')
    if (!ISO_DATE.test(b.date || '')) e.push('La fecha es requerida')
    if (!clean(b.description)) e.push('Describe el trabajo realizado')
    if (!RESPONSIBLE.includes(b.responsibleType)) e.push('Indica si lo realizó un taller, el biomédico o personal interno')
    if (!clean(b.responsibleName)) e.push('Indica el nombre del responsable')
    if (b.result && !['operativo', 'requiere_seguimiento', 'fuera_servicio'].includes(b.result)) e.push('Resultado inválido')
    if (clean(b.nextDueDate) && !ISO_DATE.test(b.nextDueDate)) e.push('Fecha del próximo mantenimiento inválida')
    if (clean(b.nextDueDate) && b.date && b.nextDueDate <= b.date) e.push('El próximo mantenimiento debe ser posterior a la fecha')
    const labor = num(b.laborCost) ?? 0; if (Number.isNaN(labor) || labor < 0) e.push('Costo inválido')
    const parts = (b.parts || []).filter((p) => clean(p.name))
    for (const p of parts) if (!(Number(p.quantity) > 0) || Number.isNaN(Number(p.unitPrice)) || Number(p.unitPrice) < 0) e.push(`Revisa cantidad y precio de "${p.name}"`)
    if (b.date && b.date > todayBogota()) e.push('La fecha del mantenimiento no puede ser futura')
    if (e.length) throw httpError(400, e.join('. '))
    const { data: eq } = await supabase.from('equipment').select('id, maintenance_months, status').eq('id', equipmentId).maybeSingle()
    if (!eq) throw httpError(404, 'Equipo no encontrado')
    // Si es preventivo y no se indicó el próximo, se calcula con la frecuencia del equipo.
    let nextDue = b.type === 'preventivo' ? clean(b.nextDueDate) : null
    if (b.type === 'preventivo' && !nextDue && eq.maintenance_months) nextDue = addMonths(b.date, eq.maintenance_months)
    const partsCost = parts.reduce((a, p) => a + Number(p.quantity) * Number(p.unitPrice), 0)
    const record = {
      equipment_id: equipmentId, type: b.type, date: b.date, description: clean(b.description), responsible_type: b.responsibleType,
      responsible_name: clean(b.responsibleName), company: clean(b.company), report_number: clean(b.reportNumber),
      labor_cost: labor, parts_cost: partsCost, result: b.result || 'operativo', next_due_date: nextDue, notes: clean(b.notes)
    }
    let id = existingId
    if (existingId) {
      const { error } = await supabase.from('equipment_maintenances').update(record).eq('id', existingId).eq('equipment_id', equipmentId)
      if (error) throw error
      await supabase.from('equipment_maintenance_parts').delete().eq('maintenance_id', existingId)
    } else {
      const { data, error } = await supabase.from('equipment_maintenances').insert({ ...record, created_by: userId }).select('id').single()
      if (error) throw error
      id = data.id
    }
    if (parts.length) {
      const { error } = await supabase.from('equipment_maintenance_parts').insert(parts.map((p) => ({ maintenance_id: id, name: clean(p.name), quantity: Number(p.quantity), unit_price: Number(p.unitPrice) })))
      if (error) throw error
    }
    // El resultado del último mantenimiento actualiza el estado del equipo (si no está dado de baja).
    const { data: newer } = await supabase.from('equipment_maintenances').select('id').eq('equipment_id', equipmentId).gt('date', b.date).limit(1)
    if (!existingId && eq.status !== 'dado_de_baja' && !newer?.length) {
      const status = record.result === 'fuera_servicio' ? 'fuera_servicio' : record.result === 'requiere_seguimiento' ? 'en_mantenimiento' : 'operativo'
      await supabase.from('equipment').update({ status, updated_at: new Date().toISOString() }).eq('id', equipmentId)
    }
    const { data } = await supabase.from('equipment_maintenances').select('*, equipment_maintenance_parts(*)').eq('id', id).single()
    return maintDTO(data)
  }

  app.post('/equipos/:id/mantenimientos', auth(ADMIN), hx(async (req, res) => res.status(201).send(await saveMaintenance(Number(req.params.id), req.body || {}, req.user.id))))
  app.put('/equipos/:id/mantenimientos/:mid', auth(ADMIN), hx(async (req, res) => res.send(await saveMaintenance(Number(req.params.id), req.body || {}, req.user.id, Number(req.params.mid)))))
  app.delete('/equipos/:id/mantenimientos/:mid', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('equipment_maintenances').delete().eq('id', Number(req.params.mid)).eq('equipment_id', Number(req.params.id))
    if (error) throw error
    res.send({ message: 'Mantenimiento eliminado' })
  }))

  // ---------------------------------------------------------------- Resumen para el dashboard de IPS
  app.get('/equipos-resumen', auth(DASH), hx(async (req, res) => {
    const all = await loadAll(scopeSite(req))
    const active = all.filter((e) => e.status !== 'dado_de_baja')
    const alerts = active.flatMap((e) => e.alerts.map((a) => ({ ...a, equipmentId: e.id, code: e.code, name: e.name, area: e.area })))
      .sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1))
    const year = todayBogota().slice(0, 4)
    const ids = all.map((e) => e.id)
    const { data: ym, error } = ids.length ? await supabase.from('equipment_maintenances').select('type, labor_cost, parts_cost').in('equipment_id', ids).gte('date', `${year}-01-01`) : { data: [] }
    if (error) throw error
    res.send({
      total: active.length,
      units: active.reduce((a, e) => a + e.quantity, 0),
      byStatus: STATUSES.map((s) => ({ name: s, value: all.filter((e) => e.status === s).length })),
      byService: Object.values(active.reduce((acc, e) => {
        const k = e.serviceId || 'none'
        acc[k] = acc[k] || { id: e.serviceId, name: e.serviceId ? e.area : 'Sin servicio', value: 0 }
        acc[k].value += 1
        return acc
      }, {})).sort((a, b) => b.value - a.value),
      byCategory: Object.entries(CATEGORIES).map(([k, l]) => ({ key: k, name: l, value: active.filter((e) => e.category === k).length })).filter((c) => c.value),
      dueSoon: active.filter((e) => e.nextPreventive && daysUntil(e.nextPreventive) <= ALERT.maintDays).length,
      alerts,
      yearMaintenance: {
        count: ym.length,
        cost: ym.reduce((a, m) => a + Number(m.labor_cost) + Number(m.parts_cost), 0),
        preventive: ym.filter((m) => m.type === 'preventivo').length,
        corrective: ym.filter((m) => m.type === 'correctivo').length
      },
      thresholds: ALERT
    })
  }))
}
