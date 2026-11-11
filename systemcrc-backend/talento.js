// =====================================================================
// Estándares transversales · Talento Humano
// Hoja de vida del profesional con sus soportes (PDF), certificados con o sin
// vencimiento, contratos, cargos con sus requisitos, lista de chequeo de
// verificación, alertas y dashboard. Genérico para cualquier IPS.
// =====================================================================
const crypto = require('crypto')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite, targetSite } = deps
  const STAFF = ['administrador', 'empleado']
  const CATEGORIES = { identificacion: 'Identificación', formacion: 'Formación académica', habilitacion: 'Habilitación profesional', curso: 'Cursos y certificaciones', salud: 'Salud ocupacional', contractual: 'Contractual', otro: 'Otro' }
  const CONTRACT_TYPES = { indefinido: 'Término indefinido', termino_fijo: 'Término fijo', obra_labor: 'Obra o labor', prestacion_servicios: 'Prestación de servicios', aprendizaje: 'Aprendizaje', otro: 'Otro' }
  const DOC_TYPES = ['CC', 'CE', 'PA', 'PPT', 'TI']
  const WARN_DAYS = 30
  const FILE_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }

  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e }
  })
  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const num = (v) => (v === '' || v == null ? null : Number(v))
  const dateOrNull = (v) => { const c = clean(v); if (c && !ISO_DATE.test(c)) throw httpError(400, 'Fecha inválida'); return c }

  // Archivos (PDF o imagen) en el bucket talento-humano.
  const uploadFile = async (prefix, dataUrl) => {
    const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(dataUrl || '')
    if (!m || !FILE_TYPES[m[1]]) throw httpError(400, 'Archivo inválido: carga un PDF (o una imagen PNG/JPG)')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > 10 * 1024 * 1024) throw httpError(400, 'El archivo supera 10 MB')
    const path = `${prefix}-${crypto.randomBytes(8).toString('hex')}.${FILE_TYPES[m[1]]}`
    const { error } = await supabase.storage.from('talento-humano').upload(path, buffer, { contentType: m[1], upsert: false })
    if (error) throw error
    return supabase.storage.from('talento-humano').getPublicUrl(path).data.publicUrl
  }
  const removeFile = async (url) => {
    const marker = '/object/public/talento-humano/'
    const i = (url || '').indexOf(marker)
    if (i !== -1) await supabase.storage.from('talento-humano').remove([url.slice(i + marker.length)]).catch(() => {})
  }

  // ---------------------------------------------------------------- Catálogos: requisitos y cargos
  const reqDTO = (r) => ({ id: r.id, name: r.name, category: r.category, categoryLabel: CATEGORIES[r.category], expires: r.expires, validityMonths: r.validity_months, description: r.description, active: r.active })
  const loadPositions = async () => {
    const { data, error } = await supabase.from('th_positions').select('*, th_position_requirements(requirement_type_id, mandatory)').order('name')
    if (error) throw error
    return data.map((p) => ({ id: p.id, name: p.name, description: p.description, active: p.active, requirements: (p.th_position_requirements || []).map((r) => ({ requirementTypeId: r.requirement_type_id, mandatory: r.mandatory })) }))
  }
  app.get('/estandares/th/catalogos', auth(STAFF), hx(async (req, res) => {
    const { data: reqs, error } = await supabase.from('th_requirement_types').select('*').order('category').order('name')
    if (error) throw error
    res.send({ categories: CATEGORIES, contractTypes: CONTRACT_TYPES, documentTypes: DOC_TYPES, warnDays: WARN_DAYS, requirements: reqs.map(reqDTO), positions: await loadPositions() })
  }))

  const reqRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre es requerido')
    if (!CATEGORIES[b.category]) e.push('Categoría inválida')
    const vm = num(b.validityMonths)
    if (vm != null && (!Number.isInteger(vm) || vm < 1 || vm > 240)) e.push('Vigencia inválida (1 a 240 meses)')
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name), category: b.category, expires: Boolean(b.expires), validity_months: b.expires ? vm : null, description: clean(b.description), active: b.active !== false }
  }
  app.post('/estandares/th/requisitos', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('th_requirement_types').insert(reqRow(req.body || {})).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un requisito con ese nombre', 409); throw error }
    res.status(201).send(reqDTO(data))
  }))
  app.put('/estandares/th/requisitos/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('th_requirement_types').update(reqRow(req.body || {})).eq('id', Number(req.params.id)).select('*').maybeSingle()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un requisito con ese nombre', 409); throw error }
    if (!data) return fail(res, 'Requisito no encontrado', 404)
    res.send(reqDTO(data))
  }))
  app.delete('/estandares/th/requisitos/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count } = await supabase.from('th_documents').select('id', { count: 'exact', head: true }).eq('requirement_type_id', id)
    if (count) return fail(res, 'El requisito ya tiene soportes cargados. Desactívalo en lugar de eliminarlo.', 409)
    const { error } = await supabase.from('th_requirement_types').delete().eq('id', id)
    if (error) throw error
    res.send({ message: 'Requisito eliminado' })
  }))

  const savePosition = async (b, id) => {
    if (!clean(b.name)) throw httpError(400, 'El nombre del cargo es requerido')
    const row = { name: clean(b.name), description: clean(b.description), active: b.active !== false }
    const r = id ? await supabase.from('th_positions').update(row).eq('id', id).select('id').maybeSingle() : await supabase.from('th_positions').insert(row).select('id').single()
    if (r.error) { if (r.error.code === '23505') throw httpError(409, 'Ya existe un cargo con ese nombre'); throw r.error }
    if (!r.data) throw httpError(404, 'Cargo no encontrado')
    const pid = r.data.id
    await supabase.from('th_position_requirements').delete().eq('position_id', pid)
    const reqs = (b.requirements || []).filter((x) => Number(x.requirementTypeId)).map((x) => ({ position_id: pid, requirement_type_id: Number(x.requirementTypeId), mandatory: x.mandatory !== false }))
    if (reqs.length) { const ins = await supabase.from('th_position_requirements').insert(reqs); if (ins.error) throw ins.error }
    return (await loadPositions()).find((p) => p.id === pid)
  }
  app.post('/estandares/th/cargos', auth(ADMIN), hx(async (req, res) => res.status(201).send(await savePosition(req.body || {}))))
  app.put('/estandares/th/cargos/:id', auth(ADMIN), hx(async (req, res) => res.send(await savePosition(req.body || {}, Number(req.params.id)))))
  app.delete('/estandares/th/cargos/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count } = await supabase.from('th_staff').select('id', { count: 'exact', head: true }).eq('position_id', id)
    if (count) return fail(res, 'Hay profesionales con este cargo. Desactívalo en lugar de eliminarlo.', 409)
    const { error } = await supabase.from('th_positions').delete().eq('id', id)
    if (error) throw error
    res.send({ message: 'Cargo eliminado' })
  }))

  // ---------------------------------------------------------------- Cumplimiento
  const docStatus = (d) => {
    if (!d) return 'faltante'
    if (!d.expires || !d.expiry_date) return 'vigente'
    const left = daysUntil(d.expiry_date)
    return left < 0 ? 'vencido' : left <= WARN_DAYS ? 'por_vencer' : 'vigente'
  }
  const contractStatus = (c) => {
    if (!c) return 'sin_contrato'
    if (!c.end_date) return 'vigente'
    const left = daysUntil(c.end_date)
    return left < 0 ? 'vencido' : left <= WARN_DAYS ? 'por_vencer' : 'vigente'
  }
  // Requisitos del cargo frente a los soportes cargados (el más reciente por requisito).
  const compliance = (staff, positions, reqTypes, docs) => {
    const pos = positions.find((p) => p.id === staff.position_id)
    const items = (pos?.requirements || []).map((pr) => {
      const rt = reqTypes.find((r) => r.id === pr.requirementTypeId)
      const own = docs.filter((d) => d.requirement_type_id === pr.requirementTypeId).sort((a, b) => String(b.expiry_date || b.issue_date || b.created_at).localeCompare(String(a.expiry_date || a.issue_date || a.created_at)))
      const d = own[0]
      return { requirementTypeId: pr.requirementTypeId, name: rt?.name || '—', category: rt?.category, mandatory: pr.mandatory, status: docStatus(d), documentId: d?.id ?? null, expiryDate: d?.expiry_date ?? null, fileUrl: d?.file_url ?? null }
    })
    const mandatory = items.filter((i) => i.mandatory)
    const ok = mandatory.filter((i) => i.status === 'vigente' || i.status === 'por_vencer').length
    return { items, mandatory: mandatory.length, ok, percent: mandatory.length ? Math.round((ok / mandatory.length) * 100) : 100, missing: mandatory.filter((i) => i.status === 'faltante').length, expired: items.filter((i) => i.status === 'vencido').length, expiring: items.filter((i) => i.status === 'por_vencer').length }
  }
  const docDTO = (d) => ({
    id: d.id, requirementTypeId: d.requirement_type_id, name: d.name, category: d.category, categoryLabel: CATEGORIES[d.category], issuer: d.issuer, issueDate: d.issue_date,
    expires: d.expires, expiryDate: d.expiry_date, daysLeft: d.expires && d.expiry_date ? daysUntil(d.expiry_date) : null, status: docStatus(d), hours: d.hours == null ? null : Number(d.hours),
    fileUrl: d.file_url, notes: d.notes, verified: Boolean(d.verified_at), verifiedAt: d.verified_at, verifiedBy: d.verifier ? `${d.verifier.name} ${d.verifier.last_name}` : null, createdAt: d.created_at
  })
  const contractDTO = (c) => ({ id: c.id, contractType: c.contract_type, contractTypeLabel: CONTRACT_TYPES[c.contract_type], number: c.number, startDate: c.start_date, endDate: c.end_date, weeklyHours: c.weekly_hours == null ? null : Number(c.weekly_hours), positionName: c.position_name, notes: c.notes, fileUrl: c.file_url, status: contractStatus(c), daysLeft: c.end_date ? daysUntil(c.end_date) : null })
  const currentContract = (cs) => [...cs].sort((a, b) => b.start_date.localeCompare(a.start_date))[0] || null
  const staffBase = (s) => ({
    id: s.id, siteId: s.site_id, siteName: s.site?.name ?? null, userId: s.user_id, positionId: s.position_id, positionName: s.position?.name ?? null,
    documentType: s.document_type, document: s.document, firstName: s.first_name, lastName: s.last_name, fullName: `${s.first_name} ${s.last_name}`,
    birthDate: s.birth_date, sex: s.sex, bloodType: s.blood_type, phone: s.phone, email: s.email, address: s.address, city: s.city, profession: s.profession,
    professionalCard: s.professional_card, rethus: s.rethus, eps: s.eps, arl: s.arl, pensionFund: s.pension_fund, severanceFund: s.severance_fund,
    emergencyContact: s.emergency_contact, emergencyPhone: s.emergency_phone, photoUrl: s.photo_url, ipsServiceId: s.ips_service_id, ipsServiceName: s.service?.name ?? null,
    notes: s.notes, active: s.active
  })
  const STAFF_SELECT = '*, site:sites(name), position:th_positions(name), service:ips_services(name)'

  const loadAll = async (site) => {
    let q = supabase.from('th_staff').select(STAFF_SELECT).order('first_name')
    if (site) q = q.eq('site_id', site)
    const [staff, positions, reqs, docs, contracts, checks] = await Promise.all([
      q, loadPositions(), supabase.from('th_requirement_types').select('*'),
      supabase.from('th_documents').select('id, staff_id, requirement_type_id, name, expires, expiry_date, issue_date, created_at, file_url'),
      supabase.from('th_contracts').select('*'),
      supabase.from('th_checklists').select('staff_id, check_date, result, code').order('check_date', { ascending: false })
    ])
    for (const r of [staff, reqs, docs, contracts, checks]) if (r.error) throw r.error
    return staff.data.map((s) => {
      const ds = docs.data.filter((d) => d.staff_id === s.id)
      const cur = currentContract(contracts.data.filter((c) => c.staff_id === s.id))
      const last = checks.data.find((c) => c.staff_id === s.id)
      return {
        ...staffBase(s), compliance: compliance(s, positions, reqs.data, ds), documents: ds.length,
        expiringDocs: ds.filter((d) => docStatus(d) === 'por_vencer').map((d) => ({ name: d.name, expiryDate: d.expiry_date, daysLeft: daysUntil(d.expiry_date) })),
        expiredDocs: ds.filter((d) => docStatus(d) === 'vencido').map((d) => ({ name: d.name, expiryDate: d.expiry_date })),
        contract: cur ? contractDTO(cur) : null, lastChecklist: last ? { code: last.code, date: last.check_date, result: last.result } : null
      }
    })
  }

  // ---------------------------------------------------------------- Hojas de vida
  app.get('/estandares/th/personal', auth(STAFF), hx(async (req, res) => {
    let rows = await loadAll(scopeSite(req))
    const q = clean(req.query.q)?.toLowerCase()
    if (q) rows = rows.filter((r) => [r.fullName, r.document, r.positionName, r.profession].some((v) => v && v.toLowerCase().includes(q)))
    if (Number(req.query.cargo)) rows = rows.filter((r) => r.positionId === Number(req.query.cargo))
    if (req.query.estado === 'activos') rows = rows.filter((r) => r.active)
    if (req.query.estado === 'inactivos') rows = rows.filter((r) => !r.active)
    if (req.query.alerta === '1') rows = rows.filter((r) => r.compliance.percent < 100 || r.compliance.expired || r.compliance.expiring || ['vencido', 'por_vencer', 'sin_contrato'].includes(r.contract?.status || 'sin_contrato'))
    res.send(rows)
  }))

  const loadStaff = async (req) => {
    const { data: s, error } = await supabase.from('th_staff').select(STAFF_SELECT).eq('id', Number(req.params.id)).maybeSingle()
    if (error) throw error
    if (!s || !canAccessSite(req, s.site_id)) throw httpError(404, 'Hoja de vida no encontrada')
    return s
  }
  const staffDetail = async (s) => {
    const [positions, reqs, docs, contracts, checks] = await Promise.all([
      loadPositions(), supabase.from('th_requirement_types').select('*'),
      supabase.from('th_documents').select('*, verifier:users!th_documents_verified_by_fkey(name, last_name)').eq('staff_id', s.id).order('category').order('name'),
      supabase.from('th_contracts').select('*').eq('staff_id', s.id).order('start_date', { ascending: false }),
      supabase.from('th_checklists').select('id, code, check_date, result, compliant, total, reviewer:users!th_checklists_reviewer_id_fkey(name, last_name)').eq('staff_id', s.id).order('check_date', { ascending: false })
    ])
    for (const r of [reqs, docs, contracts, checks]) if (r.error) throw r.error
    return {
      ...staffBase(s), compliance: compliance(s, positions, reqs.data, docs.data),
      documents: docs.data.map(docDTO), contracts: contracts.data.map(contractDTO), contract: contracts.data[0] ? contractDTO(contracts.data[0]) : null,
      checklists: checks.data.map((c) => ({ id: c.id, code: c.code, date: c.check_date, result: c.result, compliant: c.compliant, total: c.total, reviewer: c.reviewer ? `${c.reviewer.name} ${c.reviewer.last_name}` : null }))
    }
  }
  app.get('/estandares/th/personal/:id', auth(STAFF), hx(async (req, res) => res.send(await staffDetail(await loadStaff(req)))))

  const staffRow = (b) => {
    const e = []
    if (!clean(b.document)) e.push('El documento es requerido')
    if (!clean(b.firstName) || !clean(b.lastName)) e.push('Nombres y apellidos son requeridos')
    if (b.documentType && !DOC_TYPES.includes(b.documentType)) e.push('Tipo de documento inválido')
    if (clean(b.phone) && !/^[0-9]{7,10}$/.test(clean(b.phone))) e.push('Teléfono inválido')
    if (clean(b.email) && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(clean(b.email))) e.push('Correo inválido')
    if (e.length) throw httpError(400, e.join('. '))
    return {
      document_type: b.documentType || 'CC', document: clean(b.document).replace(/\s+/g, ''), first_name: clean(b.firstName), last_name: clean(b.lastName),
      birth_date: dateOrNull(b.birthDate), sex: ['F', 'M', 'I'].includes(b.sex) ? b.sex : null, blood_type: clean(b.bloodType), phone: clean(b.phone), email: clean(b.email)?.toLowerCase() ?? null,
      address: clean(b.address), city: clean(b.city), profession: clean(b.profession), professional_card: clean(b.professionalCard), rethus: clean(b.rethus),
      eps: clean(b.eps), arl: clean(b.arl), pension_fund: clean(b.pensionFund), severance_fund: clean(b.severanceFund),
      emergency_contact: clean(b.emergencyContact), emergency_phone: clean(b.emergencyPhone), position_id: Number(b.positionId) || null,
      ips_service_id: Number(b.ipsServiceId) || null, user_id: Number(b.userId) || null, notes: clean(b.notes), active: b.active !== false, updated_at: new Date().toISOString()
    }
  }
  app.post('/estandares/th/personal', auth(STAFF), hx(async (req, res) => {
    const row = { ...staffRow(req.body || {}), site_id: await targetSite(req, req.body?.siteId) }
    if (req.body?.photo) row.photo_url = await uploadFile('foto', req.body.photo)
    const { data, error } = await supabase.from('th_staff').insert(row).select(STAFF_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una hoja de vida con ese documento', 409); throw error }
    res.status(201).send(await staffDetail(data))
  }))
  app.put('/estandares/th/personal/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadStaff(req)
    const row = staffRow(req.body || {})
    if (req.user.role === 'administrador' && Number(req.body?.siteId)) row.site_id = Number(req.body.siteId)
    if (req.body?.photo) { row.photo_url = await uploadFile('foto', req.body.photo); await removeFile(cur.photo_url) }
    const { data, error } = await supabase.from('th_staff').update(row).eq('id', cur.id).select(STAFF_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una hoja de vida con ese documento', 409); throw error }
    res.send(await staffDetail(data))
  }))
  app.delete('/estandares/th/personal/:id', auth(ADMIN), hx(async (req, res) => {
    const cur = await loadStaff(req)
    const { data: docs } = await supabase.from('th_documents').select('file_url').eq('staff_id', cur.id)
    const { error } = await supabase.from('th_staff').delete().eq('id', cur.id)
    if (error) throw error
    for (const d of docs || []) await removeFile(d.file_url)
    await removeFile(cur.photo_url)
    res.send({ message: 'Hoja de vida eliminada' })
  }))

  // ---------------------------------------------------------------- Soportes (certificados)
  const docRow = async (b) => {
    let rt = null
    if (Number(b.requirementTypeId)) {
      const { data } = await supabase.from('th_requirement_types').select('*').eq('id', Number(b.requirementTypeId)).maybeSingle()
      if (!data) throw httpError(400, 'Requisito inválido')
      rt = data
    }
    const name = clean(b.name) || rt?.name
    if (!name) throw httpError(400, 'Indica el nombre del soporte o curso')
    const category = rt?.category || b.category
    if (!CATEGORIES[category]) throw httpError(400, 'Categoría inválida')
    const expires = b.expires === undefined ? Boolean(rt?.expires) : Boolean(b.expires)
    const issue = dateOrNull(b.issueDate)
    let expiry = dateOrNull(b.expiryDate)
    // Si el requisito tiene vigencia en meses y no se indicó el vencimiento, se calcula desde la expedición.
    if (expires && !expiry && issue && rt?.validity_months) {
      const [y, m, d] = issue.split('-').map(Number)
      expiry = new Date(Date.UTC(y, m - 1 + rt.validity_months, d)).toISOString().slice(0, 10)
    }
    if (expires && !expiry) throw httpError(400, 'Indica la fecha de vencimiento del certificado')
    if (issue && expiry && expiry < issue) throw httpError(400, 'El vencimiento no puede ser anterior a la expedición')
    const hours = num(b.hours)
    if (hours != null && (Number.isNaN(hours) || hours < 0)) throw httpError(400, 'Intensidad horaria inválida')
    return { requirement_type_id: rt?.id ?? null, name, category, issuer: clean(b.issuer), issue_date: issue, expires, expiry_date: expires ? expiry : null, hours, notes: clean(b.notes) }
  }
  app.post('/estandares/th/personal/:id/documentos', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const row = await docRow(req.body || {})
    if (!req.body?.file) return fail(res, 'Carga el certificado en PDF', 400)
    row.file_url = await uploadFile(`doc-${s.id}`, req.body.file)
    const { error } = await supabase.from('th_documents').insert({ ...row, staff_id: s.id, created_by: req.user.id })
    if (error) { await removeFile(row.file_url); throw error }
    res.status(201).send(await staffDetail(s))
  }))
  app.put('/estandares/th/personal/:id/documentos/:docId', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const { data: cur } = await supabase.from('th_documents').select('id, file_url').eq('id', Number(req.params.docId)).eq('staff_id', s.id).maybeSingle()
    if (!cur) return fail(res, 'Soporte no encontrado', 404)
    const row = await docRow(req.body || {})
    if (req.body?.file) { row.file_url = await uploadFile(`doc-${s.id}`, req.body.file); row.verified_at = null; row.verified_by = null }
    const { error } = await supabase.from('th_documents').update(row).eq('id', cur.id)
    if (error) throw error
    if (row.file_url) await removeFile(cur.file_url)
    res.send(await staffDetail(s))
  }))
  app.delete('/estandares/th/personal/:id/documentos/:docId', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const { data: cur } = await supabase.from('th_documents').select('id, file_url').eq('id', Number(req.params.docId)).eq('staff_id', s.id).maybeSingle()
    if (!cur) return fail(res, 'Soporte no encontrado', 404)
    await supabase.from('th_documents').delete().eq('id', cur.id)
    await removeFile(cur.file_url)
    res.send(await staffDetail(s))
  }))
  // Marcar un soporte como verificado (revisado contra el original).
  app.post('/estandares/th/personal/:id/documentos/:docId/verificar', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const on = req.body?.verified !== false
    const { error } = await supabase.from('th_documents').update({ verified_at: on ? new Date().toISOString() : null, verified_by: on ? req.user.id : null }).eq('id', Number(req.params.docId)).eq('staff_id', s.id)
    if (error) throw error
    res.send(await staffDetail(s))
  }))

  // ---------------------------------------------------------------- Contratos
  const contractRow = (b) => {
    if (!CONTRACT_TYPES[b.contractType]) throw httpError(400, 'Tipo de contrato inválido')
    const start = dateOrNull(b.startDate); const end = dateOrNull(b.endDate)
    if (!start) throw httpError(400, 'La fecha de inicio es requerida')
    if (end && end < start) throw httpError(400, 'La fecha de terminación no puede ser anterior al inicio')
    if (b.contractType !== 'indefinido' && !end) throw httpError(400, 'Indica la fecha de terminación del contrato')
    const hrs = num(b.weeklyHours)
    return { contract_type: b.contractType, number: clean(b.number), start_date: start, end_date: end, weekly_hours: hrs, position_name: clean(b.positionName), notes: clean(b.notes) }
  }
  app.post('/estandares/th/personal/:id/contratos', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const row = contractRow(req.body || {})
    if (req.body?.file) row.file_url = await uploadFile(`contrato-${s.id}`, req.body.file)
    const { error } = await supabase.from('th_contracts').insert({ ...row, staff_id: s.id })
    if (error) throw error
    res.status(201).send(await staffDetail(s))
  }))
  app.put('/estandares/th/personal/:id/contratos/:cid', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const { data: cur } = await supabase.from('th_contracts').select('id, file_url').eq('id', Number(req.params.cid)).eq('staff_id', s.id).maybeSingle()
    if (!cur) return fail(res, 'Contrato no encontrado', 404)
    const row = contractRow(req.body || {})
    if (req.body?.file) row.file_url = await uploadFile(`contrato-${s.id}`, req.body.file)
    const { error } = await supabase.from('th_contracts').update(row).eq('id', cur.id)
    if (error) throw error
    if (row.file_url) await removeFile(cur.file_url)
    res.send(await staffDetail(s))
  }))
  app.delete('/estandares/th/personal/:id/contratos/:cid', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const { data: cur } = await supabase.from('th_contracts').select('id, file_url').eq('id', Number(req.params.cid)).eq('staff_id', s.id).maybeSingle()
    if (!cur) return fail(res, 'Contrato no encontrado', 404)
    await supabase.from('th_contracts').delete().eq('id', cur.id)
    await removeFile(cur.file_url)
    res.send(await staffDetail(s))
  }))

  // ---------------------------------------------------------------- Lista de chequeo
  // Se arma con los requisitos del cargo y el estado de sus soportes; quien verifica puede ajustar cada ítem.
  app.get('/estandares/th/personal/:id/chequeo/borrador', auth(STAFF), hx(async (req, res) => {
    const d = await staffDetail(await loadStaff(req))
    res.send({
      items: d.compliance.items.map((i) => ({ requirementTypeId: i.requirementTypeId, name: i.name, category: i.category, mandatory: i.mandatory, status: i.status, value: i.status === 'vigente' || i.status === 'por_vencer' ? 'cumple' : 'no_cumple', observation: i.status === 'vencido' ? 'Soporte vencido' : i.status === 'faltante' ? 'Sin soporte cargado' : '' })),
      contract: d.contract
    })
  }))
  app.post('/estandares/th/personal/:id/chequeo', auth(STAFF), hx(async (req, res) => {
    const s = await loadStaff(req)
    const items = (req.body?.items || []).map((i) => ({ requirementTypeId: Number(i.requirementTypeId) || null, name: clean(i.name), mandatory: i.mandatory !== false, value: ['cumple', 'no_cumple', 'no_aplica'].includes(i.value) ? i.value : 'no_cumple', observation: clean(i.observation) }))
    if (!items.length) return fail(res, 'El cargo no tiene requisitos configurados para verificar', 400)
    if (items.some((i) => !i.name)) return fail(res, 'Ítem inválido', 400)
    const applicable = items.filter((i) => i.value !== 'no_aplica')
    const compliant = applicable.filter((i) => i.value === 'cumple').length
    const mandatoryFail = items.some((i) => i.mandatory && i.value === 'no_cumple')
    const date = dateOrNull(req.body?.date) || todayBogota()
    const { data, error } = await supabase.from('th_checklists').insert({
      staff_id: s.id, check_date: date, reviewer_id: req.user.id, items, compliant, total: applicable.length,
      result: mandatoryFail ? 'no_cumple' : 'cumple', observations: clean(req.body?.observations)
    }).select('id').single()
    if (error) throw error
    res.status(201).send({ id: data.id })
  }))
  app.get('/estandares/th/chequeos/:cid', auth(STAFF), hx(async (req, res) => {
    const { data: c, error } = await supabase.from('th_checklists').select('*, reviewer:users!th_checklists_reviewer_id_fkey(name, last_name, identification), staff:th_staff(*, site:sites(name), position:th_positions(name))').eq('id', Number(req.params.cid)).maybeSingle()
    if (error) throw error
    if (!c || !canAccessSite(req, c.staff.site_id)) return fail(res, 'Lista de chequeo no encontrada', 404)
    res.send({ id: c.id, code: c.code, date: c.check_date, result: c.result, compliant: c.compliant, total: c.total, items: c.items, observations: c.observations,
      reviewer: c.reviewer ? `${c.reviewer.name} ${c.reviewer.last_name}` : null, reviewerId: c.reviewer_id, staff: staffBase(c.staff) })
  }))
  app.delete('/estandares/th/chequeos/:cid', auth(ADMIN), hx(async (req, res) => {
    const { error } = await supabase.from('th_checklists').delete().eq('id', Number(req.params.cid))
    if (error) throw error
    res.send({ message: 'Lista de chequeo eliminada' })
  }))

  // ---------------------------------------------------------------- Dashboard y alertas
  app.get('/estandares/th/resumen', auth(STAFF), hx(async (req, res) => {
    const rows = (await loadAll(scopeSite(req))).filter((r) => r.active)
    const year = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)
    const alerts = []
    for (const r of rows) {
      const c = r.contract
      if (!c) alerts.push({ level: 'warn', kind: 'contrato', staffId: r.id, name: r.fullName, message: 'Sin contrato registrado' })
      else if (c.status === 'vencido') alerts.push({ level: 'bad', kind: 'contrato', staffId: r.id, name: r.fullName, message: `Contrato vencido desde el ${c.endDate.split('-').reverse().join('/')}`, date: c.endDate })
      else if (c.status === 'por_vencer') alerts.push({ level: 'warn', kind: 'contrato', staffId: r.id, name: r.fullName, message: `Contrato vence en ${c.daysLeft} día${c.daysLeft === 1 ? '' : 's'}`, date: c.endDate })
      for (const d of r.expiredDocs) alerts.push({ level: 'bad', kind: 'certificado', staffId: r.id, name: r.fullName, message: `${d.name} vencido`, date: d.expiryDate })
      for (const d of r.expiringDocs) alerts.push({ level: 'warn', kind: 'certificado', staffId: r.id, name: r.fullName, message: `${d.name} vence en ${d.daysLeft} día${d.daysLeft === 1 ? '' : 's'}`, date: d.expiryDate })
      if (r.compliance.missing) alerts.push({ level: 'bad', kind: 'requisito', staffId: r.id, name: r.fullName, message: `${r.compliance.missing} requisito${r.compliance.missing === 1 ? '' : 's'} obligatorio${r.compliance.missing === 1 ? '' : 's'} sin soporte` })
      if (!r.positionId) alerts.push({ level: 'warn', kind: 'cargo', staffId: r.id, name: r.fullName, message: 'Sin cargo asignado: no se pueden verificar requisitos' })
      if (!r.lastChecklist || r.lastChecklist.date < year) alerts.push({ level: 'warn', kind: 'chequeo', staffId: r.id, name: r.fullName, message: r.lastChecklist ? 'Lista de chequeo con más de un año' : 'Sin lista de chequeo' })
    }
    const by = (fn) => Object.values(rows.reduce((a, r) => { const k = fn(r) || 'Sin dato'; a[k] = a[k] || { name: k, value: 0 }; a[k].value += 1; return a }, {})).sort((a, b) => b.value - a.value)
    res.send({
      kpis: {
        total: rows.length,
        compliant: rows.filter((r) => r.compliance.percent === 100 && !r.compliance.expired).length,
        avgCompliance: rows.length ? Math.round(rows.reduce((a, r) => a + r.compliance.percent, 0) / rows.length) : 0,
        contractsExpiring: rows.filter((r) => r.contract?.status === 'por_vencer').length,
        contractsExpired: rows.filter((r) => r.contract?.status === 'vencido').length,
        withoutContract: rows.filter((r) => !r.contract).length,
        docsExpiring: rows.reduce((a, r) => a + r.expiringDocs.length, 0),
        docsExpired: rows.reduce((a, r) => a + r.expiredDocs.length, 0),
        missing: rows.reduce((a, r) => a + r.compliance.missing, 0),
        withoutChecklist: rows.filter((r) => !r.lastChecklist || r.lastChecklist.date < year).length
      },
      byPosition: by((r) => r.positionName),
      bySite: by((r) => r.siteName),
      byContract: by((r) => r.contract?.contractTypeLabel || 'Sin contrato'),
      compliance: [
        { name: '100 %', value: rows.filter((r) => r.compliance.percent === 100).length },
        { name: '70–99 %', value: rows.filter((r) => r.compliance.percent >= 70 && r.compliance.percent < 100).length },
        { name: 'Menos de 70 %', value: rows.filter((r) => r.compliance.percent < 70).length }
      ],
      alerts: alerts.sort((a, b) => (a.level === b.level ? String(a.date || '9').localeCompare(String(b.date || '9')) : a.level === 'bad' ? -1 : 1)),
      staff: rows.map((r) => ({ id: r.id, fullName: r.fullName, positionName: r.positionName, siteName: r.siteName, percent: r.compliance.percent, missing: r.compliance.missing, contract: r.contract?.status || 'sin_contrato' }))
    })
  }))
}
