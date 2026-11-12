// =====================================================================
// Estándares transversales · repositorio de documentos por estándar
// (inicia con 5. Procesos prioritarios: guías, protocolos, procedimientos y formatos).
// Archivos PDF, imágenes, Word y Excel con nombre, categoría, versión y observaciones.
// =====================================================================
const crypto = require('crypto')
const { htmlFields } = require('./htmldoc')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite } = deps
  const STAFF = ['administrador', 'empleado']
  const BUCKET = 'estandares'
  const MAX = 15 * 1024 * 1024
  const STANDARDS = { procesos_prioritarios: 'Procesos prioritarios', interdependencia: 'Interdependencia de servicios', medicamentos: 'Medicamentos, dispositivos médicos e insumos', infraestructura: 'Infraestructura', historia_clinica: 'Historia clínica y registros' }
  const WARN_DAYS = 30
  const CATEGORIES = {
    procesos_prioritarios: ['Guía de práctica clínica', 'Protocolo', 'Procedimiento', 'Manual', 'Formato', 'Instructivo', 'Programa', 'Política', 'Plan', 'Imagen / evidencia', 'Otro'],
    historia_clinica: ['Manual', 'Formato de historia clínica', 'Procedimiento', 'Consentimiento informado', 'Auditoría', 'Acta de comité', 'Política', 'Instructivo', 'Imagen / evidencia', 'Otro'],
    infraestructura: ['Plano', 'Certificado / concepto', 'Licencia', 'Procedimiento', 'Cronograma', 'Registro de mantenimiento', 'Acta', 'Plan de emergencias', 'Registro fotográfico', 'Planilla', 'Otro'],
    medicamentos: ['Política / programa', 'Procedimiento', 'Protocolo', 'Formato', 'Registro sanitario / INVIMA', 'Ficha técnica', 'Certificado de proveedor', 'Acta / informe', 'Farmacovigilancia / tecnovigilancia', 'Imagen / evidencia', 'Otro'],
    interdependencia: ['Convenio', 'Contrato', 'Directorio', 'Procedimiento', 'Acta / seguimiento', 'Soporte / evidencia', 'Otro']
  }
  const TYPES = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/html': 'html'
  }
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const standardOf = (req) => { const s = req.params.standard; if (!STANDARDS[s]) throw httpError(404, 'Estándar no disponible'); return s }

  const upload = async (standard, file) => {
    const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(file?.data || '')
    if (!m || !TYPES[m[1]] || m[1] === 'text/html') throw httpError(400, 'Tipo de archivo no permitido. Carga PDF, imágenes (PNG, JPG), Word o Excel.')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > MAX) throw httpError(400, 'El archivo supera 15 MB')
    const path = `${standard}/${crypto.randomBytes(10).toString('hex')}.${TYPES[m[1]]}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: m[1], upsert: false })
    if (error) throw error
    const name = (clean(file.name) || `documento.${TYPES[m[1]]}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160)
    return { file_url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, file_path: path, file_name: name, file_type: m[1], file_size: buffer.length }
  }
  const remove = async (path) => { if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {}) }

  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const validity = (iso) => (!iso ? null : daysUntil(iso) < 0 ? 'vencido' : daysUntil(iso) <= WARN_DAYS ? 'por_vencer' : 'vigente')
  const SELECT = '*, required:std_required_docs(name, code), site:sites(name), creator:users!std_documents_created_by_fkey(name, last_name), editor:users!std_documents_updated_by_fkey(name, last_name)'
  const dto = (d) => ({
    id: d.id, standard: d.standard, siteId: d.site_id, siteName: d.site?.name ?? null, name: d.name, category: d.category, code: d.code, version: d.version,
    observations: d.observations, requiredId: d.required_id, requiredName: d.required?.name ?? null, requiredCode: d.required?.code ?? null,
    validUntil: d.valid_until, validity: validity(d.valid_until), daysLeft: d.valid_until ? daysUntil(d.valid_until) : null, fileUrl: d.file_url, fileName: d.file_name, fileType: d.file_type, fileExt: TYPES[d.file_type], fileSize: d.file_size,
      description: d.description ?? null, isHtml: d.file_type === 'text/html', contentHtml: d.content_html ?? null,
    createdBy: d.creator ? `${d.creator.name} ${d.creator.last_name}` : null, createdById: d.created_by, updatedBy: d.editor ? `${d.editor.name} ${d.editor.last_name}` : null,
    createdAt: d.created_at, updatedAt: d.updated_at
  })
  const row = (b) => {
    const name = clean(b.name)
    if (!name) throw httpError(400, 'El nombre del documento es requerido')
    const until = clean(b.validUntil)
    if (until && !ISO_DATE.test(until)) throw httpError(400, 'Fecha de vigencia inválida')
    return { name: name.slice(0, 200), category: clean(b.category), code: clean(b.code), version: clean(b.version), observations: clean(b.observations), description: clean(b.description), required_id: Number(b.requiredId) || null, valid_until: until }
  }
  const load = async (req) => {
    const { data, error } = await supabase.from('std_documents').select(SELECT).eq('id', Number(req.params.id)).eq('standard', standardOf(req)).maybeSingle()
    if (error) throw error
    if (!data || (data.site_id && !canAccessSite(req, data.site_id))) throw httpError(404, 'Documento no encontrado')
    return data
  }
  // Documentos de una sede, o generales (sin sede) para toda la IPS.
  const siteFor = (req, v) => {
    if (req.user.role !== 'administrador') return req.user.site_id
    return v === '' || v === null || v === undefined || v === 'general' ? null : Number(v) || null
  }

  app.get('/estandares/documentos/:standard/catalogos', auth(STAFF), hx(async (req, res) => {
    const s = standardOf(req)
    const [reqs, follow, format, followFormat] = await Promise.all([loadRequired(s), loadRequired(s, false, 'seguimiento'), loadFormat(`std_${s}`), loadFormat(`std_${s}_seguimiento`)])
    res.send({ standard: s, label: STANDARDS[s], categories: CATEGORIES[s] || [], maxSize: MAX, types: TYPES, required: reqs.map(reqDTO), followTemplate: follow.map(reqDTO), format, followFormat })
  }))

  app.get('/estandares/documentos/:standard', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('std_documents').select(SELECT).eq('standard', standardOf(req)).order('category', { nullsFirst: false }).order('name')
    const site = scopeSite(req)
    if (site) q = q.or(`site_id.is.null,site_id.eq.${site}`)
    if (clean(req.query.categoria)) q = q.eq('category', clean(req.query.categoria))
    const { data, error } = await q
    if (error) throw error
    let rows = data.map(dto)
    const text = clean(req.query.q)?.toLowerCase()
    if (text) rows = rows.filter((d) => [d.name, d.code, d.category, d.observations, d.fileName].some((v) => v && v.toLowerCase().includes(text)))
    if (clean(req.query.tipo)) rows = rows.filter((d) => ({ pdf: ['pdf'], imagen: ['png', 'jpg', 'webp'], word: ['doc', 'docx'], excel: ['xls', 'xlsx'], html: ['html'] }[req.query.tipo] || []).includes(d.fileExt))
    res.send(rows)
  }))

  app.post('/estandares/documentos/:standard', auth(STAFF), hx(async (req, res) => {
    const s = standardOf(req)
    const r = row(req.body || {})
    const isHtml = req.body?.kind === 'html'
    if (!isHtml && !req.body?.file) return fail(res, 'Carga el archivo del documento', 400)
    const f = isHtml ? htmlFields(r.name, req.body.contentHtml, httpError) : await upload(s, req.body.file)
    const { data, error } = await supabase.from('std_documents').insert({ ...r, ...f, standard: s, site_id: siteFor(req, req.body.siteId), created_by: req.user.id, updated_by: req.user.id }).select(SELECT).single()
    if (error) { await remove(f.file_path); throw error }
    res.status(201).send(dto(data))
  }))

  app.put('/estandares/documentos/:standard/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req)
    const upd = { ...row(req.body || {}), updated_by: req.user.id, updated_at: new Date().toISOString() }
    if (req.user.role === 'administrador' && 'siteId' in (req.body || {})) upd.site_id = siteFor(req, req.body.siteId)
    let f = null
    if (cur.file_type === 'text/html') { if ('contentHtml' in (req.body || {})) Object.assign(upd, htmlFields(upd.name, req.body.contentHtml, httpError)) } else if (req.body?.file) { f = await upload(cur.standard, req.body.file); Object.assign(upd, f) }
    const { data, error } = await supabase.from('std_documents').update(upd).eq('id', cur.id).select(SELECT).single()
    if (error) { if (f) await remove(f.file_path); throw error }
    if (f) await remove(cur.file_path)
    res.send(dto(data))
  }))

  // Eliminar: el administrador, o quien lo cargó.
  app.delete('/estandares/documentos/:standard/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await load(req)
    if (!ADMIN.includes(req.user.role) && cur.created_by !== req.user.id) return fail(res, 'Solo el administrador o quien cargó el documento puede eliminarlo', 403)
    const { error } = await supabase.from('std_documents').delete().eq('id', cur.id)
    if (error) throw error
    await remove(cur.file_path)
    res.send({ message: 'Documento eliminado' })
  }))

  // ---------------------------------------------------------------- Carpeta obligatoria
  const reqDTO = (r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, expires: r.expires, sortOrder: r.sort_order, active: r.active })
  const KINDS = ['carpeta', 'seguimiento']
  const kindOf = (req) => (KINDS.includes(req.query.tipo || req.body?.kind) ? (req.query.tipo || req.body.kind) : 'carpeta')
  const loadFormat = async (doc) => {
    const { data } = await supabase.from('th_format_settings').select('*').eq('doc', doc).maybeSingle()
    return data ? { process: data.process, code: data.code, version: data.version, versionDate: data.version_date } : null
  }
  const loadRequired = async (standard, all = false, kind = 'carpeta') => {
    let q = supabase.from('std_required_docs').select('*').eq('standard', standard).eq('kind', kind).order('sort_order').order('name')
    if (!all) q = q.eq('active', true)
    const { data, error } = await q
    if (error) throw error
    return data
  }
  // Sede de la carpeta: la del usuario, o la elegida por el administrador (vacía = documentos generales de la IPS).
  const folderSite = (req) => (req.user.role === 'administrador' ? Number(req.query.sede || req.body?.siteId) || null : req.user.site_id)
  const folderStatus = async (standard, site) => {
    const reqs = await loadRequired(standard)
    let q = supabase.from('std_documents').select(SELECT).eq('standard', standard).not('required_id', 'is', null)
    q = site ? q.or(`site_id.is.null,site_id.eq.${site}`) : q.is('site_id', null)
    const { data, error } = await q
    if (error) throw error
    const docs = data.map(dto)
    return reqs.map((r) => {
      const own = docs.filter((d) => d.requiredId === r.id)
      const valid = own.filter((d) => d.validity !== 'vencido')
      const status = !own.length ? 'faltante' : !valid.length ? 'vencido' : valid.some((d) => d.validity !== 'por_vencer') ? 'cumple' : 'por_vencer'
      return { ...reqDTO(r), status, documents: own.map((d) => ({ id: d.id, name: d.name, fileName: d.fileName, fileUrl: d.fileUrl, fileExt: d.fileExt, isHtml: d.isHtml, contentHtml: d.contentHtml, validUntil: d.validUntil, validity: d.validity, daysLeft: d.daysLeft, siteName: d.siteName })) }
    })
  }
  app.get('/estandares/documentos/:standard/carpeta', auth(STAFF), hx(async (req, res) => {
    const s = standardOf(req)
    const site = folderSite(req)
    const items = await folderStatus(s, site)
    let q = supabase.from('std_checklists').select('id, kind, code, check_date, result, compliant, total, site_id, site:sites(name), reviewer:users!std_checklists_reviewer_id_fkey(name, last_name)').eq('standard', s).order('check_date', { ascending: false }).order('id', { ascending: false }).limit(100)
    if (req.user.role !== 'administrador') q = q.eq('site_id', req.user.site_id)
    else if (site) q = q.eq('site_id', site)
    const { data: all, error } = await q
    if (error) throw error
    const cdto = (c) => ({ id: c.id, siteId: c.site_id, code: c.code, date: c.check_date, result: c.result, compliant: c.compliant, total: c.total, siteName: c.site?.name ?? 'General', reviewer: c.reviewer ? `${c.reviewer.name} ${c.reviewer.last_name}` : null })
    const checks = all.filter((c) => c.kind === 'carpeta')
    res.send({
      siteId: site, items,
      summary: { total: items.length, cumple: items.filter((i) => i.status === 'cumple').length, porVencer: items.filter((i) => i.status === 'por_vencer').length, vencido: items.filter((i) => i.status === 'vencido').length, faltante: items.filter((i) => i.status === 'faltante').length },
      checklists: checks.map(cdto), followups: all.filter((c) => c.kind === 'seguimiento').map(cdto)
    })
  }))

  // Configurar los ítems obligatorios (administrador).
  const reqRow = (b) => {
    if (!clean(b.name)) throw httpError(400, 'El nombre es requerido')
    return { code: clean(b.code), name: clean(b.name), description: clean(b.description), expires: Boolean(b.expires), sort_order: Number(b.sortOrder) || 0, active: b.active !== false }
  }
  app.get('/estandares/documentos/:standard/requeridos', auth(STAFF), hx(async (req, res) => res.send((await loadRequired(standardOf(req), true, kindOf(req))).map(reqDTO))))
  app.post('/estandares/documentos/:standard/requeridos', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('std_required_docs').insert({ ...reqRow(req.body || {}), standard: standardOf(req), kind: kindOf(req) }).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe ese documento obligatorio', 409); throw error }
    res.status(201).send(reqDTO(data))
  }))
  app.put('/estandares/documentos/:standard/requeridos/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('std_required_docs').update(reqRow(req.body || {})).eq('id', Number(req.params.id)).eq('standard', standardOf(req)).select('*').maybeSingle()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe ese documento obligatorio', 409); throw error }
    if (!data) return fail(res, 'No encontrado', 404)
    res.send(reqDTO(data))
  }))
  app.delete('/estandares/documentos/:standard/requeridos/:id', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('std_required_docs').delete().eq('id', Number(req.params.id)).eq('standard', standardOf(req))
    if (error) throw error
    res.send({ message: 'Eliminado' })
  }))
  app.put('/estandares/documentos/:standard/config/formato', auth(ADMIN), hx(async (req, res) => {
    const s = standardOf(req); const b = req.body || {}
    const { error } = await supabase.from('th_format_settings').upsert({ doc: kindOf(req) === 'seguimiento' ? `std_${s}_seguimiento` : `std_${s}`, process: clean(b.process), code: clean(b.code), version: clean(b.version), version_date: clean(b.versionDate), updated_at: new Date().toISOString() })
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Verificación de la carpeta (lista de chequeo)
  app.get('/estandares/documentos/:standard/verificaciones/borrador', auth(STAFF), hx(async (req, res) => {
    const items = await folderStatus(standardOf(req), folderSite(req))
    res.send(items.map((i) => ({
      requiredId: i.id, code: i.code, name: i.name, description: i.description, status: i.status,
      value: i.status === 'cumple' || i.status === 'por_vencer' ? 'si' : 'no',
      observation: i.status === 'faltante' ? 'Documento faltante en la carpeta' : i.status === 'vencido' ? 'Documento vencido' : i.status === 'por_vencer' ? `Vence pronto (${i.documents.map((d) => d.validUntil).filter(Boolean).sort().pop()?.split('-').reverse().join('/') || ''})` : '',
      documents: i.documents.map((d) => d.name)
    })))
  }))
  app.post('/estandares/documentos/:standard/verificaciones', auth(STAFF), hx(async (req, res) => {
    const s = standardOf(req)
    const items = (req.body?.items || []).map((i) => ({ requiredId: Number(i.requiredId) || null, code: clean(i.code), name: clean(i.name), value: ['si', 'no', 'na'].includes(i.value) ? i.value : 'no', observation: clean(i.observation), documents: Array.isArray(i.documents) ? i.documents.slice(0, 20).map(String) : [] }))
    if (!items.length) return fail(res, 'No hay documentos obligatorios configurados', 400)
    if (items.some((i) => !i.name)) return fail(res, 'Ítem inválido', 400)
    if (items.some((i) => i.value === 'na' && !i.observation)) return fail(res, 'Justifica en la observación cada ítem marcado como No aplica', 400)
    const applicable = items.filter((i) => i.value !== 'na')
    const date = clean(req.body?.date)
    if (date && !ISO_DATE.test(date)) return fail(res, 'Fecha inválida', 400)
    const { data, error } = await supabase.from('std_checklists').insert({
      standard: s, site_id: folderSite(req), check_date: date || todayBogota(), reviewer_id: req.user.id, items,
      compliant: applicable.filter((i) => i.value === 'si').length, total: applicable.length,
      result: applicable.some((i) => i.value === 'no') ? 'no_cumple' : 'cumple', observations: clean(req.body?.observations)
    }).select('id').single()
    if (error) throw error
    res.status(201).send({ id: data.id })
  }))
  const getCheck = hx(async (req, res) => {
    const s = standardOf(req)
    const { data: c, error } = await supabase.from('std_checklists').select('*, site:sites(name), reviewer:users!std_checklists_reviewer_id_fkey(name, last_name)').eq('id', Number(req.params.id)).eq('standard', s).maybeSingle()
    if (error) throw error
    if (!c || (c.site_id && !canAccessSite(req, c.site_id))) return fail(res, 'Verificación no encontrada', 404)
    const format = await loadFormat(c.kind === 'seguimiento' ? `std_${s}_seguimiento` : `std_${s}`)
    res.send({
      id: c.id, kind: c.kind, code: c.code, standard: s, standardLabel: STANDARDS[s], siteId: c.site_id, siteName: c.site?.name ?? 'General (todas las sedes)', date: c.check_date, result: c.result,
      compliant: c.compliant, total: c.total, items: c.items, observations: c.observations, reviewerId: c.reviewer_id, reviewer: c.reviewer ? `${c.reviewer.name} ${c.reviewer.last_name}` : null,
      format
    })
  })
  app.get('/estandares/documentos/:standard/verificaciones/:id', auth(STAFF), getCheck)
  app.get('/estandares/documentos/:standard/seguimientos/:id', auth(STAFF), getCheck)

  // ---------------------------------------------------------------- Actividades de seguimiento (Actividad / Hallazgo / Observación)
  const FINDINGS = { ok: 'Ok', parcial: 'Parcial', no_evidencia: 'No se evidencia', na: 'No aplica' }
  app.post('/estandares/documentos/:standard/seguimientos', auth(STAFF), hx(async (req, res) => {
    const s = standardOf(req)
    const items = (req.body?.items || []).map((i) => ({ templateId: Number(i.templateId) || null, activity: clean(i.activity), finding: FINDINGS[i.finding] ? i.finding : 'no_evidencia', detail: clean(i.detail), observation: clean(i.observation) })).filter((i) => i.activity)
    if (!items.length) return fail(res, 'Agrega al menos una actividad', 400)
    const date = clean(req.body?.date)
    if (date && !ISO_DATE.test(date)) return fail(res, 'Fecha inválida', 400)
    const applicable = items.filter((i) => i.finding !== 'na')
    const { data, error } = await supabase.from('std_checklists').insert({
      standard: s, kind: 'seguimiento', site_id: folderSite(req), check_date: date || todayBogota(), reviewer_id: req.user.id, items,
      compliant: applicable.filter((i) => i.finding === 'ok').length, total: applicable.length,
      result: applicable.some((i) => i.finding !== 'ok') ? 'no_cumple' : 'cumple', observations: clean(req.body?.observations)
    }).select('id').single()
    if (error) throw error
    res.status(201).send({ id: data.id })
  }))
  app.delete('/estandares/documentos/:standard/verificaciones/:id', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('std_checklists').delete().eq('id', Number(req.params.id)).eq('standard', standardOf(req))
    if (error) throw error
    res.send({ message: 'Verificación eliminada' })
  }))
}
