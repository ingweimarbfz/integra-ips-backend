// =====================================================================
// Firma digital
// Cada usuario guarda su firma (dibujada o imagen PNG/JPG con fondo blanco o SVG)
// y la estampa en los documentos y reportes que tienen líneas de firma.
// La firma estampada queda congelada (copia de la imagen y del nombre al momento de firmar).
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, uploadImage, removeStoredFile, canAccessSite } = deps
  const IMG = ['image/png', 'image/jpeg', 'image/svg+xml']
  const STAFF = ['administrador', 'empleado']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e }
  })
  const fullName = (u) => `${u.name} ${u.last_name}`.trim()
  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

  // ---------------------------------------------------------------- Mi firma
  const saveSignature = async (userId, image) => {
    const { data: cur } = await supabase.from('users').select('signature_url').eq('id', userId).maybeSingle()
    if (!cur) throw httpError(404, 'Usuario no encontrado')
    const url = await uploadImage('signatures', `firma-${userId}`, image, IMG)
    if (!url) throw httpError(400, 'Imagen de firma inválida (PNG, JPG o SVG de máximo 2 MB)')
    const { error } = await supabase.from('users').update({ signature_url: url, signature_updated_at: new Date().toISOString() }).eq('id', userId)
    if (error) throw error
    // La imagen anterior se conserva si ya se usó en algún documento firmado.
    if (cur.signature_url) {
      const { count } = await supabase.from('document_signatures').select('id', { count: 'exact', head: true }).eq('signature_url', cur.signature_url)
      if (!count) await removeStoredFile('signatures', cur.signature_url)
    }
    return url
  }
  const clearSignature = async (userId) => {
    const { data: cur } = await supabase.from('users').select('signature_url').eq('id', userId).maybeSingle()
    if (!cur) throw httpError(404, 'Usuario no encontrado')
    await supabase.from('users').update({ signature_url: null, signature_updated_at: new Date().toISOString() }).eq('id', userId)
    if (cur.signature_url) {
      const { count } = await supabase.from('document_signatures').select('id', { count: 'exact', head: true }).eq('signature_url', cur.signature_url)
      if (!count) await removeStoredFile('signatures', cur.signature_url)
    }
  }

  app.put('/firma', auth(), hx(async (req, res) => res.send({ signatureUrl: await saveSignature(req.user.id, req.body?.image) })))
  app.delete('/firma', auth(), hx(async (req, res) => { await clearSignature(req.user.id); res.send({ signatureUrl: null }) }))

  // El administrador puede cargar o quitar la firma de cualquier usuario (Configuración → Firmas).
  app.get('/firmas/usuarios', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('users').select('id, name, last_name, username, role, identification, signature_url, signature_updated_at, active, site:sites(name)').order('name')
    if (error) throw error
    res.send(data.map((u) => ({ id: u.id, fullName: fullName(u), nameUser: u.username, role: u.role, identification: u.identification, siteName: u.site?.name ?? null, active: u.active, signatureUrl: u.signature_url, signatureUpdatedAt: u.signature_updated_at })))
  }))
  app.put('/firmas/usuarios/:id', auth(ADMIN), hx(async (req, res) => res.send({ signatureUrl: await saveSignature(Number(req.params.id), req.body?.image) })))
  app.delete('/firmas/usuarios/:id', auth(ADMIN), hx(async (req, res) => { await clearSignature(Number(req.params.id)); res.send({ signatureUrl: null }) }))

  // ---------------------------------------------------------------- Documentos firmables
  // Para cada tipo: las casillas de firma y quién puede firmar cada una.
  const loadOne = async (table, cols, id) => {
    const { data } = await supabase.from(table).select(cols).eq('id', Number(id)).maybeSingle()
    if (!data) throw httpError(404, 'Documento no encontrado')
    return data
  }
  const siteOf = (req, siteId) => { if (siteId && !canAccessSite(req, siteId)) throw httpError(404, 'Documento no encontrado') }
  const RULES = {
    citologia: async (req, key, slot) => {
      const c = await loadOne('cytology_samples', 'id, site_id, elabora, toma_muestra', key)
      siteOf(req, c.site_id)
      const expected = { elabora: c.elabora, toma_muestra: c.toma_muestra }[slot]
      if (expected === undefined) throw httpError(400, 'Casilla de firma inválida')
      if (norm(expected) !== norm(fullName(req.user))) throw httpError(403, `Solo ${expected || 'la persona indicada'} puede firmar esta casilla`)
    },
    evento: async (req, key, slot) => {
      const e = await loadOne('gso_events', 'id, site_id, coordinator:volunteers!gso_events_coordinator_id_fkey(document, first_name, last_name)', key)
      siteOf(req, e.site_id)
      if (/^usuario_\d+$/.test(slot)) {
        const uid = Number(slot.split('_')[1])
        const { data: p } = await supabase.from('gso_event_personnel').select('id').eq('event_id', e.id).eq('user_id', uid).maybeSingle()
        if (!p) throw httpError(400, 'La persona no está en el personal del evento')
        if (uid !== req.user.id) throw httpError(403, 'Solo esa persona puede firmar su casilla')
      } else if (/^persona_\d+$/.test(slot)) {
        const vid = Number(slot.split('_')[1])
        const { data: p } = await supabase.from('gso_event_personnel').select('volunteers(document, first_name, last_name)').eq('event_id', e.id).eq('volunteer_id', vid).maybeSingle()
        if (!p) throw httpError(400, 'La persona no está en el personal del evento')
        if (p.volunteers.document !== req.user.identification) throw httpError(403, `Solo ${p.volunteers.first_name} ${p.volunteers.last_name} puede firmar su casilla`)
      } else if (slot === 'coordinador') {
        if (e.coordinator?.document !== req.user.identification) throw httpError(403, `Solo el coordinador (${e.coordinator?.first_name} ${e.coordinator?.last_name}) puede firmar esta casilla`)
      } else if (slot === 'direccion') {
        if (!STAFF.includes(req.user.role)) throw httpError(403, 'Esta casilla la firma la dirección (administrador o empleado)')
      } else throw httpError(400, 'Casilla de firma inválida')
    },
    reporte_vehiculo: async (req, key, slot) => {
      const t = await loadOne('vehicle_trips', 'id, driver_id', key)
      if (slot === 'conductor') { if (t.driver_id !== req.user.id) throw httpError(403, 'Solo el conductor del reporte puede firmar esta casilla') } else if (slot === 'reviso') { if (req.user.role !== 'administrador') throw httpError(403, 'Esta casilla la firma el administrador') } else throw httpError(400, 'Casilla de firma inválida')
    },
    preoperacional: async (req, key, slot) => {
      const t = await loadOne('vehicle_inspections', 'id, driver_id', key)
      if (slot === 'conductor') { if (t.driver_id !== req.user.id) throw httpError(403, 'Solo el conductor del preoperacional puede firmar esta casilla') } else if (slot === 'reviso') { if (req.user.role !== 'administrador') throw httpError(403, 'Esta casilla la firma el administrador de flota') } else throw httpError(400, 'Casilla de firma inválida')
    },
    // Reportes generados: la clave es el alcance y el periodo (p. ej. "2:2026-10").
    temperatura: async (req, key, slot) => {
      if (!STAFF.includes(req.user.role)) throw httpError(403, 'Sin permiso para firmar este reporte')
      const site = Number(String(key).split(':')[0]); if (site) siteOf(req, site)
      if (!['genero', 'responsable'].includes(slot)) throw httpError(400, 'Casilla de firma inválida')
    },
    inventario: async (req, key, slot) => {
      if (!STAFF.includes(req.user.role)) throw httpError(403, 'Sin permiso para firmar este reporte')
      if (!['genero', 'responsable'].includes(slot)) throw httpError(400, 'Casilla de firma inválida')
    },
    equipo: async (req, key, slot) => {
      const e = await loadOne('equipment', 'id, site_id', key)
      siteOf(req, e.site_id)
      if (!STAFF.includes(req.user.role)) throw httpError(403, 'Sin permiso para firmar esta hoja de vida')
      if (!['mantenimiento', 'coordinacion'].includes(slot)) throw httpError(400, 'Casilla de firma inválida')
    }
  }
  const sigDTO = (s) => ({ id: s.id, slot: s.slot, userId: s.user_id, signerName: s.signer_name, signerIdentification: s.signer_identification, signatureUrl: s.signature_url, signedAt: s.signed_at })
  const docParams = (src) => {
    const type = clean(src.docType || src.tipo); const key = clean(String(src.docKey ?? src.clave ?? ''))
    if (!RULES[type] || !key) throw httpError(400, 'Documento inválido')
    return { type, key }
  }

  app.get('/firmas', auth(), hx(async (req, res) => {
    const { type, key } = docParams(req.query)
    const { data, error } = await supabase.from('document_signatures').select('*').eq('doc_type', type).eq('doc_key', key)
    if (error) throw error
    res.send(data.map(sigDTO))
  }))

  app.post('/firmas', auth(), hx(async (req, res) => {
    const { type, key } = docParams(req.body || {})
    const slot = clean(req.body?.slot)
    if (!slot) return fail(res, 'Casilla de firma inválida', 400)
    if (!req.user.signature_url) return fail(res, 'Aún no tienes una firma digital. Créala en Mi firma digital.', 400)
    await RULES[type](req, key, slot)
    const { data, error } = await supabase.from('document_signatures').insert({
      doc_type: type, doc_key: key, slot, user_id: req.user.id, signer_name: fullName(req.user), signer_identification: req.user.identification, signature_url: req.user.signature_url
    }).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Esta casilla ya está firmada', 409); throw error }
    res.status(201).send(sigDTO(data))
  }))

  // ---------------------------------------------------------------- Pendientes por firmar del usuario
  // Solo las casillas que tienen un firmante definido: el profesional de la citología, el coordinador del evento,
  // el conductor del reporte/preoperacional y, para el administrador, el "Revisó" de flota (últimos 30 días).
  const SLOT_LABELS = { elabora: 'Elaboró historia', toma_muestra: 'Tomó la muestra', coordinador: 'Coordinador', conductor: 'Conductor', reviso: 'Revisó', persona: 'Salida de personal' }
  const pendingFor = async (user) => {
    const name = norm(fullName(user))
    const since = new Date(Date.now() - 30 * 86400000).toISOString()
    const admin = user.role === 'administrador'
    const [cyto, events, trips, insp, signed] = await Promise.all([
      ['administrador', 'empleado'].includes(user.role) ? supabase.from('cytology_samples').select('id, num_factura, nombre, apellidos, fecha_examen, elabora, toma_muestra').order('fecha_examen', { ascending: false }).limit(500) : { data: [] },
      supabase.from('gso_events').select('id, code, name, area, ended_at, status, coordinator:volunteers!gso_events_coordinator_id_fkey(document)').eq('status', 'finalizado').order('ended_at', { ascending: false }).limit(300),
      admin ? supabase.from('vehicle_trips').select('id, code, activity, driver_id, status, ended_at, vehicles(movil)').eq('status', 'cerrado').gte('ended_at', since).order('ended_at', { ascending: false })
        : supabase.from('vehicle_trips').select('id, code, activity, driver_id, status, ended_at, vehicles(movil)').eq('driver_id', user.id).eq('status', 'cerrado').order('ended_at', { ascending: false }).limit(100),
      admin ? supabase.from('vehicle_inspections').select('id, code, driver_id, inspected_at, result, vehicles(movil)').gte('inspected_at', since).order('inspected_at', { ascending: false })
        : supabase.from('vehicle_inspections').select('id, code, driver_id, inspected_at, result, vehicles(movil)').eq('driver_id', user.id).order('inspected_at', { ascending: false }).limit(100),
      supabase.from('document_signatures').select('doc_type, doc_key, slot').in('doc_type', ['citologia', 'evento', 'reporte_vehiculo', 'preoperacional'])
    ])
    for (const r of [cyto, events, trips, insp, signed]) if (r.error) throw r.error
    const done = new Set(signed.data.map((x) => `${x.doc_type}|${x.doc_key}|${x.slot}`))
    const out = []
    const add = (o) => { if (!done.has(`${o.docType}|${o.docKey}|${o.slot}`)) out.push({ ...o, slotLabel: SLOT_LABELS[o.slotKind || o.slot] }) }
    for (const c of cyto.data) {
      const title = `Citología ${c.num_factura || c.id}`; const sub = `${c.nombre || ''} ${c.apellidos || ''}`.trim()
      if (norm(c.elabora) === name) add({ docType: 'citologia', docKey: String(c.id), slot: 'elabora', title, subtitle: sub, date: c.fecha_examen, link: `/citologias/${c.id}` })
      if (norm(c.toma_muestra) === name) add({ docType: 'citologia', docKey: String(c.id), slot: 'toma_muestra', title, subtitle: sub, date: c.fecha_examen, link: `/citologias/${c.id}` })
    }
    // Salida de personal: cada voluntario firma su fila en los eventos finalizados en que participó.
    const { data: mine } = await supabase.from('volunteers').select('id').eq('document', user.identification)
    if (mine?.length) {
      const { data: part } = await supabase.from('gso_event_personnel').select('volunteer_id, gso_events!inner(id, code, name, area, status, ended_at)').in('volunteer_id', mine.map((v) => v.id)).eq('gso_events.status', 'finalizado')
      for (const p of part || []) {
        const e = p.gso_events
        add({ docType: 'evento', docKey: String(e.id), slot: `persona_${p.volunteer_id}`, slotKind: 'persona', title: `${e.area === 'educacion' ? 'Actividad' : 'Evento'} ${e.code}`, subtitle: e.name, date: e.ended_at, link: `/socorro/${e.area === 'educacion' ? 'educacion' : 'eventos'}/${e.id}?reporte=1` })
      }
    }
    const { data: asUser } = await supabase.from('gso_event_personnel').select('user_id, gso_events!inner(id, code, name, area, status, ended_at)').eq('user_id', user.id).eq('gso_events.status', 'finalizado')
    for (const p of asUser || []) {
      const e = p.gso_events
      add({ docType: 'evento', docKey: String(e.id), slot: `usuario_${user.id}`, slotKind: 'persona', title: `${e.area === 'educacion' ? 'Actividad' : 'Evento'} ${e.code}`, subtitle: e.name, date: e.ended_at, link: `/socorro/${e.area === 'educacion' ? 'educacion' : 'eventos'}/${e.id}?reporte=1` })
    }
    for (const e of events.data) if (e.coordinator?.document && e.coordinator.document === user.identification) {
      add({ docType: 'evento', docKey: String(e.id), slot: 'coordinador', title: `${e.area === 'educacion' ? 'Actividad' : 'Evento'} ${e.code}`, subtitle: e.name, date: e.ended_at, link: `/socorro/${e.area === 'educacion' ? 'educacion' : 'eventos'}/${e.id}?reporte=1` })
    }
    for (const t of trips.data) {
      const base = { docType: 'reporte_vehiculo', docKey: String(t.id), title: `Reporte diario ${t.code}`, subtitle: `Móvil ${t.vehicles?.movil ?? ''} · ${t.activity}`, date: t.ended_at, link: `/socorro/vehiculos/reportes/${t.id}` }
      if (t.driver_id === user.id) add({ ...base, slot: 'conductor' })
      if (admin) add({ ...base, slot: 'reviso' })
    }
    for (const r of insp.data) {
      const base = { docType: 'preoperacional', docKey: String(r.id), title: `Preoperacional ${r.code}`, subtitle: `Móvil ${r.vehicles?.movil ?? ''} · ${r.result === 'apto' ? 'Apto' : 'No apto'}`, date: r.inspected_at, link: `/socorro/vehiculos/preoperacional/${r.id}` }
      if (r.driver_id === user.id) add({ ...base, slot: 'conductor' })
      if (admin) add({ ...base, slot: 'reviso' })
    }
    return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  }

  app.get('/firmas/pendientes', auth(), hx(async (req, res) => {
    const items = await pendingFor(req.user)
    res.send({ hasSignature: Boolean(req.user.signature_url), total: items.length, items: items.slice(0, 200) })
  }))

  // Firmar varios a la vez (o todos los pendientes si no se envía la lista).
  app.post('/firmas/lote', auth(), hx(async (req, res) => {
    if (!req.user.signature_url) return fail(res, 'Aún no tienes una firma digital. Créala en Mi firma digital.', 400)
    const list = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items : await pendingFor(req.user)
    let ok = 0; const errors = []
    for (const it of list.slice(0, 300)) {
      try {
        const { type, key } = docParams(it)
        const slot = clean(it.slot)
        await RULES[type](req, key, slot)
        const { error } = await supabase.from('document_signatures').insert({
          doc_type: type, doc_key: key, slot, user_id: req.user.id, signer_name: fullName(req.user), signer_identification: req.user.identification, signature_url: req.user.signature_url
        })
        if (error && error.code !== '23505') throw error
        if (!error) ok += 1
      } catch (e) { errors.push(`${it.title || it.docType}: ${e.message}`) }
    }
    res.send({ signed: ok, errors })
  }))

  // Quitar una firma: quien firmó o el administrador.
  app.delete('/firmas/:id', auth(), hx(async (req, res) => {
    const { data: s } = await supabase.from('document_signatures').select('id, user_id').eq('id', Number(req.params.id)).maybeSingle()
    if (!s) return fail(res, 'Firma no encontrada', 404)
    if (s.user_id !== req.user.id && req.user.role !== 'administrador') return fail(res, 'Solo quien firmó o un administrador puede quitar la firma', 403)
    const { error } = await supabase.from('document_signatures').delete().eq('id', s.id)
    if (error) throw error
    res.send({ message: 'Firma retirada' })
  }))
}
