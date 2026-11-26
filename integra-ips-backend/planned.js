// =====================================================================
// Eventos previos (IIPS-025)
// Programación de servicios de socorro, actividades de educación y traslados que un cliente contrata
// con anticipación: datos de la actividad, cupos de personal por agrupación, coordinador, conductor,
// vehículos, elementos y valores. Genera la cotización para el cliente y, llegado el día, se carga
// en el evento real (o en el traslado) para no volver a digitar.
// =====================================================================
const alerts = require('./alerts')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, STAFF, scopeSite, canAccessSite, todayBogota, inPlan } = deps
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const AREAS = { socorro: 'Servicio de socorro', educacion: 'Actividad de educación', traslado: 'Traslado asistencial' }
  const STATUS = { borrador: 'Borrador', cotizado: 'Cotizado', aprobado: 'Aprobado por el cliente', ejecutado: 'Ejecutado', cancelado: 'Cancelado' }
  const AGRUPACIONES = ['Socorrismo', 'Damas Grises', 'Juventud']
  const VEHICLE_TYPES = { TAB: 'Ambulancia TAB', TAM: 'Ambulancia TAM', otro: 'Otro vehículo' }
  const SELECT = '*, site:sites(id, name), coordinator:volunteers(id, first_name, last_name, document, phone, agrupacion), creator:users!planned_events_created_by_fkey(name, last_name), event:gso_events(id, code, area, status), trip:vehicle_trips(id, code, status), charge:service_charges(id, invoice_number, invoiced_at, valor, total_invoice, payer_name, billing_status)'
  const num = (v, d = 0) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v))
  const fullName = (u) => (u ? `${u.name || u.first_name} ${u.last_name}`.trim() : null)

  const totals = (items) => {
    const lines = (items || []).map((x) => ({ ...x, total: Math.round(num(x.quantity) * num(x.unitPrice)) }))
    return { lines, total: lines.reduce((a, x) => a + x.total, 0) }
  }
  const dto = (p) => {
    const t = totals(p.price_items)
    return {
      id: p.id, code: p.code, area: p.area, areaLabel: AREAS[p.area], status: p.status, statusLabel: STATUS[p.status],
      name: p.name, description: p.description, place: p.place, siteId: p.site_id, siteName: p.site?.name ?? null,
      startsAt: p.starts_at, endsAt: p.ends_at, attendees: p.attendees,
      client: { name: p.client_name, nit: p.client_nit, contact: p.client_contact, phone: p.client_phone, email: p.client_email },
      coordinator: p.coordinator ? { id: p.coordinator.id, fullName: fullName(p.coordinator), document: p.coordinator.document, phone: p.coordinator.phone, agrupacion: p.coordinator.agrupacion } : null,
      needsDriver: p.needs_driver, vehicles: p.vehicles || [], personnel: p.personnel || [], elements: p.elements || [],
      priceItems: t.lines, total: t.total, notes: p.notes, validUntil: p.valid_until,
      event: p.event ? { id: p.event.id, code: p.event.code, area: p.event.area, status: p.event.status } : null,
      trip: p.trip ? { id: p.trip.id, code: p.trip.code, status: p.trip.status } : null,
      invoice: p.invoice_number ? { number: p.invoice_number, chargeId: p.charge_id, external: !p.charge_id, invoicedAt: p.invoiced_at, total: p.charge ? Number(p.charge.total_invoice ?? p.charge.valor) : null, payer: p.charge?.payer_name ?? null } : null,
      createdBy: fullName(p.creator), createdAt: p.created_at, updatedAt: p.updated_at,
      volunteersTotal: (p.personnel || []).reduce((a, x) => a + num(x.quantity), 0)
    }
  }
  const load = async (req, id) => {
    const { data, error } = await supabase.from('planned_events').select(SELECT).eq('id', Number(id)).maybeSingle()
    if (error) throw error
    if (!data || (data.site_id && !canAccessSite(req, data.site_id))) throw httpError(404, 'Evento programado no encontrado')
    return data
  }
  const isoOrNull = (v) => { if (!v) return null; const s = String(v); const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}-05:00`); return Number.isNaN(d.getTime()) ? undefined : d.toISOString() }

  const validate = async (req, b) => {
    const e = []
    if (!AREAS[b.area]) e.push('Elige si es un servicio de socorro, una actividad de educación o un traslado')
    if (!clean(b.name)) e.push('Escribe el nombre de la actividad')
    const startsAt = isoOrNull(b.startsAt); const endsAt = isoOrNull(b.endsAt)
    if (startsAt === undefined || endsAt === undefined) e.push('Fecha u hora inválida')
    if (!startsAt) e.push('Indica la fecha y hora de inicio')
    if (startsAt && endsAt && endsAt < startsAt) e.push('La hora de terminación no puede ser anterior al inicio')
    const siteId = req.user.role === 'administrador' ? (Number(b.siteId) || null) : req.user.site_id
    if (siteId && !canAccessSite(req, siteId)) e.push('Sede inválida')
    const personnel = (Array.isArray(b.personnel) ? b.personnel : []).map((x) => ({ role: clean(x.role) || 'Voluntario', agrupacion: AGRUPACIONES.includes(x.agrupacion) ? x.agrupacion : null, quantity: Math.max(0, Math.round(num(x.quantity))) })).filter((x) => x.quantity > 0)
    const vehicles = (Array.isArray(b.vehicles) ? b.vehicles : []).map((x) => ({ type: VEHICLE_TYPES[x.type] ? x.type : 'otro', quantity: Math.max(0, Math.round(num(x.quantity))), notes: clean(x.notes) })).filter((x) => x.quantity > 0)
    const elements = (Array.isArray(b.elements) ? b.elements : []).map((x) => ({ productId: Number(x.productId) || null, kitId: Number(x.kitId) || null, name: clean(x.name), quantity: Math.max(0, num(x.quantity)) })).filter((x) => x.name && x.quantity > 0)
    const priceItems = (Array.isArray(b.priceItems) ? b.priceItems : []).map((x) => ({ concept: clean(x.concept), quantity: Math.max(0, num(x.quantity, 1)), unitPrice: Math.max(0, num(x.unitPrice)) })).filter((x) => x.concept)
    const coordinatorId = Number(b.coordinatorId) || null
    if (coordinatorId) {
      const { data: c } = await supabase.from('volunteers').select('id, active').eq('id', coordinatorId).maybeSingle()
      if (!c || !c.active) e.push('El coordinador debe ser una persona registrada y activa')
    }
    if (b.client?.email && !/^\S+@\S+\.\S+$/.test(b.client.email)) e.push('Correo del cliente inválido')
    const validUntil = clean(b.validUntil)
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) e.push('Fecha de vigencia inválida')
    return {
      errors: e,
      row: {
        area: b.area, name: clean(b.name)?.slice(0, 160), description: clean(b.description)?.slice(0, 4000) ?? null, place: clean(b.place)?.slice(0, 200) ?? null, site_id: siteId,
        starts_at: startsAt || null, ends_at: endsAt || null, attendees: b.attendees === '' || b.attendees == null ? null : Math.max(0, Math.round(num(b.attendees))),
        client_name: clean(b.client?.name), client_nit: clean(b.client?.nit), client_contact: clean(b.client?.contact), client_phone: clean(b.client?.phone), client_email: clean(b.client?.email)?.toLowerCase() ?? null,
        coordinator_volunteer_id: coordinatorId, needs_driver: Boolean(b.needsDriver) || vehicles.length > 0, vehicles, personnel, elements, price_items: priceItems,
        notes: clean(b.notes)?.slice(0, 4000) ?? null, valid_until: validUntil || null, updated_at: new Date().toISOString()
      }
    }
  }
  const nextCode = async () => {
    const year = todayBogota().slice(0, 4)
    const { data } = await supabase.from('planned_events').select('code').ilike('code', `PE-${year}-%`)
    const max = (data || []).reduce((m, r) => Math.max(m, Number(String(r.code).split('-')[2]) || 0), 0)
    return `PE-${year}-${String(max + 1).padStart(4, '0')}`
  }

  app.get('/eventos-previos/catalogos', auth(STAFF), hx(async (req, res) => res.send({ areas: AREAS, statuses: STATUS, agrupaciones: AGRUPACIONES, vehicleTypes: VEHICLE_TYPES })))
  app.get('/eventos-previos', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('planned_events').select(SELECT).order('starts_at', { ascending: true, nullsFirst: false }).limit(500)
    const site = scopeSite(req)
    if (site) q = q.or(`site_id.eq.${site},site_id.is.null`)
    if (AREAS[req.query.area]) q = q.eq('area', req.query.area)
    if (STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) q = q.gte('starts_at', `${req.query.desde}T00:00:00-05:00`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) q = q.lte('starts_at', `${req.query.hasta}T23:59:59-05:00`)
    // Para cargar en un evento nuevo: los cotizados o aprobados que aún no se ejecutan.
    if (req.query.disponibles === '1') q = q.in('status', ['cotizado', 'aprobado']).is('event_id', null).is('trip_id', null)
    const { data, error } = await q
    if (error) throw error
    res.send(data.map(dto))
  }))
  app.get('/eventos-previos/:id', auth(STAFF), hx(async (req, res) => res.send(dto(await load(req, req.params.id)))))
  app.post('/eventos-previos', auth(STAFF), hx(async (req, res) => {
    const { errors, row } = await validate(req, req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { data, error } = await supabase.from('planned_events').insert({ ...row, code: await nextCode(), status: req.body?.status === 'cotizado' ? 'cotizado' : 'borrador', created_by: req.user.id }).select('id').single()
    if (error) throw error
    res.status(201).send(dto(await load(req, data.id)))
  }))
  app.put('/eventos-previos/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req, req.params.id)
    if (['ejecutado', 'cancelado'].includes(cur.status)) return fail(res, 'Un evento ejecutado o cancelado no se modifica', 400)
    const { errors, row } = await validate(req, req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { error } = await supabase.from('planned_events').update(row).eq('id', cur.id)
    if (error) throw error
    res.send(dto(await load(req, cur.id)))
  }))
  app.post('/eventos-previos/:id/estado', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req, req.params.id)
    const to = req.body?.status
    const ALLOWED = { borrador: ['cotizado', 'cancelado'], cotizado: ['aprobado', 'borrador', 'cancelado'], aprobado: ['cotizado', 'cancelado'], cancelado: ['borrador'], ejecutado: [] }
    if (!ALLOWED[cur.status]?.includes(to)) return fail(res, `No se puede pasar de ${STATUS[cur.status]} a ${STATUS[to] || to}`, 400)
    const { error } = await supabase.from('planned_events').update({ status: to, updated_at: new Date().toISOString() }).eq('id', cur.id)
    if (error) throw error
    res.send(dto(await load(req, cur.id)))
  }))
  app.delete('/eventos-previos/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req, req.params.id)
    if (!['borrador', 'cancelado'].includes(cur.status)) return fail(res, 'Solo se eliminan los borradores o cancelados', 400)
    const { error } = await supabase.from('planned_events').delete().eq('id', cur.id)
    if (error) throw error
    res.send({ ok: true })
  }))

  // Cuando un evento o traslado real se crea a partir del programado: queda enlazado y ejecutado.
  const linkTo = async (plannedId, { eventId = null, tripId = null }) => {
    if (!Number(plannedId)) return
    await supabase.from('planned_events').update({ status: 'ejecutado', event_id: eventId, trip_id: tripId, updated_at: new Date().toISOString() })
      .eq('id', Number(plannedId)).in('status', ['cotizado', 'aprobado', 'borrador'])
  }

  // ---------------------------------------------------------------- IIPS-038 · Factura del evento
  // Con Facturación activa: se busca y enlaza la factura hecha en Facturación → Servicios facturables.
  // Sin Facturación: se escribe el N° de la factura del sistema externo para dejar la relación.
  const billingOn = () => (inPlan ? inPlan('facturacion') : true)
  app.get('/eventos-previos-facturas', auth(STAFF), hx(async (req, res) => {
    if (!billingOn()) return res.send([])
    const q = String(req.query.q || '').trim().toUpperCase()
    if (q.length < 3) return fail(res, 'Escribe al menos 3 caracteres', 400)
    const fv = /^FV-?\d+$/.test(q) ? `FV-${q.replace(/\D/g, '').padStart(7, '0')}` : null
    const digits = q.replace(/[^\dA-Z]/g, '')
    let sq = supabase.from('service_charges').select('id, invoice_number, invoiced_at, service_date, service_name, description, payer_name, payer_doc_number, patient_name, valor, total_invoice, billing_status, site_id, source_table, source_id')
      .not('invoice_number', 'is', null).not('billing_status', 'in', '(anulada,por_facturar)').order('service_date', { ascending: false }).limit(20)
    sq = fv ? sq.eq('invoice_number', fv) : sq.or(`payer_doc_number.eq.${digits},patient_doc_number.eq.${digits},invoice_number.ilike.%${digits}%`)
    const site = scopeSite(req); if (site) sq = sq.eq('site_id', site)
    const { data, error } = await sq
    if (error) throw error
    const { data: used } = await supabase.from('planned_events').select('id, code, charge_id').in('charge_id', data.map((c) => c.id).concat(0))
    res.send(data.map((c) => {
      const u = (used || []).find((x) => x.charge_id === c.id)
      return { id: c.id, number: c.invoice_number, date: c.service_date, service: c.service_name, description: c.description, payer: c.payer_name || c.patient_name, payerDoc: c.payer_doc_number, total: Number(c.total_invoice ?? c.valor), usedBy: u ? u.code : null, linkedElsewhere: Boolean(!u && c.source_table && c.source_table !== 'planned_events') }
    }))
  }))
  app.put('/eventos-previos/:id/factura', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req, req.params.id)
    if (['borrador', 'cancelado'].includes(cur.status)) return fail(res, 'Solo se factura un evento cotizado, aprobado o ejecutado', 400)
    const now = new Date().toISOString()
    let patch
    if (billingOn()) {
      const id = Number(req.body?.chargeId)
      if (!id) return fail(res, 'Busca y elige la factura del evento', 400)
      const { data: c } = await supabase.from('service_charges').select('id, invoice_number, billing_status, site_id, source_table, source_id').eq('id', id).maybeSingle()
      if (!c || !c.invoice_number) return fail(res, 'Factura no encontrada', 404)
      if (['anulada', 'por_facturar'].includes(c.billing_status)) return fail(res, 'La factura no está vigente', 400)
      if (c.site_id && !canAccessSite(req, c.site_id)) return fail(res, 'No tienes acceso a esa factura', 403)
      const { data: other } = await supabase.from('planned_events').select('code').eq('charge_id', id).neq('id', cur.id).maybeSingle()
      if (other) return fail(res, `La factura ${c.invoice_number} ya está asociada al evento ${other.code}`, 409)
      if (c.source_table && c.source_table !== 'planned_events') return fail(res, `La factura ${c.invoice_number} ya corresponde a otro servicio`, 409)
      patch = { charge_id: c.id, invoice_number: c.invoice_number, invoiced_at: now }
      await supabase.from('service_charges').update({ source_table: 'planned_events', source_id: cur.id, reference: cur.code }).eq('id', c.id)
    } else {
      const n = clean(req.body?.invoiceNumber)
      if (!n) return fail(res, 'Escribe el número de la factura', 400)
      patch = { charge_id: null, invoice_number: n.slice(0, 40), invoiced_at: now }
    }
    if (cur.charge_id && cur.charge_id !== patch.charge_id) await supabase.from('service_charges').update({ source_table: null, source_id: null }).eq('id', cur.charge_id).eq('source_table', 'planned_events')
    const { error } = await supabase.from('planned_events').update({ ...patch, updated_at: now }).eq('id', cur.id)
    if (error) throw error
    res.send(dto(await load(req, cur.id)))
  }))
  app.delete('/eventos-previos/:id/factura', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req, req.params.id)
    if (cur.charge_id) await supabase.from('service_charges').update({ source_table: null, source_id: null }).eq('id', cur.charge_id).eq('source_table', 'planned_events')
    await supabase.from('planned_events').update({ charge_id: null, invoice_number: null, invoiced_at: null, updated_at: new Date().toISOString() }).eq('id', cur.id)
    res.send(dto(await load(req, cur.id)))
  }))

  // Avisos: eventos aprobados que empiezan en los próximos 7 días y cotizaciones vencidas sin respuesta.
  alerts.register({
    key: 'eventos_previos', route: '/socorro/programacion', roles: ['administrador', 'empleado'],
    run: async (req) => {
      const now = new Date(); const in7 = new Date(Date.now() + 7 * 86400000)
      let q = supabase.from('planned_events').select('id, code, name, status, starts_at, valid_until, site_id').in('status', ['aprobado', 'cotizado']).is('event_id', null).is('trip_id', null)
      const site = scopeSite(req)
      if (site) q = q.or(`site_id.eq.${site},site_id.is.null`)
      const { data, error } = await q
      if (error) throw error
      const out = []
      for (const p of data) {
        const when = p.starts_at ? new Date(p.starts_at) : null
        const day = when ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(when) : ''
        if (p.status === 'aprobado' && when && when <= in7) out.push({ id: `${p.id}:prox`, level: when < now ? 'bad' : 'warn', title: `${p.code} · ${p.name}`, message: when < now ? `Debía empezar el ${day} y no se ha cargado como evento` : `Empieza el ${day}: prepara personal y elementos`, link: `/socorro/programacion/${p.id}`, date: p.starts_at?.slice(0, 10) })
        if (p.status === 'cotizado' && p.valid_until && p.valid_until < todayBogota()) out.push({ id: `${p.id}:vencida`, level: 'info', title: `${p.code} · ${p.name}`, message: 'Cotización vencida sin respuesta del cliente', link: `/socorro/programacion/${p.id}`, date: p.valid_until })
      }
      return out
    }
  })

  return { linkTo }
}
