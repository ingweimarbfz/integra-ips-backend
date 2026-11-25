// =====================================================================
// Gestión documental y correspondencia (IIPS-030) · ventanilla única
// Recepción radica documentos, paquetes, oficios y notificaciones con consecutivo por área
// (ENT-TH-2026-0001), fotos o escaneos del documento o de la guía, área y persona a la que va.
// Estados: radicado → entregado → en revisión → respondido / archivado (o devuelto / anulado).
// Trazabilidad completa (cada cambio queda en corr_events), plazos de respuesta en días hábiles
// (Ley 1755 de 2015), firma de recibido, reasignación, respuesta vinculada, bandeja por usuario,
// dashboard y avisos.
// =====================================================================
const crypto = require('crypto')
const alerts = require('./alerts')
const cal = require('./calendar')

const KINDS = { documento: 'Documento', oficio: 'Oficio / carta', paquete: 'Paquete o encomienda', notificacion: 'Notificación judicial o administrativa', factura: 'Factura o cuenta de cobro', peticion: 'Derecho de petición / PQRS', tutela: 'Acción de tutela', invitacion: 'Invitación', otro: 'Otro' }
// Términos de respuesta en días hábiles (Ley 1755 de 2015, art. 14; tutela: 2 días por regla práctica, el juez fija el plazo).
const RESPONSE_DAYS = { peticion: 15, documentos: 10, consulta: 30, queja: 15, tutela: 2, general: 15 }
const RESPONSE_TYPES = { peticion: 'Petición (15 días hábiles)', documentos: 'Solicitud de documentos o información (10)', consulta: 'Consulta (30)', queja: 'Queja o reclamo (15)', tutela: 'Tutela (según el juez, por defecto 2)', general: 'Respuesta general (15)' }
const STATUS = { radicado: 'Radicado', entregado: 'Entregado', en_revision: 'En revisión', respondido: 'Respondido', archivado: 'Archivado', devuelto: 'Devuelto', anulado: 'Anulado' }
const NEXT = { radicado: ['entregado', 'devuelto', 'anulado'], entregado: ['en_revision', 'respondido', 'archivado', 'devuelto'], en_revision: ['respondido', 'archivado', 'devuelto'], respondido: ['archivado'], devuelto: ['radicado'], archivado: [], anulado: [] }
const OPEN = ['radicado', 'entregado', 'en_revision', 'devuelto']
const DIR_PREFIX = { entrada: 'ENT', salida: 'SAL', interna: 'INT' }
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, todayBogota, scopeSite, uploadImage } = deps
  const RECEPTION = ['administrador', 'empleado']
  const ANY = ['administrador', 'empleado', 'conductor', 'voluntario', 'docente']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const must = async (q) => { const { data, error } = await q; if (error) throw error; return data }
  const fullName = (u) => (u ? `${u.name} ${u.last_name}`.trim() : null)
  const isReception = (u) => RECEPTION.includes(u.role)

  const uploadFile = async (corrId, dataUrl, name, kind, userId) => {
    const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(dataUrl || '')
    if (!m || !FILE_TYPES[m[1]]) throw httpError(400, 'Archivo inválido: PDF o imagen (PNG, JPG, WEBP)')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > 12 * 1024 * 1024) throw httpError(400, 'El archivo supera 12 MB')
    const path = `${corrId}-${crypto.randomBytes(10).toString('hex')}.${FILE_TYPES[m[1]]}`
    const { error } = await supabase.storage.from('correspondencia').upload(path, buffer, { contentType: m[1], upsert: false })
    if (error) throw error
    const url = supabase.storage.from('correspondencia').getPublicUrl(path).data.publicUrl
    await must(supabase.from('corr_files').insert({ corr_id: corrId, url, name: clean(name)?.slice(0, 160) || `archivo.${FILE_TYPES[m[1]]}`, mime: m[1], kind, created_by: userId }))
  }
  const log = (corrId, req, action, extra = {}) => supabase.from('corr_events').insert({ corr_id: corrId, action, user_id: req.user.id, ...extra })

  const SELECT = '*, area:corr_areas(id, name, prefix), recipient:users!correspondence_recipient_user_id_fkey(id, name, last_name, email), creator:users!correspondence_created_by_fkey(name, last_name), site:sites(name)'
  const dueInfo = (c) => {
    if (!c.due_date || !OPEN.includes(c.status)) return { dueDays: null, overdue: false }
    const left = cal.businessDaysBetween(todayBogota(), c.due_date)
    return { dueDays: left, overdue: left < 0 }
  }
  const dto = (c) => ({
    id: c.id, code: c.code, direction: c.direction, kind: c.kind, kindLabel: KINDS[c.kind] || c.kind, subject: c.subject, description: c.description,
    sender: { name: c.sender_name, org: c.sender_org, doc: c.sender_doc, contact: c.sender_contact, address: c.sender_address },
    carrier: c.carrier, trackingNumber: c.tracking_number, folios: c.folios, attachmentsDesc: c.attachments_desc, receivedAt: c.received_at,
    area: c.area ? { id: c.area.id, name: c.area.name, prefix: c.area.prefix } : null, recipient: c.recipient ? { id: c.recipient.id, name: fullName(c.recipient) } : null,
    siteName: c.site?.name ?? null, priority: c.priority, requiresResponse: c.requires_response, dueDate: c.due_date, ...dueInfo(c),
    status: c.status, statusLabel: STATUS[c.status], parentId: c.parent_id, deliveredAt: c.delivered_at, deliveredTo: c.delivered_to, deliverySignatureUrl: c.delivery_signature_url,
    closedAt: c.closed_at, createdBy: fullName(c.creator), createdAt: c.created_at, updatedAt: c.updated_at
  })
  const canSee = (req, c) => isReception(req.user) || c.recipient_user_id === req.user.id || c.created_by === req.user.id
  const load = async (req, id) => {
    const c = await must(supabase.from('correspondence').select(SELECT).eq('id', Number(id)).maybeSingle())
    if (!c || !canSee(req, c)) throw httpError(404, 'Radicado no encontrado')
    const site = scopeSite(req)
    if (site && c.site_id && c.site_id !== site && req.user.role !== 'administrador' && c.recipient_user_id !== req.user.id) throw httpError(404, 'Radicado no encontrado')
    return c
  }
  const nextCode = async (areaId, prefix, direction) => {
    const year = Number(todayBogota().slice(0, 4))
    const { data, error } = await supabase.rpc('corr_next', { p_area: areaId, p_direction: direction, p_year: year })
    if (error) throw error
    return `${DIR_PREFIX[direction]}-${prefix}-${year}-${String(data).padStart(4, '0')}`
  }

  // ---------------------------------------------------------------- Catálogos y áreas
  app.get('/correspondencia/catalogos', auth(ANY), hx(async (req, res) => {
    const [areas, users, members] = await Promise.all([
      must(supabase.from('corr_areas').select('id, name, prefix, active, manager_user_id').order('name')),
      isReception(req.user) ? must(supabase.from('users').select('id, name, last_name, role').eq('active', true).neq('role', 'estudiante').order('name')) : [],
      // IIPS-036: personas de cada área (al radicar solo se ofrecen las del área elegida).
      supabase.from('corr_area_members').select('area_id, user_id').then((r) => r.data || [])
    ])
    res.send({ kinds: KINDS, statuses: STATUS, responseTypes: RESPONSE_TYPES, responseDays: RESPONSE_DAYS, next: NEXT, areas: areas.map((a) => ({ id: a.id, name: a.name, prefix: a.prefix, active: a.active, managerUserId: a.manager_user_id, memberIds: members.filter((m) => m.area_id === a.id).map((m) => m.user_id) })), users: users.map((u) => ({ id: u.id, name: fullName(u), role: u.role })) })
  }))
  app.post('/correspondencia/areas', auth(ADMIN), hx(async (req, res) => {
    const name = clean(req.body?.name); const prefix = clean(req.body?.prefix)?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    if (!name || !prefix) return fail(res, 'Nombre y prefijo son requeridos', 400)
    const { data, error } = await supabase.from('corr_areas').insert({ name, prefix, manager_user_id: Number(req.body?.managerUserId) || null }).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un área con ese prefijo', 409); throw error }
    res.status(201).send(data)
  }))
  app.put('/correspondencia/areas/:id/miembros', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const ids = [...new Set((req.body?.userIds || []).map(Number).filter(Boolean))]
    await must(supabase.from('corr_area_members').delete().eq('area_id', id))
    if (ids.length) await must(supabase.from('corr_area_members').insert(ids.map((u) => ({ area_id: id, user_id: u }))))
    res.send({ ok: true, memberIds: ids })
  }))
  app.put('/correspondencia/areas/:id', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}; const row = {}
    if (clean(b.name)) row.name = clean(b.name)
    if ('managerUserId' in b) row.manager_user_id = Number(b.managerUserId) || null
    if ('active' in b) row.active = Boolean(b.active)
    res.send(await must(supabase.from('corr_areas').update(row).eq('id', Number(req.params.id)).select('*').single()))
  }))

  // ---------------------------------------------------------------- Radicar
  app.post('/correspondencia', auth(RECEPTION), hx(async (req, res) => {
    const b = req.body || {}
    const direction = DIR_PREFIX[b.direction] ? b.direction : 'entrada'
    if (!clean(b.subject)) return fail(res, 'Escribe el asunto', 400)
    if (!KINDS[b.kind]) return fail(res, 'Elige el tipo', 400)
    const area = await must(supabase.from('corr_areas').select('id, prefix, active, manager_user_id').eq('id', Number(b.areaId)).maybeSingle())
    if (!area || !area.active) return fail(res, 'Elige el área a la que va dirigido', 400)
    let recipient = Number(b.recipientUserId) || area.manager_user_id || null
    if (recipient) { const u = await must(supabase.from('users').select('id, active').eq('id', recipient).maybeSingle()); if (!u || !u.active) return fail(res, 'Destinatario inválido', 400) }
    if (direction === 'entrada' && !clean(b.senderName) && !clean(b.senderOrg)) return fail(res, 'Indica quién envía (persona o entidad)', 400)
    const receivedAt = b.receivedAt ? new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(b.receivedAt) ? b.receivedAt : `${b.receivedAt}:00-05:00`) : new Date()
    if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 300000) return fail(res, 'Fecha de recibido inválida', 400)
    const requiresResponse = Boolean(b.requiresResponse)
    let due = clean(b.dueDate)
    if (requiresResponse && !due) due = cal.addBusinessDays(receivedAt.toISOString().slice(0, 10), RESPONSE_DAYS[b.responseType] || RESPONSE_DAYS.general)
    const files = Array.isArray(b.files) ? b.files.slice(0, 15) : []
    const code = await nextCode(area.id, area.prefix, direction)
    const row = {
      code, direction, kind: b.kind, subject: clean(b.subject).slice(0, 300), description: clean(b.description)?.slice(0, 4000) ?? null,
      sender_name: clean(b.senderName), sender_org: clean(b.senderOrg), sender_doc: clean(b.senderDoc), sender_contact: clean(b.senderContact), sender_address: clean(b.senderAddress),
      carrier: clean(b.carrier), tracking_number: clean(b.trackingNumber), folios: Number(b.folios) || null, attachments_desc: clean(b.attachmentsDesc),
      received_at: receivedAt.toISOString(), area_id: area.id, recipient_user_id: recipient, site_id: scopeSite(req) || req.user.site_id || null,
      priority: b.priority === 'urgente' ? 'urgente' : 'normal', requires_response: requiresResponse, due_date: requiresResponse ? due : null,
      parent_id: Number(b.parentId) || null, created_by: req.user.id
    }
    const c = await must(supabase.from('correspondence').insert(row).select('id').single())
    for (const f of files) await uploadFile(c.id, f.data, f.name, f.kind || 'soporte', req.user.id)
    await log(c.id, req, 'radicado', { to_status: 'radicado', to_user_id: recipient, to_area_id: area.id, note: row.parent_id ? 'Respuesta a un radicado' : null })
    if (row.parent_id) {
      const p = await must(supabase.from('correspondence').select('id, status').eq('id', row.parent_id).maybeSingle())
      if (p && OPEN.includes(p.status)) { await must(supabase.from('correspondence').update({ status: 'respondido', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', p.id)); await log(p.id, req, 'respondido', { from_status: p.status, to_status: 'respondido', note: `Respuesta ${code}` }) }
    }
    res.status(201).send(dto(await load(req, c.id)))
  }))

  // ---------------------------------------------------------------- Consulta
  app.get('/correspondencia', auth(ANY), hx(async (req, res) => {
    let q = supabase.from('correspondence').select(SELECT).order('received_at', { ascending: false }).limit(500)
    const box = req.query.bandeja
    if (box === 'mia' || !isReception(req.user)) q = q.eq('recipient_user_id', req.user.id)
    const site = scopeSite(req)
    if (site && box !== 'mia' && isReception(req.user) && req.user.role !== 'administrador') q = q.or(`site_id.eq.${site},site_id.is.null`)
    if (Number(req.query.area)) q = q.eq('area_id', Number(req.query.area))
    if (STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
    if (req.query.estado === 'abiertos') q = q.in('status', OPEN)
    if (DIR_PREFIX[req.query.sentido]) q = q.eq('direction', req.query.sentido)
    if (KINDS[req.query.tipo]) q = q.eq('kind', req.query.tipo)
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) q = q.gte('received_at', `${req.query.desde}T00:00:00-05:00`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) q = q.lte('received_at', `${req.query.hasta}T23:59:59-05:00`)
    const text = clean(req.query.q)?.replace(/[%_,()]/g, '')
    if (text) q = q.or(`code.ilike.%${text}%,subject.ilike.%${text}%,sender_name.ilike.%${text}%,sender_org.ilike.%${text}%,tracking_number.ilike.%${text}%`)
    let rows = (await must(q)).map(dto)
    if (req.query.vencidos === '1') rows = rows.filter((r) => r.overdue)
    res.send(rows)
  }))
  app.get('/correspondencia/:id', auth(ANY), hx(async (req, res) => {
    const c = await load(req, req.params.id)
    const [files, events, children, parent] = await Promise.all([
      must(supabase.from('corr_files').select('id, url, name, mime, kind, created_at').eq('corr_id', c.id).order('id')),
      must(supabase.from('corr_events').select('*, user:users!corr_events_user_id_fkey(name, last_name), to_user:users!corr_events_to_user_id_fkey(name, last_name), to_area:corr_areas(name)').eq('corr_id', c.id).order('created_at')),
      must(supabase.from('correspondence').select('id, code, subject, status, direction, received_at').eq('parent_id', c.id).order('id')),
      c.parent_id ? must(supabase.from('correspondence').select('id, code, subject').eq('id', c.parent_id).maybeSingle()) : null
    ])
    res.send({
      ...dto(c), files: files.map((f) => ({ id: f.id, url: f.url, name: f.name, mime: f.mime, kind: f.kind, createdAt: f.created_at })),
      events: events.map((e) => ({ id: e.id, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, user: fullName(e.user), toUser: fullName(e.to_user), toArea: e.to_area?.name ?? null, note: e.note, at: e.created_at })),
      children: children.map((x) => ({ id: x.id, code: x.code, subject: x.subject, status: x.status, statusLabel: STATUS[x.status], direction: x.direction, receivedAt: x.received_at })),
      parent: parent ? { id: parent.id, code: parent.code, subject: parent.subject } : null,
      can: { manage: isReception(req.user), act: isReception(req.user) || c.recipient_user_id === req.user.id, next: NEXT[c.status] }
    })
  }))

  // ---------------------------------------------------------------- Movimientos
  app.post('/correspondencia/:id/estado', auth(ANY), hx(async (req, res) => {
    const c = await load(req, req.params.id)
    const to = req.body?.status
    if (!isReception(req.user) && c.recipient_user_id !== req.user.id) return fail(res, 'Solo recepción o el destinatario cambian el estado', 403)
    if (!NEXT[c.status]?.includes(to)) return fail(res, `No se puede pasar de ${STATUS[c.status]} a ${STATUS[to] || to}`, 400)
    if (to === 'anulado' && req.user.role !== 'administrador') return fail(res, 'Solo el administrador anula radicados', 403)
    const note = clean(req.body?.note)?.slice(0, 1000) ?? null
    if (['devuelto', 'anulado'].includes(to) && !note) return fail(res, 'Indica el motivo', 400)
    const row = { status: to, updated_at: new Date().toISOString() }
    if (to === 'entregado') {
      row.delivered_at = new Date().toISOString(); row.delivered_to = clean(req.body?.deliveredTo) || fullName(req.user)
      if (req.body?.signature) { const url = await uploadImage('signatures', `recibido-${c.id}`, req.body.signature, ['image/png', 'image/jpeg']); if (!url) return fail(res, 'Firma inválida', 400); row.delivery_signature_url = url }
    }
    if (['respondido', 'archivado', 'anulado'].includes(to)) row.closed_at = new Date().toISOString()
    await must(supabase.from('correspondence').update(row).eq('id', c.id))
    await log(c.id, req, to, { from_status: c.status, to_status: to, note })
    res.send(dto(await load(req, c.id)))
  }))
  app.post('/correspondencia/:id/reasignar', auth(ANY), hx(async (req, res) => {
    const c = await load(req, req.params.id)
    if (!isReception(req.user) && c.recipient_user_id !== req.user.id) return fail(res, 'Solo recepción o el destinatario reasignan', 403)
    if (!OPEN.includes(c.status)) return fail(res, 'El radicado ya está cerrado', 400)
    const note = clean(req.body?.note)
    if (!note) return fail(res, 'Indica el motivo de la reasignación', 400)
    const areaId = Number(req.body?.areaId) || c.area_id
    const userId = Number(req.body?.userId) || null
    if (userId) { const u = await must(supabase.from('users').select('id, active').eq('id', userId).maybeSingle()); if (!u?.active) return fail(res, 'Destinatario inválido', 400) }
    await must(supabase.from('correspondence').update({ area_id: areaId, recipient_user_id: userId, status: c.status === 'devuelto' ? 'radicado' : c.status, updated_at: new Date().toISOString() }).eq('id', c.id))
    await log(c.id, req, 'reasignado', { to_user_id: userId, to_area_id: areaId, note })
    res.send(dto(await load(req, c.id)))
  }))
  app.post('/correspondencia/:id/archivos', auth(ANY), hx(async (req, res) => {
    const c = await load(req, req.params.id)
    if (!isReception(req.user) && c.recipient_user_id !== req.user.id) return fail(res, 'Sin permiso', 403)
    for (const f of (req.body?.files || []).slice(0, 10)) await uploadFile(c.id, f.data, f.name, f.kind || 'soporte', req.user.id)
    await log(c.id, req, 'archivo', { note: `${(req.body?.files || []).length} archivo(s)` })
    res.send({ ok: true })
  }))
  app.post('/correspondencia/:id/nota', auth(ANY), hx(async (req, res) => {
    const c = await load(req, req.params.id)
    const note = clean(req.body?.note)
    if (!note) return fail(res, 'Escribe la anotación', 400)
    await log(c.id, req, 'nota', { note: note.slice(0, 1000) })
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Dashboard
  app.get('/correspondencia-resumen', auth(RECEPTION), hx(async (req, res) => {
    const since = new Date(Date.now() - 180 * 86400000).toISOString()
    const rows = (await must(supabase.from('correspondence').select(SELECT).gte('received_at', since).limit(5000))).map(dto)
    const ym = todayBogota().slice(0, 7)
    const month = rows.filter((r) => r.receivedAt.slice(0, 7) === ym)
    const closed = rows.filter((r) => r.requiresResponse && r.closedAt)
    const avgDays = closed.length ? Math.round(closed.reduce((a, r) => a + cal.businessDaysBetween(r.receivedAt, r.closedAt), 0) / closed.length * 10) / 10 : null
    const onTime = closed.filter((r) => !r.dueDate || r.closedAt.slice(0, 10) <= r.dueDate).length
    const months = []; for (let i = 5; i >= 0; i--) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); const k = d.toISOString().slice(0, 7); months.push({ key: k, label: new Intl.DateTimeFormat('es-CO', { month: 'short', timeZone: 'UTC' }).format(d).replace('.', ''), entrada: 0, salida: 0, interna: 0 }) }
    for (const r of rows) { const m = months.find((x) => x.key === r.receivedAt.slice(0, 7)); if (m) m[r.direction] += 1 }
    const by = (fn) => Object.values(rows.reduce((a, r) => { const k = fn(r) || 'Sin dato'; a[k] = a[k] || { name: k, value: 0 }; a[k].value += 1; return a }, {})).sort((a, b) => b.value - a.value)
    res.send({
      kpis: { month: month.length, open: rows.filter((r) => OPEN.includes(r.status)).length, overdue: rows.filter((r) => r.overdue).length, dueSoon: rows.filter((r) => r.dueDays != null && r.dueDays >= 0 && r.dueDays <= 3).length, avgResponseDays: avgDays, onTimePct: closed.length ? Math.round((onTime / closed.length) * 100) : null, undelivered: rows.filter((r) => r.status === 'radicado').length },
      months, byStatus: by((r) => r.statusLabel), byArea: by((r) => r.area?.name), byKind: by((r) => r.kindLabel),
      overdue: rows.filter((r) => r.overdue).sort((a, b) => a.dueDays - b.dueDays).slice(0, 15),
      recent: rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 10)
    })
  }))

  // ---------------------------------------------------------------- Avisos
  alerts.register({
    key: 'correspondencia_mia', route: '/correspondencia/bandeja',
    run: async (req) => (await must(supabase.from('correspondence').select('id, code, subject, status, due_date, priority, kind').eq('recipient_user_id', req.user.id).in('status', OPEN).limit(100))).map((c) => {
      const left = c.due_date ? cal.businessDaysBetween(todayBogota(), c.due_date) : null
      return { id: `${c.id}:${c.status}`, level: left != null && left < 0 ? 'bad' : c.priority === 'urgente' || (left != null && left <= 3) ? 'warn' : 'info', title: `${c.code} · ${c.subject}`, message: left == null ? `${STATUS[c.status]} · ${KINDS[c.kind] || ''}` : left < 0 ? `Respuesta vencida hace ${-left} día(s) hábil(es)` : `Responder en ${left} día(s) hábil(es)`, link: `/correspondencia/${c.id}`, date: c.due_date }
    })
  })
  alerts.register({
    key: 'correspondencia_recepcion', route: '/correspondencia/registro', roles: ['administrador', 'empleado'], module: 'correspondencia',
    run: async () => (await must(supabase.from('correspondence').select('id, code, subject, status, due_date, received_at').in('status', ['radicado', 'devuelto']).limit(100)))
      .filter((c) => c.status === 'devuelto' || Date.now() - new Date(c.received_at).getTime() > 86400000)
      .map((c) => ({ id: `${c.id}:${c.status}`, level: c.status === 'devuelto' ? 'warn' : 'info', title: `${c.code} · ${c.subject}`, message: c.status === 'devuelto' ? 'Devuelto: reasígnalo' : 'Radicado hace más de un día sin entregar', link: `/correspondencia/${c.id}` }))
  })
}
