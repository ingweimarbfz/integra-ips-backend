// =====================================================================
// Historial por persona (IIPS-027)
// Una persona (paciente) puede tener varios servicios: citologías, vacunas, traslados asistenciales y
// cobros. Se agrupan por su número de documento, sin duplicar datos: cada servicio sigue en su tabla.
// Solo se muestran las secciones de los módulos que el usuario tiene habilitados y de su sede.
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, STAFF, scopeSite, userModules } = deps
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const norm = (d) => String(d || '').replace(/[^\dA-Za-z]/g, '').toUpperCase()
  const has = (req, m) => userModules(req.user).includes(m)
  const scoped = (q, req) => { const s = scopeSite(req); return s ? q.eq('site_id', s) : q }

  // Búsqueda por documento o nombre en todos los servicios.
  app.get('/pacientes/buscar', auth(STAFF), hx(async (req, res) => {
    const q = clean(req.query.q)?.replace(/[%_,()]/g, '')
    if (!q || q.length < 3) return res.send([])
    const isDoc = /^\d[\d.\s-]*$/.test(q)
    const out = new Map()
    const add = (doc, docType, name, source, date) => {
      const k = norm(doc); if (!k) return
      const cur = out.get(k) || { document: k, documentType: docType || null, fullName: name, services: {}, lastDate: null }
      cur.services[source] = (cur.services[source] || 0) + 1
      if (!cur.lastDate || String(date) > cur.lastDate) { cur.lastDate = String(date || '').slice(0, 10); cur.fullName = name || cur.fullName }
      out.set(k, cur)
    }
    const jobs = []
    if (has(req, 'citologias')) {
      let c = scoped(supabase.from('cytology_samples').select('num_documento, tipo_documento, nombre, apellidos, fecha_examen'), req).limit(60)
      c = isDoc ? c.ilike('num_documento', `%${norm(q)}%`) : c.or(`nombre.ilike.%${q}%,apellidos.ilike.%${q}%`)
      jobs.push(c.then(({ data }) => (data || []).forEach((r) => add(r.num_documento, r.tipo_documento, `${r.nombre || ''} ${r.apellidos || ''}`.trim(), 'citologias', r.fecha_examen))))
    }
    if (has(req, 'vacunacion')) {
      let v = scoped(supabase.from('vaccination_records').select('patient_doc_number, patient_doc_type, names, surnames, applied_on'), req).limit(60)
      v = isDoc ? v.ilike('patient_doc_number', `%${norm(q)}%`) : v.or(`names.ilike.%${q}%,surnames.ilike.%${q}%`)
      jobs.push(v.then(({ data }) => (data || []).forEach((r) => add(r.patient_doc_number, r.patient_doc_type, `${r.names || ''} ${r.surnames || ''}`.trim(), 'vacunacion', r.applied_on))))
    }
    if (has(req, 'traslado') || has(req, 'flota')) {
      let t = supabase.from('vehicle_transfers').select('document, document_type, patient_name, created_at').limit(60)
      t = isDoc ? t.ilike('document', `%${norm(q)}%`) : t.ilike('patient_name', `%${q}%`)
      jobs.push(t.then(({ data }) => (data || []).forEach((r) => add(r.document, r.document_type, r.patient_name, 'traslados', r.created_at))))
    }
    await Promise.all(jobs)
    res.send([...out.values()].sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate))).slice(0, 30))
  }))

  // Ficha de la persona: datos más recientes y todos sus servicios.
  app.get('/pacientes/:doc', auth(STAFF), hx(async (req, res) => {
    const doc = norm(req.params.doc)
    if (doc.length < 4) return fail(res, 'Documento inválido', 400)
    const [cyto, vacc, trans, charges] = await Promise.all([
      has(req, 'citologias') ? scoped(supabase.from('cytology_samples').select('id, fecha_examen, num_lamina, num_factura, nombre, apellidos, tipo_documento, num_documento, fecha_nacimiento, celular, email, direccion, municipio, eps, regimen, ocupacion, estado_civil, edad, valor, billing_status, site:sites(name)'), req).eq('num_documento', doc).order('fecha_examen', { ascending: false }) : { data: [] },
      has(req, 'vacunacion') ? scoped(supabase.from('vaccination_records').select('id, applied_on, dose_label, lot, modality, vaccinator, names, surnames, patient_doc_type, patient_doc_number, birth_date, sex, phone, email, address, municipality, regimen, next_dose_date, next_dose_label, vaccine:vaccines(name, code), site:sites(name)'), req).eq('patient_doc_number', doc).order('applied_on', { ascending: false }) : { data: [] },
      has(req, 'traslado') || has(req, 'flota') ? ((q) => { const st = scopeSite(req); return st ? q.eq('trip.site_id', st) : q })(supabase.from('vehicle_transfers').select('id, patient_name, document_type, document, sex, age_years, phone, eps, regime, transfer_type, priority, origin, destination, diagnosis, created_at, trip:vehicle_trips!inner(id, code, status, started_at, site_id, vehicles(movil))').eq('document', doc)).order('created_at', { ascending: false }) : { data: [] },
      has(req, 'facturacion') ? scoped(supabase.from('service_charges').select('id, service_name, service_date, description, invoice_number, valor, billing_status, payment_mode'), req).or(`patient_doc_number.eq.${doc},patient_doc.ilike.%${doc}`).order('service_date', { ascending: false }).limit(100) : { data: [] }
    ])
    for (const r of [cyto, vacc, trans, charges]) if (r.error) throw r.error
    // Datos personales: los del registro más reciente de cualquier servicio.
    const candidates = [
      ...cyto.data.map((c) => ({ date: c.fecha_examen, p: { documentType: c.tipo_documento, document: doc, names: c.nombre, surnames: c.apellidos, birthDate: c.fecha_nacimiento, phone: c.celular, email: c.email, address: c.direccion, municipality: c.municipio, eps: c.eps, regimen: c.regimen, occupation: c.ocupacion, sex: 'F' } })),
      ...vacc.data.map((v) => ({ date: v.applied_on, p: { documentType: v.patient_doc_type, document: doc, names: v.names, surnames: v.surnames, birthDate: v.birth_date, sex: v.sex, phone: v.phone, email: v.email, address: v.address, municipality: v.municipality, regimen: v.regimen } })),
      ...trans.data.map((t) => ({ date: t.created_at, p: { documentType: t.document_type, document: doc, names: t.patient_name, surnames: '', sex: t.sex, phone: t.phone, eps: t.eps, regimen: t.regime } }))
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)))
    // Completa los campos vacíos del más reciente con los de registros anteriores.
    const person = candidates.reduce((acc, c) => { for (const [k, v] of Object.entries(c.p)) if ((acc[k] == null || acc[k] === '') && v != null && v !== '') acc[k] = v; return acc }, {})
    const nextDose = vacc.data.filter((v) => v.next_dose_date).sort((a, b) => a.next_dose_date.localeCompare(b.next_dose_date)).find((v) => !vacc.data.some((x) => x.vaccine?.code === v.vaccine?.code && x.applied_on > v.applied_on))
    res.send({
      person: candidates.length ? { ...person, fullName: `${person.names || ''} ${person.surnames || ''}`.trim() } : null,
      modules: { citologias: has(req, 'citologias'), vacunacion: has(req, 'vacunacion'), traslados: has(req, 'traslado') || has(req, 'flota'), facturacion: has(req, 'facturacion') },
      cytologies: cyto.data.map((c) => ({ id: c.id, date: c.fecha_examen, lamina: c.num_lamina, invoice: c.num_factura, eps: c.eps, age: c.edad, value: c.valor == null ? null : Number(c.valor), billingStatus: c.billing_status, siteName: c.site?.name ?? null })),
      vaccinations: vacc.data.map((v) => ({ id: v.id, date: v.applied_on, vaccine: v.vaccine?.name, code: v.vaccine?.code, dose: v.dose_label, lot: v.lot, modality: v.modality, vaccinator: v.vaccinator, nextDoseDate: v.next_dose_date, nextDoseLabel: v.next_dose_label, siteName: v.site?.name ?? null })),
      transfers: trans.data.map((t) => ({ id: t.id, date: t.created_at, type: t.transfer_type, priority: t.priority, origin: t.origin, destination: t.destination, diagnosis: t.diagnosis, trip: t.trip ? { id: t.trip.id, code: t.trip.code, status: t.trip.status, movil: t.trip.vehicles?.movil } : null })),
      charges: charges.data.map((c) => ({ id: c.id, service: c.service_name, date: c.service_date, description: c.description, invoice: c.invoice_number, value: Number(c.valor), billingStatus: c.billing_status, paymentMode: c.payment_mode })),
      nextDose: nextDose ? { date: nextDose.next_dose_date, label: nextDose.next_dose_label, vaccine: nextDose.vaccine?.name } : null,
      totals: { cytologies: cyto.data.length, vaccinations: vacc.data.length, transfers: trans.data.length, charges: charges.data.length }
    })
  }))
}
