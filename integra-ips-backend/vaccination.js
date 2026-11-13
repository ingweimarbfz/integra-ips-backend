// =====================================================================
// Servicio de vacunación (PAI y vacunas particulares)
// · Catálogo de biológicos: esquema de dosis, intervalos, presentación (unidosis / multidosis),
//   vida útil del frasco abierto, producto de inventario, jeringa y tarifa (vacunas que se cobran).
// · Registro nominal: paciente, biológico, dosis, lote, vacunador y modalidad. Descuenta el inventario
//   (frascos y jeringas), controla los frascos multidosis abiertos y calcula la próxima dosis.
// · Vacunas que se cobran: se factura primero (Facturación → Servicios facturables) y el registro toma la factura.
// · Carné, seguimiento de dosis (próximas y atrasadas), ESAVI, exportación para PAIWEB y dashboard.
// =====================================================================
const { pageQuery, setTotal } = require('./paging')
const V = require('./validate')
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite, targetSite, requireIps, billing, inPlan, getEmployees } = deps
  const STAFF = ['administrador', 'empleado']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const today = () => todayBogota()
  const gate = [auth(STAFF), requireIps('cadena_frio')]
  const SEX = ['F', 'M', 'I']
  const MODALITIES = { intramural: 'Intramural', extramural: 'Extramural (jornada / brigada)', domiciliaria: 'Domiciliaria' }
  const GROUPS = ['Población general', 'Gestante', 'Niño o niña menor de 6 años', 'Adolescente', 'Adulto mayor', 'Personal de salud', 'Viajero', 'Población migrante', 'Persona con discapacidad', 'Víctima del conflicto']
  const addDays = (iso, d) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }
  const ageYears = (birth, ref) => { const [by, bm, bd] = birth.split('-').map(Number); const [ry, rm, rd] = ref.split('-').map(Number); return ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0) }

  // ---------------------------------------------------------------- Catálogo de biológicos
  const vaccineDTO = (v) => ({
    id: v.id, name: v.name, code: v.code, pai: v.pai, doseLabels: v.dose_labels || [], intervalDays: v.interval_days || [], route: v.route, applicationSite: v.application_site,
    target: v.target, presentation: v.presentation, dosesPerVial: v.doses_per_vial, openVialHours: v.open_vial_hours, productId: v.product_id, productName: v.product?.name ?? null,
    syringeProductId: v.syringe_product_id, tariffId: v.tariff_id, tariffName: v.tariff?.name ?? null, tariffPrice: v.tariff ? Number(v.tariff.price) : null, active: v.active
  })
  const V_SELECT = '*, product:inventory_products!vaccines_product_id_fkey(name), tariff:service_tariffs(name, price)'
  app.get('/vacunacion/biologicos', ...gate, hx(async (req, res) => {
    const { data, error } = await supabase.from('vaccines').select(V_SELECT).order('pai', { ascending: false }).order('name')
    if (error) throw error
    res.send(data.map(vaccineDTO))
  }))
  app.get('/vacunacion/opciones', auth(ADMIN), hx(async (req, res) => {
    const [p, t] = await Promise.all([
      supabase.from('inventory_products').select('id, code, name, category, unit').eq('active', true).in('category', ['medicamento', 'dispositivo_medico']).order('name'),
      supabase.from('service_tariffs').select('id, name, price, service:ips_services!inner(module)').eq('active', true).eq('service.module', 'cadena_frio').order('name')
    ])
    if (p.error) throw p.error
    res.send({ products: p.data, tariffs: (t.data || []).map((x) => ({ id: x.id, name: x.name, price: Number(x.price) })), groups: GROUPS, modalities: MODALITIES })
  }))
  const vaccineRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('Escribe el nombre del biológico')
    const labels = (Array.isArray(b.doseLabels) ? b.doseLabels : []).map(clean).filter(Boolean)
    if (!labels.length) e.push('Define al menos una dosis del esquema')
    const intervals = (Array.isArray(b.intervalDays) ? b.intervalDays : []).map(Number).filter((n) => n >= 0)
    if (!['unidosis', 'multidosis'].includes(b.presentation || 'unidosis')) e.push('Presentación inválida')
    if (!b.pai && !Number(b.tariffId)) e.push('Una vacuna que se cobra necesita su ítem del tarifario')
    if (e.length) throw httpError(400, e.join('. '))
    const multi = b.presentation === 'multidosis'
    return {
      name: clean(b.name), code: clean(b.code), pai: Boolean(b.pai), dose_labels: labels, interval_days: intervals.slice(0, Math.max(0, labels.length - 1)),
      route: clean(b.route), application_site: clean(b.applicationSite), target: clean(b.target), presentation: multi ? 'multidosis' : 'unidosis',
      doses_per_vial: multi ? Math.max(2, Number(b.dosesPerVial) || 10) : 1, open_vial_hours: multi ? Math.max(1, Number(b.openVialHours) || 6) : 0,
      product_id: Number(b.productId) || null, syringe_product_id: Number(b.syringeProductId) || null, tariff_id: Number(b.tariffId) || null,
      active: b.active !== false, updated_at: new Date().toISOString()
    }
  }
  app.post('/vacunacion/biologicos', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('vaccines').insert(vaccineRow(req.body || {})).select(V_SELECT).single()
    if (error) { if (error.code === '23505') throw httpError(409, 'Ya existe un biológico con ese nombre'); throw error }
    res.status(201).send(vaccineDTO(data))
  }))
  app.put('/vacunacion/biologicos/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('vaccines').update(vaccineRow(req.body || {})).eq('id', Number(req.params.id)).select(V_SELECT).maybeSingle()
    if (error) { if (error.code === '23505') throw httpError(409, 'Ya existe un biológico con ese nombre'); throw error }
    if (!data) throw httpError(404, 'Biológico no encontrado')
    res.send(vaccineDTO(data))
  }))

  // ---------------------------------------------------------------- Formulario: lotes disponibles y frascos abiertos
  const lotsFor = async (site) => {
    let q = supabase.from('inventory_items').select('id, product_id, lot, expiry_date, stock, site_id, warehouse:warehouses(name)').gt('stock', 0).eq('active', true)
    if (site) q = q.eq('site_id', site)
    const { data, error } = await q.order('expiry_date')
    if (error) throw error
    return data.filter((i) => !i.expiry_date || i.expiry_date >= today())
  }
  const openVials = async (site) => {
    let q = supabase.from('vaccine_open_vials').select('id, vaccine_id, item_id, site_id, opened_at, expires_at, doses_total, doses_used, item:inventory_items(lot)').is('closed_at', null)
    if (site) q = q.eq('site_id', site)
    const { data, error } = await q
    if (error) throw error
    const now = new Date().toISOString()
    return data.map((v) => ({ id: v.id, vaccineId: v.vaccine_id, itemId: v.item_id, siteId: v.site_id, lot: v.item?.lot, openedAt: v.opened_at, expiresAt: v.expires_at, dosesTotal: v.doses_total, dosesUsed: v.doses_used, remaining: v.doses_total - v.doses_used, expired: v.expires_at < now }))
  }
  app.get('/vacunacion/datos-formulario', ...gate, hx(async (req, res) => {
    const site = await targetSite(req, req.query.siteId)
    const [vaccines, lots, vials, employees] = await Promise.all([
      supabase.from('vaccines').select(V_SELECT).eq('active', true).order('pai', { ascending: false }).order('name'),
      lotsFor(site), openVials(site), getEmployees(site)
    ])
    if (vaccines.error) throw vaccines.error
    const { data: sigs } = await supabase.from('users').select('id, signature_url').in('id', employees.map((x) => x.id).concat(0))
    const vaccinatorList = employees.map((x) => ({ ...x, hasSignature: Boolean((sigs || []).find((u) => u.id === x.id)?.signature_url) }))
    res.send({
      today: today(), siteId: site, groups: GROUPS, modalities: MODALITIES, vaccinators: vaccinatorList,
      billingOn: inPlan('facturacion'),
      vaccines: vaccines.data.map((v) => ({
        ...vaccineDTO(v),
        lots: lots.filter((l) => l.product_id === v.product_id).map((l) => ({ itemId: l.id, lot: l.lot, expiry: l.expiry_date, stock: Number(l.stock), warehouse: l.warehouse?.name })),
        openVials: vials.filter((x) => lots.some((l) => l.id === x.itemId && l.product_id === v.product_id) && !x.expired && x.remaining > 0)
      }))
    })
  }))

  // ---------------------------------------------------------------- Paciente: historial y próxima dosis sugerida
  const RECORD_SELECT = '*, vaccine:vaccines(id, name, code, pai, dose_labels), eps:eps_insurers(name), site:sites(name), vaccinator_user:users!vaccination_records_vaccinator_id_fkey(signature_url), esavi:esavi_reports(id, severity, notified_sivigila), charge:service_charges(invoice_number)'
  const recordDTO = (r) => ({
    id: r.id, siteId: r.site_id, siteName: r.site?.name ?? null, appliedOn: r.applied_on, docType: r.patient_doc_type, docNumber: r.patient_doc_number,
    names: r.names, surnames: r.surnames, patient: `${r.names} ${r.surnames || ''}`.trim(), birthDate: r.birth_date, sex: r.sex, phone: r.phone, email: r.email, address: r.address,
    municipality: r.municipality, epsId: r.eps_id, epsName: r.eps?.name ?? null, regimen: r.regimen, populationGroup: r.population_group, ethnicity: r.ethnicity,
    vaccineId: r.vaccine_id, vaccine: r.vaccine?.name ?? null, vaccineCode: r.vaccine?.code ?? null, pai: r.vaccine?.pai ?? true, dose: r.dose_label, doseIndex: r.dose_index,
    lot: r.lot, expiry: r.expiry_date, modality: r.modality, vaccinator: r.vaccinator, vaccinatorSignature: r.vaccinator_user?.signature_url ?? null, invoice: r.charge?.invoice_number ?? null, nextDoseDate: r.next_dose_date, nextDoseLabel: r.next_dose_label,
    notes: r.notes, esavi: (r.esavi || []).map((e) => ({ id: e.id, severity: e.severity, notified: e.notified_sivigila })), createdAt: r.created_at,
    age: r.birth_date ? ageYears(r.birth_date, r.applied_on) : null
  })
  const history = async (doc) => {
    const { data, error } = await supabase.from('vaccination_records').select(RECORD_SELECT).eq('patient_doc_number', doc).order('applied_on').order('id')
    if (error) throw error
    return data.map(recordDTO)
  }
  app.get('/vacunacion/paciente', ...gate, hx(async (req, res) => {
    const doc = String(req.query.documento || '').replace(/[^\dA-Za-z]/g, '')
    if (doc.length < 4) return res.send({ patient: null, records: [] })
    const records = await history(doc)
    const last = records[records.length - 1]
    res.send({
      patient: last ? { docType: last.docType, docNumber: last.docNumber, names: last.names, surnames: last.surnames, birthDate: last.birthDate, sex: last.sex, phone: last.phone, email: last.email, address: last.address, municipality: last.municipality, epsId: last.epsId, regimen: last.regimen, populationGroup: last.populationGroup, ethnicity: last.ethnicity } : null,
      records
    })
  }))
  // Siguiente dosis de un biológico para un paciente (según las dosis que ya tiene).
  const nextDoseFor = (v, records) => {
    const mine = records.filter((r) => r.vaccineId === v.id)
    const labels = v.dose_labels || []
    if (labels.length === 1) return { index: 1, label: labels[0] }
    const idx = Math.min(mine.length, labels.length - 1)
    return { index: idx + 1, label: labels[idx], complete: mine.length >= labels.length }
  }

  // ---------------------------------------------------------------- Registrar vacunación
  app.post('/vacunacion/registrar', ...gate, hx(async (req, res) => {
    const b = req.body || {}
    const e = []
    const doc = String(b.docNumber || '').replace(/[^\dA-Za-z]/g, '')
    if (!doc) e.push('Escribe el número de documento')
    if (!clean(b.names)) e.push('Escribe los nombres del paciente')
    if (!ISO_DATE.test(b.birthDate || '') || b.birthDate > today()) e.push('Fecha de nacimiento inválida')
    if (b.sex && !SEX.includes(b.sex)) e.push('Sexo inválido')
    if (b.modality && !MODALITIES[b.modality]) e.push('Modalidad inválida')
    for (const m of [V.phoneError(b.phone, 'El celular'), V.emailError(b.email), V.docError(doc, b.docType)]) if (m) e.push(m)
    const { data: v } = await supabase.from('vaccines').select('*').eq('id', Number(b.vaccineId)).maybeSingle()
    if (!v || !v.active) e.push('Elige el biológico')
    if (e.length) return fail(res, e.join('. '), 400)
    const site = await targetSite(req, b.siteId)
    const records = await history(doc)
    const dose = (v.dose_labels || []).includes(b.doseLabel) ? b.doseLabel : nextDoseFor(v, records).label
    const doseIndex = (v.dose_labels || []).indexOf(dose) + 1
    if (records.some((r) => r.vaccineId === v.id && r.dose === dose && dose !== 'Anual')) return fail(res, `El paciente ya tiene registrada la dosis "${dose}" de ${v.name}`, 409)
    if (dose === 'Anual' && records.some((r) => r.vaccineId === v.id && r.appliedOn.slice(0, 4) === today().slice(0, 4))) return fail(res, `El paciente ya recibió ${v.name} este año`, 409)
    // Vacunador: empleado de la sede.
    const vaccinators = await getEmployees(site)
    const vaccinator = vaccinators.find((x) => String(x.id) === String(b.vaccinatorId))
    if (!vaccinator) return fail(res, 'Elige el vacunador (empleado de la sede)', 400)
    // El carnet va firmado por el vacunador: debe tener su firma digital registrada (Mi firma digital).
    const { data: vu } = await supabase.from('users').select('signature_url').eq('id', vaccinator.id).maybeSingle()
    if (!vu?.signature_url) return fail(res, `${vaccinator.fullName} no tiene firma digital registrada: debe crearla en "Mi firma digital" antes de vacunar`, 400)
    // Vacunas que se cobran: la factura se genera antes en Facturación → Servicios facturables.
    let invoice = null
    if (!v.pai && inPlan('facturacion')) {
      if (!Number(b.invoiceId)) return fail(res, `${v.name} se cobra: factúrala primero en Facturación → Servicios facturables y elige aquí la factura`, 400)
      invoice = await billing.takeInvoice(req, { module: 'cadena_frio', chargeId: b.invoiceId, docNumber: doc, siteId: site })
    }
    // Inventario: lote del biológico en la sede.
    let item = null; let vialId = null
    if (v.product_id) {
      const { data: it } = await supabase.from('inventory_items').select('id, product_id, site_id, lot, expiry_date, stock').eq('id', Number(b.itemId)).maybeSingle()
      if (!it || it.product_id !== v.product_id || Number(it.site_id) !== Number(site)) return fail(res, 'Elige el lote del biológico disponible en la sede', 400)
      if (it.expiry_date && it.expiry_date < today()) return fail(res, `El lote ${it.lot} está vencido`, 400)
      item = it
      if (v.presentation === 'multidosis') {
        // Usa un frasco abierto vigente del mismo lote; si no hay, abre uno nuevo (descuenta un frasco del inventario).
        const now = new Date().toISOString()
        // El frasco abierto se comparte entre biológicos del mismo producto y lote (por ejemplo, PAI y particular).
        const { data: open } = await supabase.from('vaccine_open_vials').select('*').eq('item_id', it.id).is('closed_at', null).gt('expires_at', now).order('opened_at').limit(1)
        let vial = (open || []).find((x) => x.doses_used < x.doses_total)
        if (!vial) {
          if (Number(it.stock) < 1) return fail(res, `No hay frascos del lote ${it.lot} en inventario`, 400)
          const { error: mv } = await supabase.rpc('inv_move', { p_item: it.id, p_delta: -1, p_type: 'consumo', p_user: req.user.id, p_note: `Vacunación: frasco multidosis abierto de ${v.name}`, p_destination: null, p_event: null })
          if (mv) return fail(res, mv.message.includes('STOCK') ? `No hay frascos del lote ${it.lot} en inventario` : mv.message, 400)
          const expires = new Date(Date.now() + v.open_vial_hours * 3600000).toISOString()
          const { data: nv, error: ne } = await supabase.from('vaccine_open_vials').insert({ vaccine_id: v.id, item_id: it.id, site_id: site, expires_at: expires, doses_total: v.doses_per_vial, opened_by: req.user.id }).select('*').single()
          if (ne) throw ne
          vial = nv
        }
        await supabase.from('vaccine_open_vials').update({ doses_used: vial.doses_used + 1, ...(vial.doses_used + 1 >= vial.doses_total ? { closed_at: new Date().toISOString(), close_reason: 'Frasco terminado' } : {}) }).eq('id', vial.id)
        vialId = vial.id
      } else {
        const { error: mv } = await supabase.rpc('inv_move', { p_item: it.id, p_delta: -1, p_type: 'consumo', p_user: req.user.id, p_note: `Vacunación: ${v.name} · ${clean(b.names)}`, p_destination: null, p_event: null })
        if (mv) return fail(res, mv.message.includes('STOCK') ? `No hay existencias del lote ${it.lot}` : mv.message, 400)
      }
    }
    // Jeringa (si el biológico la usa): se descuenta del primer lote disponible en la sede.
    let syringeNote = null
    if (v.syringe_product_id) {
      // Prefiere la bodega de vacunación de la sede.
      const { data: syrs } = await supabase.from('inventory_items').select('id, stock, warehouse:warehouses(name)').eq('product_id', v.syringe_product_id).eq('site_id', site).gt('stock', 0).order('expiry_date')
      const syr = (syrs || []).sort((a, b2) => Number(/vacunaci/i.test(b2.warehouse?.name || '')) - Number(/vacunaci/i.test(a.warehouse?.name || '')))
      if (syr?.[0]) await supabase.rpc('inv_move', { p_item: syr[0].id, p_delta: -1, p_type: 'consumo', p_user: req.user.id, p_note: `Vacunación: jeringa para ${v.name}`, p_destination: null, p_event: null })
      else syringeNote = 'No había jeringas en el inventario de la sede: revisa el inventario.'
    }
    const interval = (v.interval_days || [])[doseIndex - 1]
    const nextLabel = (v.dose_labels || [])[doseIndex]
    const applied = today()
    const row = {
      site_id: site, applied_on: applied, patient_doc_type: clean(b.docType), patient_doc_number: doc, names: clean(b.names), surnames: clean(b.surnames), birth_date: b.birthDate,
      sex: b.sex || null, phone: V.phone(b.phone), email: clean(b.email)?.toLowerCase() ?? null, address: clean(b.address), municipality: clean(b.municipality),
      eps_id: Number(b.epsId) || null, regimen: clean(b.regimen), population_group: GROUPS.includes(b.populationGroup) ? b.populationGroup : 'Población general', ethnicity: clean(b.ethnicity),
      vaccine_id: v.id, dose_label: dose, dose_index: doseIndex, lot: item?.lot ?? clean(b.lot), expiry_date: item?.expiry_date ?? null, item_id: item?.id ?? null, vial_id: vialId,
      modality: b.modality || 'intramural', vaccinator_id: vaccinator.id, vaccinator: vaccinator.fullName, charge_id: invoice?.id ?? null,
      next_dose_date: nextLabel && interval ? addDays(applied, interval) : (dose === 'Anual' ? addDays(applied, 365) : null),
      next_dose_label: nextLabel && interval ? nextLabel : (dose === 'Anual' ? 'Anual' : null), notes: clean(b.notes), created_by: req.user.id
    }
    const { data, error } = await supabase.from('vaccination_records').insert(row).select(RECORD_SELECT).single()
    if (error) throw error
    if (invoice) await billing.linkInvoice(invoice.id, 'vaccination_records', data.id, `${v.code || v.name} · ${dose}`, { doc, name: `${row.names} ${row.surnames || ''}`.trim() })
    // Vacuna PAI con EPS en convenio por cuenta de cobro: se factura sola la aplicación a la EPS (promoción y prevención, sin copago).
    let billed = null
    if (v.pai && v.tariff_id && row.eps_id && inPlan('facturacion')) {
      const { data: e2 } = await supabase.from('eps_insurers').select('id, name, has_agreement, agreement_valid_until, payment_mode, active').eq('id', row.eps_id).maybeSingle()
      const agreement = e2 && e2.active && e2.has_agreement && (!e2.agreement_valid_until || e2.agreement_valid_until >= today()) && e2.payment_mode === 'cuenta_cobro'
      if (agreement) {
        try {
          const { data: svc } = await supabase.from('ips_services').select('id').eq('module', 'cadena_frio').maybeSingle()
          const chargeId = await billing.createInvoice(req, {
            serviceId: svc.id, date: applied, docType: row.patient_doc_type, docNumber: doc, names: row.names, surnames: row.surnames, epsId: row.eps_id,
            paymentMode: 'cuenta_cobro', regimen: ['contributivo', 'subsidiado'].includes(row.regimen) ? row.regimen : null, payerType: 'paciente',
            items: [{ tariffId: v.tariff_id, quantity: 1 }], siteId: site, description: `${v.name} · ${dose}`
          })
          await billing.linkInvoice(chargeId, 'vaccination_records', data.id, `${v.code || v.name} · ${dose}`, { doc, name: `${row.names} ${row.surnames || ''}`.trim() })
          await supabase.from('vaccination_records').update({ charge_id: chargeId }).eq('id', data.id)
          const { data: ch } = await supabase.from('service_charges').select('invoice_number, valor').eq('id', chargeId).single()
          billed = { invoice: ch.invoice_number, valor: Number(ch.valor), eps: e2.name }
        } catch (err) { syringeNote = [syringeNote, `No se pudo facturar la aplicación a la EPS: ${err.message}`].filter(Boolean).join(' ') }
      }
    }
    res.status(201).send({ ...recordDTO(data), invoice: billed?.invoice ?? recordDTO(data).invoice, billed, warning: syringeNote })
  }))

  // ---------------------------------------------------------------- Consulta, carné y exportación
  app.get('/vacunacion/registros', ...gate, hx(async (req, res) => {
    let q = supabase.from('vaccination_records').select(RECORD_SELECT, { count: 'exact' }).order('applied_on', { ascending: false }).order('id', { ascending: false })
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    const doc = String(req.query.documento || '').replace(/[^\dA-Za-z]/g, '')
    if (doc) q = q.eq('patient_doc_number', doc)
    else {
      if (ISO_DATE.test(req.query.desde || '')) q = q.gte('applied_on', req.query.desde)
      if (ISO_DATE.test(req.query.hasta || '')) q = q.lte('applied_on', req.query.hasta)
    }
    if (Number(req.query.biologico)) q = q.eq('vaccine_id', Number(req.query.biologico))
    const { data, error, count } = await pageQuery(req, q, 500)
    if (error) throw error
    setTotal(res, count)
    res.send(data.map(recordDTO))
  }))
  app.get('/vacunacion/carne/:documento', ...gate, hx(async (req, res) => {
    const doc = String(req.params.documento || '').replace(/[^\dA-Za-z]/g, '')
    const records = await history(doc)
    if (!records.length) throw httpError(404, 'No hay vacunas registradas para ese documento')
    res.send({ patient: records[records.length - 1], records })
  }))
  // Archivo plano (CSV) con los campos del registro nominal para cargar o conciliar en PAIWEB.
  app.get('/vacunacion/exportar', ...gate, hx(async (req, res) => {
    const desde = ISO_DATE.test(req.query.desde || '') ? req.query.desde : `${today().slice(0, 8)}01`
    const hasta = ISO_DATE.test(req.query.hasta || '') ? req.query.hasta : today()
    let q = supabase.from('vaccination_records').select(RECORD_SELECT).gte('applied_on', desde).lte('applied_on', hasta).order('applied_on')
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    const { data, error } = await q
    if (error) throw error
    const cols = ['fecha_aplicacion', 'tipo_documento', 'numero_documento', 'nombres', 'apellidos', 'fecha_nacimiento', 'edad', 'sexo', 'regimen', 'eps', 'grupo_poblacional', 'pertenencia_etnica', 'municipio', 'direccion', 'telefono', 'biologico', 'codigo', 'pai', 'dosis', 'lote', 'vence', 'modalidad', 'vacunador', 'sede', 'factura', 'proxima_dosis']
    const esc = (x) => { const s = x == null ? '' : String(x); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = data.map(recordDTO).map((r) => [r.appliedOn, r.docType, r.docNumber, r.names, r.surnames, r.birthDate, r.age, r.sex, r.regimen, r.epsName, r.populationGroup, r.ethnicity, r.municipality, r.address, r.phone, r.vaccine, r.vaccineCode, r.pai ? 'SI' : 'NO', r.dose, r.lot, r.expiry, MODALITIES[r.modality], r.vaccinator, r.siteName, r.invoice, r.nextDoseDate].map(esc).join(';'))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="vacunacion_${desde}_${hasta}.csv"`)
    res.send('﻿' + [cols.join(';'), ...lines].join('\n'))
  }))

  // ---------------------------------------------------------------- Seguimiento de dosis (próximas y atrasadas)
  const followups = async (site) => {
    let q = supabase.from('vaccination_records').select('id, site_id, applied_on, patient_doc_number, names, surnames, phone, vaccine_id, dose_index, next_dose_date, next_dose_label, vaccine:vaccines(name), site:sites(name)').not('next_dose_date', 'is', null)
    if (site) q = q.eq('site_id', site)
    const { data, error } = await q
    if (error) throw error
    const { data: all } = await supabase.from('vaccination_records').select('patient_doc_number, vaccine_id, applied_on, id').in('patient_doc_number', [...new Set(data.map((r) => r.patient_doc_number))].slice(0, 1000))
    const t = today()
    return data.filter((r) => !(all || []).some((x) => x.patient_doc_number === r.patient_doc_number && x.vaccine_id === r.vaccine_id && (x.applied_on > r.applied_on || (x.applied_on === r.applied_on && x.id > r.id))))
      .map((r) => ({ id: r.id, docNumber: r.patient_doc_number, patient: `${r.names} ${r.surnames || ''}`.trim(), phone: r.phone, vaccine: r.vaccine?.name, lastDose: r.applied_on, nextDose: r.next_dose_label, dueDate: r.next_dose_date, siteName: r.site?.name, daysLate: Math.round((new Date(`${t}T12:00:00Z`) - new Date(`${r.next_dose_date}T12:00:00Z`)) / 86400000) }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  }
  app.get('/vacunacion/seguimiento', ...gate, hx(async (req, res) => res.send(await followups(scopeSite(req)))))

  // ---------------------------------------------------------------- ESAVI
  app.post('/vacunacion/registros/:id/esavi', ...gate, hx(async (req, res) => {
    const b = req.body || {}
    const { data: r } = await supabase.from('vaccination_records').select('id, site_id').eq('id', Number(req.params.id)).maybeSingle()
    if (!r || !canAccessSite(req, r.site_id)) throw httpError(404, 'Registro no encontrado')
    if (!clean(b.symptoms)) return fail(res, 'Describe los síntomas', 400)
    if (!['leve', 'grave'].includes(b.severity)) return fail(res, 'Indica si el evento es leve o grave', 400)
    const onset = b.onsetAt && !Number.isNaN(Date.parse(b.onsetAt)) ? new Date(b.onsetAt).toISOString() : new Date().toISOString()
    const { data, error } = await supabase.from('esavi_reports').insert({ record_id: r.id, onset_at: onset, symptoms: clean(b.symptoms), severity: b.severity, actions: clean(b.actions), outcome: clean(b.outcome), notified_sivigila: Boolean(b.notified), notified_on: b.notified ? today() : null, created_by: req.user.id }).select('*').single()
    if (error) throw error
    res.status(201).send(data)
  }))
  app.get('/vacunacion/esavi', ...gate, hx(async (req, res) => {
    const { data, error } = await supabase.from('esavi_reports').select('*, record:vaccination_records!inner(id, site_id, applied_on, names, surnames, patient_doc_number, dose_label, lot, vaccine:vaccines(name))').order('onset_at', { ascending: false }).limit(200)
    if (error) throw error
    const site = scopeSite(req)
    res.send(data.filter((x) => !site || x.record.site_id === site).map((x) => ({ id: x.id, onsetAt: x.onset_at, symptoms: x.symptoms, severity: x.severity, actions: x.actions, outcome: x.outcome, notified: x.notified_sivigila, notifiedOn: x.notified_on, recordId: x.record.id, patient: `${x.record.names} ${x.record.surnames || ''}`.trim(), docNumber: x.record.patient_doc_number, vaccine: x.record.vaccine?.name, dose: x.record.dose_label, lot: x.record.lot, appliedOn: x.record.applied_on })))
  }))
  app.put('/vacunacion/esavi/:id/notificado', ...gate, hx(async (req, res) => {
    const { error } = await supabase.from('esavi_reports').update({ notified_sivigila: true, notified_on: today() }).eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Frascos abiertos
  app.get('/vacunacion/frascos', ...gate, hx(async (req, res) => {
    const site = scopeSite(req)
    const [vials, vaccines] = await Promise.all([openVials(site), supabase.from('vaccines').select('id, name')])
    res.send(vials.map((x) => ({ ...x, vaccine: (vaccines.data || []).find((v) => v.id === x.vaccineId)?.name })))
  }))
  app.post('/vacunacion/frascos/:id/cerrar', ...gate, hx(async (req, res) => {
    const reason = clean(req.body?.reason) || 'Descartado'
    const { error } = await supabase.from('vaccine_open_vials').update({ closed_at: new Date().toISOString(), close_reason: reason }).eq('id', Number(req.params.id)).is('closed_at', null)
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Dashboard
  app.get('/vacunacion/dashboard', ...gate, hx(async (req, res) => {
    const t = today()
    const ym = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : t.slice(0, 7)
    const [y, m] = ym.split('-').map(Number)
    const start = `${ym}-01`; const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    const site = scopeSite(req)
    let rq = supabase.from('vaccination_records').select('id, applied_on, birth_date, sex, modality, population_group, patient_doc_number, vaccine_id, vaccine:vaccines(name, pai), esavi:esavi_reports(id, severity, notified_sivigila)').gte('applied_on', start).lte('applied_on', end)
    if (site) rq = rq.eq('site_id', site)
    const [recs, vaccines, lots, vials, follow] = await Promise.all([rq, supabase.from('vaccines').select('id, name, product_id, pai').eq('active', true), lotsFor(site), openVials(site), followups(site)])
    if (recs.error) throw recs.error
    const R = recs.data
    const days = Number(end.slice(8, 10))
    const perDay = Array.from({ length: days }, (_, i) => ({ day: String(i + 1).padStart(2, '0'), pai: 0, particular: 0 }))
    for (const r of R) perDay[Number(r.applied_on.slice(8, 10)) - 1][r.vaccine?.pai ? 'pai' : 'particular'] += 1
    const byVaccine = Object.values(R.reduce((a, r) => { const k = r.vaccine?.name || '—'; a[k] = a[k] || { name: k, dosis: 0, pai: r.vaccine?.pai }; a[k].dosis += 1; return a }, {})).sort((a, b) => b.dosis - a.dosis)
    const AGE = [['< 1 año', 0, 0], ['1 a 5', 1, 5], ['6 a 17', 6, 17], ['18 a 59', 18, 59], ['60 y más', 60, 200]]
    const byAge = AGE.map(([name, a, b]) => ({ name, value: R.filter((r) => { const x = ageYears(r.birth_date, r.applied_on); return x >= a && x <= b }).length }))
    const byModality = Object.entries(MODALITIES).map(([k, l]) => ({ name: l, value: R.filter((r) => r.modality === k).length }))
    const byGroup = Object.values(R.reduce((a, r) => { const k = r.population_group || 'Población general'; a[k] = a[k] || { name: k, value: 0 }; a[k].value += 1; return a }, {})).sort((a, b) => b.value - a.value)
    const esavi = R.flatMap((r) => r.esavi || [])
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
    const stock = vaccines.data.filter((v) => v.product_id).reduce((acc, v) => {
      if (acc.some((x) => x.productId === v.product_id)) return acc
      const ls = lots.filter((l) => l.product_id === v.product_id)
      acc.push({ productId: v.product_id, name: v.name.replace(/ \(.*\)$/, ''), frascos: ls.reduce((s, l) => s + Number(l.stock), 0), porVencer: ls.filter((l) => l.expiry_date && l.expiry_date <= in60).map((l) => ({ lot: l.lot, expiry: l.expiry_date, stock: Number(l.stock) })) })
      return acc
    }, [])
    const overdue = follow.filter((f) => f.daysLate > 0)
    const upcoming = follow.filter((f) => f.daysLate <= 0 && f.daysLate >= -7)
    res.send({
      month: ym,
      kpis: {
        dosis: R.length, personas: new Set(R.map((r) => r.patient_doc_number)).size, pai: R.filter((r) => r.vaccine?.pai).length, particular: R.filter((r) => !r.vaccine?.pai).length,
        esavi: esavi.length, esaviGraves: esavi.filter((e) => e.severity === 'grave').length, esaviSinNotificar: esavi.filter((e) => e.severity === 'grave' && !e.notified_sivigila).length,
        atrasadas: overdue.length, proximas: upcoming.length, frascosAbiertos: vials.filter((v) => !v.expired && v.remaining > 0).length, frascosVencidos: vials.filter((v) => v.expired).length,
        lotesPorVencer: stock.reduce((s, x) => s + x.porVencer.length, 0)
      },
      perDay, byVaccine, byAge, byModality, byGroup, stock,
      vials: vials.map((v) => ({ ...v, vaccine: (vaccines.data || []).find((x) => x.id === v.vaccineId)?.name })),
      overdue: overdue.slice(0, 10), upcoming: upcoming.slice(0, 10)
    })
  }))
  return { history, followups, MODALITIES }
}
