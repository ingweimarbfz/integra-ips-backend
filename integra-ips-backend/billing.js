// =====================================================================
// Facturación general de los servicios de IPS: proveedores, EPS con convenio y cuentas de cobro.
// · Proveedores y entidades: catálogo general (toma de muestras, laboratorio, cadena de frío,
//   mantenimiento, insumos…) con datos de contacto; cada módulo usa las categorías que necesita.
// · EPS: catálogo con convenio opcional: descuento y forma de pago
//   (pago inmediato en caja o cuenta de cobro a la EPS).
// · Cuentas de cobro: agrupan las citologías pendientes de cobro por EPS.
// =====================================================================
const { pageQuery, setTotal } = require('./paging')
const V = require('./validate')
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite } = deps
  const STAFF = ['administrador', 'empleado']
  const REGIMEN = ['contributivo', 'subsidiado', 'ambos', 'especial']
  const MODES = ['contado', 'cuenta_cobro']
  // Entidades con convenio o responsables de pago (no solo EPS).
  const ENTITY_KINDS = ['eps', 'aseguradora', 'clinica', 'hospital_publico', 'empresa_publica', 'empresa_privada', 'ips', 'otra']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })

  // ---------------------------------------------------------------- Entidades
  const CATEGORIES = ['toma_muestras', 'laboratorio', 'cadena_frio', 'mantenimiento', 'insumos', 'servicios', 'otro']
  const entDTO = (e) => ({ id: e.id, name: e.name, nit: e.nit, description: e.description, active: e.active, categories: e.categories || [], contactName: e.contact_name, phone: e.phone, email: e.email, address: e.address, city: e.city })
  // ?categoria=toma_muestras,laboratorio filtra los proveedores de esas categorías.
  app.get('/proveedores', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('ips_entities').select('*').order('name')
    const cats = String(req.query.categoria || '').split(',').filter((c) => CATEGORIES.includes(c))
    if (cats.length) q = q.overlaps('categories', cats)
    const { data, error } = await q
    if (error) throw error
    res.send(data.map(entDTO))
  }))
  const entRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre es requerido')
    const cats = (Array.isArray(b.categories) ? b.categories : []).filter((c) => CATEGORIES.includes(c))
    if (!cats.length) e.push('Elige al menos una categoría')
    if (clean(b.email) && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(clean(b.email))) e.push('Correo inválido')
    for (const m of [V.phoneError(b.phone), V.nitError(b.nit)]) if (m) e.push(m)
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name), nit: V.nit(b.nit), description: clean(b.description), active: b.active !== false, categories: [...new Set(cats)], contact_name: clean(b.contactName), phone: V.phone(b.phone), email: clean(b.email)?.toLowerCase() ?? null, address: clean(b.address), city: clean(b.city), updated_at: new Date().toISOString() }
  }
  app.post('/proveedores', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('ips_entities').insert(entRow(req.body || {})).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un proveedor con ese nombre', 409); throw error }
    res.status(201).send(entDTO(data))
  }))
  app.put('/proveedores/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('ips_entities').update(entRow(req.body || {})).eq('id', Number(req.params.id)).select('*').maybeSingle()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un proveedor con ese nombre', 409); throw error }
    if (!data) return fail(res, 'Proveedor no encontrado', 404)
    res.send(entDTO(data))
  }))
  app.delete('/proveedores/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('cytology_samples').select('id', { count: 'exact', head: true }).eq('entity_id', Number(req.params.id))
    if (count) return fail(res, 'El proveedor ya tiene citologías registradas. Desactívalo en lugar de eliminarlo.', 409)
    const { error } = await supabase.from('ips_entities').delete().eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- EPS y convenios
  const today = () => todayBogota()
  const agreementActive = (e) => e.has_agreement && (!e.agreement_valid_until || e.agreement_valid_until >= today())
  const epsDTO = (e) => ({
    id: e.id, name: e.name, nit: e.nit, code: e.code, regimen: e.regimen, active: e.active,
    hasAgreement: e.has_agreement, agreementActive: agreementActive(e), agreementNumber: e.agreement_number, agreementValidUntil: e.agreement_valid_until,
    paymentMode: e.payment_mode, discountId: e.discount_id, discountEnabled: e.discount_enabled, discount: e.discount ? { id: e.discount.id, name: e.discount.name, type: e.discount.type, value: Number(e.discount.value), active: e.discount.active } : null,
    billingContact: e.billing_contact, billingEmail: e.billing_email, notes: e.notes,
    kind: e.kind || 'eps', withholdingAgent: e.withholding_agent !== false, stampsPct: Number(e.stamps_pct || 0), stampsLabel: e.stamps_label
  })
  const EPS_SELECT = '*, discount:discounts(id, name, type, value, active)'
  app.get('/eps', auth(STAFF), hx(async (req, res) => {
    const { data, error } = await supabase.from('eps_insurers').select(EPS_SELECT).order('name')
    if (error) throw error
    res.send(data.map(epsDTO))
  }))
  const epsRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre es requerido')
    if (b.regimen && !REGIMEN.includes(b.regimen)) e.push('Régimen inválido')
    if (!MODES.includes(b.paymentMode || 'contado')) e.push('Forma de pago inválida')
    if (clean(b.agreementValidUntil) && !ISO_DATE.test(b.agreementValidUntil)) e.push('Vigencia inválida')
    if (clean(b.billingEmail) && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(clean(b.billingEmail))) e.push('Correo inválido')
    if (b.kind && !ENTITY_KINDS.includes(b.kind)) e.push('Tipo de entidad inválido')
    { const m = V.nitError(b.nit); if (m) e.push(m) }
    if (b.stampsPct != null && b.stampsPct !== '' && (Number.isNaN(Number(b.stampsPct)) || Number(b.stampsPct) < 0 || Number(b.stampsPct) > 20)) e.push('Porcentaje de estampillas inválido')
    if (e.length) throw httpError(400, e.join('. '))
    const has = Boolean(b.hasAgreement)
    return {
      name: clean(b.name), nit: V.nit(b.nit), code: clean(b.code), regimen: b.regimen || null, active: b.active !== false, has_agreement: has,
      payment_mode: has ? (b.paymentMode || 'contado') : 'contado', discount_id: has ? Number(b.discountId) || null : null, discount_enabled: b.discountEnabled !== false,
      agreement_number: has ? clean(b.agreementNumber) : null, agreement_valid_until: has ? clean(b.agreementValidUntil) : null,
      billing_contact: clean(b.billingContact), billing_email: clean(b.billingEmail)?.toLowerCase() ?? null, notes: clean(b.notes), updated_at: new Date().toISOString(),
      kind: b.kind || 'eps', withholding_agent: b.withholdingAgent !== false, stamps_pct: Number(b.stampsPct) || 0, stamps_label: clean(b.stampsLabel)
    }
  }
  app.post('/eps', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('eps_insurers').insert(epsRow(req.body || {})).select(EPS_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una EPS con ese nombre', 409); throw error }
    res.status(201).send(epsDTO(data))
  }))
  app.put('/eps/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('eps_insurers').update(epsRow(req.body || {})).eq('id', Number(req.params.id)).select(EPS_SELECT).maybeSingle()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una EPS con ese nombre', 409); throw error }
    if (!data) return fail(res, 'EPS no encontrada', 404)
    res.send(epsDTO(data))
  }))
  // Activar o desactivar solo el descuento del convenio de una EPS.
  app.patch('/eps/:id/descuento', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('eps_insurers').update({ discount_enabled: Boolean(req.body?.enabled), updated_at: new Date().toISOString() }).eq('id', Number(req.params.id)).select(EPS_SELECT).maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 'EPS no encontrada', 404)
    res.send(epsDTO(data))
  }))
  app.delete('/eps/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('cytology_samples').select('id', { count: 'exact', head: true }).eq('eps_id', Number(req.params.id))
    if (count) return fail(res, 'La EPS ya tiene citologías registradas. Desactívala en lugar de eliminarla.', 409)
    const { error } = await supabase.from('eps_insurers').delete().eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))

  // Usado por el registro de citología: valida entidad, EPS y convenio, y calcula el cobro.
  const resolveBilling = async (body, base) => {
    const out = { entity_id: null, eps_id: null, payment_mode: 'contado', billing_status: 'no_aplica', discount: null }
    if (Number(body.entityId)) {
      const { data: en } = await supabase.from('ips_entities').select('id, name, active').eq('id', Number(body.entityId)).maybeSingle()
      if (!en || !en.active) throw httpError(400, 'La entidad seleccionada no está disponible')
      out.entity_id = en.id; out.entidad = en.name
    }
    if (Number(body.epsId)) {
      const { data: e } = await supabase.from('eps_insurers').select(EPS_SELECT).eq('id', Number(body.epsId)).maybeSingle()
      if (!e || !e.active) throw httpError(400, 'La EPS seleccionada no está disponible')
      out.eps_id = e.id; out.eps = e.name
      out.entity = { kind: e.kind || 'eps', agent: e.withholding_agent !== false, stampsPct: Number(e.stamps_pct || 0), stampsLabel: e.stamps_label }
      if (agreementActive(e)) {
        out.payment_mode = MODES.includes(body.paymentMode) ? body.paymentMode : e.payment_mode
        // Un solo descuento: si el convenio trae descuento activo, no se permite aplicar otro.
        if (e.discount_enabled && e.discount && e.discount.active) {
          if (body.discountId && Number(body.discountId) !== e.discount.id) throw httpError(400, `La EPS ya aplica el descuento del convenio (${e.discount.name}); no se puede aplicar otro descuento`)
          out.discount = e.discount; out.lockDiscount = true
        }
      } else if (body.paymentMode === 'cuenta_cobro') throw httpError(400, `${e.name} no tiene un convenio vigente: el servicio se paga en caja`)
    }
    if (out.payment_mode === 'cuenta_cobro') out.billing_status = 'pendiente'
    return out
  }

  // ---------------------------------------------------------------- Tarifario
  // Cada servicio de IPS tiene sus ítems con valor (no se escribe el valor a mano al facturar).
  const tariffDTO = (t) => ({ id: t.id, serviceId: t.service_id, name: t.name, code: t.code, price: Number(t.price), active: t.active, isDefault: t.is_default, ivaRate: Number(t.iva_rate || 0), isPyp: Boolean(t.is_pyp) })
  app.get('/facturacion/tarifas', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('service_tariffs').select('*').order('service_id').order('is_default', { ascending: false }).order('name')
    if (Number(req.query.servicio)) q = q.eq('service_id', Number(req.query.servicio))
    const { data, error } = await q
    if (error) throw error
    res.send(data.map(tariffDTO))
  }))
  const tariffRow = (b) => {
    const e = []
    if (!Number(b.serviceId)) e.push('Elige el servicio')
    if (!clean(b.name)) e.push('Escribe el nombre del ítem')
    const price = Number(b.price)
    if (b.price === '' || b.price == null || Number.isNaN(price) || price < 0) e.push('Valor inválido')
    if (e.length) throw httpError(400, e.join('. '))
    const iva = Number(b.ivaRate || 0)
    if (![0, 5, 19].includes(iva)) throw httpError(400, 'IVA inválido (0 %, 5 % o 19 %)')
    return { service_id: Number(b.serviceId), name: clean(b.name), code: clean(b.code), price, active: b.active !== false, is_default: Boolean(b.isDefault), iva_rate: iva, is_pyp: Boolean(b.isPyp), updated_at: new Date().toISOString() }
  }
  const saveTariff = async (row, id) => {
    if (row.is_default) await supabase.from('service_tariffs').update({ is_default: false }).eq('service_id', row.service_id).neq('id', id || 0)
    const q = id ? supabase.from('service_tariffs').update(row).eq('id', id) : supabase.from('service_tariffs').insert(row)
    const { data, error } = await q.select('*').maybeSingle()
    if (error) { if (error.code === '23505') throw httpError(409, 'Ya existe un ítem con ese nombre en el servicio'); throw error }
    if (!data) throw httpError(404, 'Ítem no encontrado')
    return tariffDTO(data)
  }
  app.post('/facturacion/tarifas', auth(ADMIN), hx(async (req, res) => res.status(201).send(await saveTariff(tariffRow(req.body || {})))))
  app.put('/facturacion/tarifas/:id', auth(ADMIN), hx(async (req, res) => res.send(await saveTariff(tariffRow(req.body || {}), Number(req.params.id)))))
  app.delete('/facturacion/tarifas/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count } = await supabase.from('service_charge_items').select('id', { count: 'exact', head: true }).eq('tariff_id', id)
    if (count) { await supabase.from('service_tariffs').update({ active: false }).eq('id', id); return res.send({ ok: true, deactivated: true }) }
    const { error } = await supabase.from('service_tariffs').delete().eq('id', id)
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Servicios facturables (todos los servicios de la IPS)
  // Todo servicio prestado queda como un cobro (service_charges) con sus ítems del tarifario y una factura FV- única.
  // Las citologías llegan "por facturar" desde su registro y se facturan aquí como los demás servicios.
  const discountAmount = (d, base) => Math.min(base, d.type === 'porcentaje' ? Math.round(base * Number(d.value) / 100) : Number(d.value))
  const nextInvoice = async () => { const { data, error } = await supabase.rpc('next_invoice_number'); if (error) throw error; return data }
  // Las citologías guardan su propio estado de cobro: se mantiene sincronizado.
  const syncSources = async (filter, patch) => {
    let q = supabase.from('service_charges').select('source_id').eq('source_table', 'cytology_samples')
    q = filter(q)
    const { data } = await q
    const ids = (data || []).map((x) => x.source_id).filter(Boolean)
    if (ids.length) { const { error } = await supabase.from('cytology_samples').update(patch).in('id', ids); if (error) throw error }
  }
  const recordCharge = async (row, items = []) => {
    const { data, error } = await supabase.from('service_charges').upsert(row, { onConflict: 'source_table,source_id' }).select('id').single()
    if (error) throw error
    if (items.length) {
      await supabase.from('service_charge_items').delete().eq('charge_id', data.id)
      const { error: e2 } = await supabase.from('service_charge_items').insert(items.map((i) => ({ ...i, charge_id: data.id })))
      if (e2) throw e2
    }
    return data.id
  }
  // Ítems del tarifario elegidos: [{ tariffId, quantity }] → filas con valor del tarifario.
  const buildItems = async (serviceId, list) => {
    const wanted = (Array.isArray(list) ? list : []).map((x) => ({ id: Number(x.tariffId), qty: Math.max(1, Math.min(99, Math.round(Number(x.quantity) || 1))) })).filter((x) => x.id)
    if (!wanted.length) throw httpError(400, 'Elige al menos un ítem del tarifario')
    const { data, error } = await supabase.from('service_tariffs').select('id, service_id, name, price, active, iva_rate, is_pyp').in('id', wanted.map((x) => x.id))
    if (error) throw error
    return wanted.map((w) => {
      const t = data.find((x) => x.id === w.id)
      if (!t || !t.active || t.service_id !== serviceId) throw httpError(400, 'Hay un ítem que no pertenece al servicio o está inactivo')
      return { tariff_id: t.id, name: t.name, quantity: w.qty, unit_price: Number(t.price), subtotal: Number(t.price) * w.qty, iva_rate: Number(t.iva_rate || 0), is_pyp: Boolean(t.is_pyp) }
    })
  }
  // Convenio, forma de pago y descuento sobre el valor de los ítems.
  const pricing = async (b, base) => {
    const bill = await resolveBilling(b, base)
    if (!deps.inPlan('facturacion') && bill.payment_mode === 'cuenta_cobro') { bill.payment_mode = 'contado'; bill.billing_status = 'no_aplica' }
    let d = null
    if (bill.lockDiscount) d = bill.discount
    else if (b.discountId) {
      const { data } = await supabase.from('discounts').select('*').eq('id', Number(b.discountId)).maybeSingle()
      if (!data || !data.active) throw httpError(400, 'El descuento seleccionado no está disponible')
      d = data
    }
    const amount = d ? discountAmount(d, base) : 0
    return { bill, d, amount }
  }
  // ---------------------------------------------------------------- Impuestos y pagos compartidos (norma colombiana)
  // IVA: servicios de salud excluidos (ET art. 476-1); solo ítems marcados como gravados.
  // Retención en la fuente y ReteICA: las practica el pagador (EPS / empresa); aquí se estiman para conocer el neto.
  // Copago y cuota moderadora (Acuerdo 260 de 2004): los paga el afiliado cuando la EPS asume el servicio; exentos P&P y poblaciones especiales.
  const TAX_FIELDS = { uvt: 'uvt', uvtYear: 'uvt_year', ivaRate: 'iva_rate', retefuenteRate: 'retefuente_rate', retefuenteMinUvt: 'retefuente_min_uvt', retefuenteEps: 'retefuente_eps', retefuenteGeneralRate: 'retefuente_general_rate', retefuenteEmpresa: 'retefuente_empresa', reteicaPerMil: 'reteica_per_mil', reteicaExcludeEps: 'reteica_exclude_eps', cuotaModeradora: 'cuota_moderadora', copagoPct: 'copago_pct', copagoTopeEvento: 'copago_tope_evento', copagoSubsidiadoPct: 'copago_subsidiado_pct', dianResolution: 'dian_resolution', dianPrefix: 'dian_prefix', dianFrom: 'dian_from', dianTo: 'dian_to', dianValidUntil: 'dian_valid_until' }
  const loadTax = async () => {
    const { data, error } = await supabase.from('billing_tax_settings').select('*').maybeSingle()
    if (error) throw error
    return data
  }
  const taxDTO = (t) => Object.fromEntries(Object.entries(TAX_FIELDS).map(([k, col]) => [k, t[col]]))
  app.get('/facturacion/impuestos', auth(STAFF), hx(async (req, res) => {
    const t = await loadTax()
    const { data: last } = await supabase.from('service_charges').select('invoice_number').not('invoice_number', 'is', null).order('invoice_number', { ascending: false }).limit(1)
    const used = Number(String(last?.[0]?.invoice_number || '').replace(/\D/g, '')) || 0
    res.send({ ...taxDTO(t), lastInvoice: used, rangeLeft: t.dian_to ? t.dian_to - used : null })
  }))
  app.put('/facturacion/impuestos', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const row = {}
    const num = (v, min = 0, max = 1e12) => { const n = Number(v); if (Number.isNaN(n) || n < min || n > max) throw httpError(400, 'Hay un valor numérico inválido'); return n }
    const range = (o, max) => ({ A: num(o?.A ?? 0, 0, max), B: num(o?.B ?? 0, 0, max), C: num(o?.C ?? 0, 0, max) })
    row.uvt = num(b.uvt, 1); row.uvt_year = num(b.uvtYear, 2000, 2100); row.iva_rate = num(b.ivaRate, 0, 100)
    row.retefuente_general_rate = num(b.retefuenteGeneralRate ?? 4, 0, 100)
    row.retefuente_rate = num(b.retefuenteRate, 0, 100); row.retefuente_min_uvt = num(b.retefuenteMinUvt, 0, 10000)
    row.retefuente_eps = Boolean(b.retefuenteEps); row.retefuente_empresa = Boolean(b.retefuenteEmpresa)
    row.reteica_per_mil = num(b.reteicaPerMil, 0, 100); row.reteica_exclude_eps = Boolean(b.reteicaExcludeEps)
    row.cuota_moderadora = range(b.cuotaModeradora, 1e7); row.copago_pct = range(b.copagoPct, 100); row.copago_tope_evento = range(b.copagoTopeEvento, 1e9)
    row.copago_subsidiado_pct = num(b.copagoSubsidiadoPct, 0, 100)
    row.dian_resolution = clean(b.dianResolution); row.dian_prefix = clean(b.dianPrefix)
    row.dian_from = b.dianFrom ? num(b.dianFrom, 0) : null; row.dian_to = b.dianTo ? num(b.dianTo, 0) : null
    row.dian_valid_until = ISO_DATE.test(b.dianValidUntil || '') ? b.dianValidUntil : null
    row.updated_at = new Date().toISOString()
    const { data, error } = await supabase.from('billing_tax_settings').update(row).select('*').single()
    if (error) throw error
    res.send(taxDTO(data))
  }))
  const EXEMPTIONS = { pyp: 'Promoción y prevención (Res. 3280 de 2018)', urgencias: 'Atención inicial de urgencias', alto_costo: 'Enfermedad de alto costo', ley1438: 'Niño, niña o adolescente exento (Ley 1438 de 2011, art. 18)', victima: 'Víctima del conflicto (Ley 1448 de 2011)', indigena: 'Población indígena', otra: 'Otra exención legal' }
  // Totales de la factura: descuento → IVA por ítem → pago compartido (si la EPS paga) → retenciones estimadas.
  const computeTotals = (items, d, bill, b, tax, payerType) => {
    const subtotal = items.reduce((a, i) => a + i.subtotal, 0)
    const discount = d ? discountAmount(d, subtotal) : 0
    const factor = subtotal ? (subtotal - discount) / subtotal : 0
    const iva = Math.round(items.reduce((a, i) => { const v = Math.round(i.subtotal * factor * (Number(i.iva_rate) || 0) / 100); i.iva_amount = v; return a + v }, 0))
    const base = subtotal - discount
    const total = base + iva
    // Paga una entidad con convenio (EPS, clínica, empresa…) por cuenta de cobro.
    const entityPays = bill.payment_mode === 'cuenta_cobro' && Boolean(bill.eps_id)
    const isEps = entityPays && (bill.entity?.kind || 'eps') === 'eps'
    const epsPays = isEps
    let shared = { type: 'ninguno', amount: 0, reason: null }
    const regimen = ['contributivo', 'subsidiado'].includes(b.regimen) ? b.regimen : null
    const affiliate = ['cotizante', 'beneficiario'].includes(b.affiliateType) ? b.affiliateType : null
    const rng = ['A', 'B', 'C'].includes(b.incomeRange) ? b.incomeRange : 'A'
    if (epsPays) {
      const allPyp = items.length > 0 && items.every((i) => i.is_pyp)
      const exempt = allPyp ? 'pyp' : (EXEMPTIONS[b.exemption] ? b.exemption : null)
      const wanted = ['cuota_moderadora', 'copago'].includes(b.sharedType) ? b.sharedType : null
      if (exempt) shared = { type: 'ninguno', amount: 0, reason: EXEMPTIONS[exempt] }
      else if (regimen === 'subsidiado') shared = { type: 'copago', amount: Math.round(base * Number(tax.copago_subsidiado_pct) / 100), reason: null }
      else if (regimen === 'contributivo') {
        // Cotizantes: solo cuota moderadora. Beneficiarios: cuota moderadora o copago según el servicio.
        const type = affiliate === 'cotizante' ? 'cuota_moderadora' : (wanted || 'cuota_moderadora')
        if (type === 'cuota_moderadora') shared = { type, amount: Math.min(base, Number(tax.cuota_moderadora?.[rng] || 0)), reason: null }
        else {
          let amt = Math.round(base * Number(tax.copago_pct?.[rng] || 0) / 100)
          const tope = Number(tax.copago_tope_evento?.[rng] || 0)
          if (tope > 0) amt = Math.min(amt, tope)
          shared = { type, amount: amt, reason: null }
        }
      }
    }
    const payable = total - shared.amount
    // Retenciones estimadas: solo las practica un pagador agente retenedor (EPS, entidades y empresas, no personas naturales).
    const agent = entityPays
      ? (bill.entity?.agent === false ? null : isEps ? (tax.retefuente_eps ? 'eps' : null) : (tax.retefuente_empresa ? 'entidad' : null))
      : (payerType === 'empresa' && tax.retefuente_empresa ? 'empresa' : null)
    const preIva = payable - iva
    // Servicios de salud: tarifa de salud; ítems no asistenciales (gravados con IVA): tarifa de servicios en general.
    const nonHealth = Math.round(items.filter((i) => Number(i.iva_rate) > 0).reduce((a, i) => a + i.subtotal * factor, 0))
    const health = Math.max(0, preIva - nonHealth)
    const retefuente = agent && preIva >= Number(tax.retefuente_min_uvt) * Number(tax.uvt) ? Math.round(health * Number(tax.retefuente_rate) / 100 + nonHealth * Number(tax.retefuente_general_rate ?? 4) / 100) : 0
    const reteica = agent && !(isEps && tax.reteica_exclude_eps) ? Math.round(preIva * Number(tax.reteica_per_mil) / 1000) : 0
    // Estampillas u otras deducciones de entidades públicas (según la ordenanza o acuerdo de cada entidad).
    const stamps = entityPays && bill.entity?.stampsPct ? Math.round(preIva * bill.entity.stampsPct / 100) : 0
    return {
      subtotal, discount, base, iva, total, stamps, reteica, entityPays, isEps, stampsLabel: bill.entity?.stampsLabel || 'Estampillas',
      fields: {
        valor_base: subtotal, discount_id: d?.id ?? null, discount_name: d?.name ?? null, discount_amount: discount,
        iva_amount: iva, total_invoice: total, valor: payable, regimen: epsPays ? regimen : null, affiliate_type: epsPays ? affiliate : null, income_range: epsPays && regimen === 'contributivo' ? rng : null,
        shared_type: shared.type, shared_amount: shared.amount, shared_exempt_reason: shared.reason, retefuente_est: retefuente, reteica_est: reteica + stamps, net_expected: payable - retefuente - reteica - stamps
      }
    }
  }
  // Vista previa de los totales (misma regla que al facturar; no toma número ni guarda nada).
  app.post('/facturacion/cotizar', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    let serviceId = Number(b.serviceId); let entityId = null; let payerType = b.payerType || 'paciente'
    if (Number(b.chargeId)) { req.params.id = b.chargeId; const c = await loadCharge(req); serviceId = c.service_id; entityId = c.entity_id; payerType = c.payer_type }
    const items = await buildItems(serviceId, b.items)
    const { bill, d } = await pricing({ ...b, entityId }, items.reduce((a, i) => a + i.subtotal, 0))
    const t = computeTotals(items, d, bill, b, await loadTax(), payerType)
    res.send({ subtotal: t.subtotal, discount: t.discount, discountName: d?.name ?? null, iva: t.iva, total: t.total, shared: { type: t.fields.shared_type, amount: t.fields.shared_amount, exemptReason: t.fields.shared_exempt_reason }, payable: t.fields.valor, retefuente: t.fields.retefuente_est, reteica: t.reteica, stamps: t.stamps, stampsLabel: t.stampsLabel, netExpected: t.fields.net_expected, epsPays: t.entityPays, isEps: t.isEps, entityKind: bill.entity?.kind || null })
  }))
  // Valida la numeración autorizada por la DIAN (si está configurada) antes de tomar un número.
  const checkDianRange = async (tax) => {
    if (tax.dian_valid_until && tax.dian_valid_until < today()) throw httpError(409, 'La resolución de facturación DIAN está vencida: actualízala en Facturación → Impuestos y numeración')
    if (tax.dian_to) {
      const { data: last } = await supabase.from('service_charges').select('invoice_number').not('invoice_number', 'is', null).order('invoice_number', { ascending: false }).limit(1)
      const used = Number(String(last?.[0]?.invoice_number || '').replace(/\D/g, '')) || 0
      if (used >= tax.dian_to) throw httpError(409, 'Se agotó el rango de numeración autorizado por la DIAN: actualízalo en Facturación → Impuestos y numeración')
    }
  }

  // Servicios con formulario propio: primero se factura y luego el formulario toma la factura por el documento del paciente.
  const FORM_SERVICES = {
    citologia: { table: 'cytology_samples', label: 'Registrar citología', path: '/citologias/registrar' },
    cadena_frio: { table: 'vaccination_records', label: 'Registrar vacunación', path: '/vacunacion/registrar' }
  }
  const CHARGE_SELECT = 'id, site_id, service_id, service_name, source_table, source_id, service_date, patient_name, patient_doc, patient_doc_type, patient_doc_number, patient_names, patient_surnames, payer_type, payer_name, payer_doc_type, payer_doc_number, payer_phone, payer_email, form_units, uses:service_charge_uses(id, source_table, source_id, patient_name, patient_doc_number), service:ips_services(module), description, reference, invoice_number, invoiced_at, eps_id, entity_id, valor_base, discount_id, discount_name, discount_amount, valor, iva_amount, total_invoice, regimen, affiliate_type, income_range, shared_type, shared_amount, shared_exempt_reason, retefuente_est, reteica_est, net_expected, payment_mode, billing_status, billing_id, void_reason, created_at, eps:eps_insurers(name), site:sites(name), items:service_charge_items(id, tariff_id, name, quantity, unit_price, subtotal, iva_rate, iva_amount, is_pyp)'
  const chargeDTO = (r) => ({
    id: r.id, siteId: r.site_id, siteName: r.site?.name ?? null, serviceId: r.service_id, serviceName: r.service_name, source: r.source_table, sourceId: r.source_id,
    fecha: r.service_date, paciente: r.patient_name || '', documento: r.patient_doc || '',
    docType: r.patient_doc_type, docNumber: r.patient_doc_number, names: r.patient_names, surnames: r.patient_surnames,
    payer: { type: r.payer_type, name: r.payer_name, docType: r.payer_doc_type, docNumber: r.payer_doc_number, phone: r.payer_phone, email: r.payer_email },
    form: FORM_SERVICES[r.service?.module] ? { ...FORM_SERVICES[r.service.module], units: r.form_units || 0, used: (r.uses || []).length, linked: (r.uses || []).length >= (r.form_units || 1), uses: (r.uses || []).map((u) => ({ sourceId: u.source_id, patient: u.patient_name, doc: u.patient_doc_number })) } : null, descripcion: r.description, numFactura: r.invoice_number, reference: r.reference, invoicedAt: r.invoiced_at,
    epsId: r.eps_id, epsName: r.eps?.name ?? null, entityId: r.entity_id, valorBase: Number(r.valor_base), descuento: Number(r.discount_amount || 0), descuentoNombre: r.discount_name, valor: Number(r.valor),
    paymentMode: r.payment_mode, billingStatus: r.billing_status, billingId: r.billing_id, voidReason: r.void_reason, createdAt: r.created_at,
    iva: Number(r.iva_amount || 0), total: Number(r.total_invoice ?? r.valor), regimen: r.regimen, affiliateType: r.affiliate_type, incomeRange: r.income_range,
    shared: { type: r.shared_type || 'ninguno', amount: Number(r.shared_amount || 0), exemptReason: r.shared_exempt_reason },
    retefuente: Number(r.retefuente_est || 0), reteica: Number(r.reteica_est || 0), netExpected: Number(r.net_expected ?? r.valor),
    items: (r.items || []).map((i) => ({ id: i.id, tariffId: i.tariff_id, name: i.name, quantity: i.quantity, unitPrice: Number(i.unit_price), subtotal: Number(i.subtotal), ivaRate: Number(i.iva_rate || 0), iva: Number(i.iva_amount || 0), isPyp: Boolean(i.is_pyp) }))
  })
  const loadCharge = async (req) => {
    const { data, error } = await supabase.from('service_charges').select(CHARGE_SELECT).eq('id', Number(req.params.id)).maybeSingle()
    if (error) throw error
    if (!data || (data.site_id && !canAccessSite(req, data.site_id))) throw httpError(404, 'Servicio no encontrado')
    return data
  }
  // Una factura (para verla, imprimirla o compartirla).
  const getCharge = async (id) => {
    const { data, error } = await supabase.from('service_charges').select(CHARGE_SELECT).eq('id', Number(id)).maybeSingle()
    if (error) throw error
    return data ? { ...chargeDTO(data), siteId: data.site_id } : null
  }
  app.get('/facturacion/servicios/:id', auth(STAFF), hx(async (req, res) => {
    const c = await getCharge(req.params.id)
    if (!c || (c.siteId && !canAccessSite(req, c.siteId))) throw httpError(404, 'Factura no encontrada')
    const tax = await loadTax()
    res.send({ ...c, dian: { resolution: tax.dian_resolution, prefix: tax.dian_prefix, from: tax.dian_from, to: tax.dian_to, validUntil: tax.dian_valid_until } })
  }))
  // Servicios de IPS con su tarifario activo.
  app.get('/facturacion/catalogo', auth(STAFF), hx(async (req, res) => {
    const [{ data, error }, tariffs] = await Promise.all([
      supabase.from('ips_services').select('id, name, module, active').eq('active', true).order('name'),
      supabase.from('service_tariffs').select('*').eq('active', true).order('is_default', { ascending: false }).order('name')
    ])
    if (error) throw error
    res.send(data.map((x) => ({ id: x.id, name: x.name, module: x.module, form: FORM_SERVICES[x.module] || null, tariffs: (tariffs.data || []).filter((t) => t.service_id === x.id).map(tariffDTO) })))
  }))
  app.get('/facturacion/servicios', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('service_charges').select(CHARGE_SELECT, { count: 'exact' }).order('service_date', { ascending: false }).order('id', { ascending: false })
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    if (req.query.estado === 'por_facturar') q = q.eq('billing_status', 'por_facturar')
    else {
      if (ISO_DATE.test(req.query.desde || '')) q = q.gte('service_date', req.query.desde)
      if (ISO_DATE.test(req.query.hasta || '')) q = q.lte('service_date', req.query.hasta)
    }
    if (Number(req.query.servicio)) q = q.eq('service_id', Number(req.query.servicio))
    if (req.query.estado === 'facturados') q = q.neq('billing_status', 'por_facturar')
    // Sin ?pagina la pantalla trae el periodo completo (hasta 1.000) para que los totales cuadren.
    const { data, error, count } = await pageQuery(req, q, 1000)
    if (error) throw error
    setTotal(res, count)
    res.send(data.map(chargeDTO))
  }))
  // Registrar y facturar un servicio (ítems del tarifario, convenio, forma de pago y descuento).
  // Crear y facturar un servicio (lo usa la pantalla de facturación y los módulos que facturan solos, como vacunación PAI a la EPS).
  const createInvoice = async (req, b) => {
    const e = []
    const { data: svc } = await supabase.from('ips_services').select('id, name, module, active').eq('id', Number(b.serviceId)).maybeSingle()
    if (!svc || !svc.active) e.push('Elige el servicio')
    if (!ISO_DATE.test(b.date || '') || b.date > today()) e.push('Fecha del servicio inválida')
    const names = clean(b.names); const surnames = clean(b.surnames)
    const docNumber = clean(String(b.docNumber || '').replace(/[^\dA-Za-z]/g, ''))
    // Quién paga: el mismo paciente, otra persona o una empresa. El paciente puede quedar sin definir (se define en el formulario).
    const payerType = ['paciente', 'tercero', 'empresa'].includes(b.payerType) ? b.payerType : 'paciente'
    const payerName = clean(b.payerName); const payerDoc = clean(String(b.payerDocNumber || '').replace(/[^\dA-Za-z]/g, ''))
    for (const m of [V.phoneError(b.payerPhone, 'El teléfono de quien paga'), V.emailError(b.payerEmail, 'El correo de quien paga'), V.docError(docNumber, clean(b.docType)), payerType === 'empresa' ? V.nitError(payerDoc, 'El NIT de la empresa') : V.docError(payerDoc, clean(b.payerDocType), 'El documento de quien paga')]) if (m) e.push(m)
    if (payerType === 'paciente') {
      if (!names) e.push('Escribe los nombres del paciente')
      if (svc && FORM_SERVICES[svc.module] && !docNumber) e.push('Escribe el número de documento del paciente: con él se enlaza la factura al formulario')
    } else {
      if (!payerName) e.push(payerType === 'empresa' ? 'Escribe la razón social de la empresa' : 'Escribe el nombre de quien paga')
      if (!payerDoc) e.push(payerType === 'empresa' ? 'Escribe el NIT de la empresa' : 'Escribe el documento de quien paga')
    }
    if (e.length) throw httpError(400, e.join('. '))
    const items = await buildItems(svc.id, b.items)
    // Antes de tomar el consecutivo: así un error no deja huecos en la numeración.
    const units = FORM_SERVICES[svc.module] ? items.reduce((a, i) => a + i.quantity, 0) : 0
    if (units > 1 && docNumber) throw httpError(400, 'Una factura con varios servicios no puede quedar a nombre de un solo paciente: deja el paciente en blanco y se define al registrar cada formulario')
    const base = items.reduce((a, i) => a + i.subtotal, 0)
    const { bill, d } = await pricing(b, base)
    const tax = await loadTax()
    const totals = computeTotals(items, d, bill, b, tax, payerType)
    const siteId = await deps.targetSite(req, b.siteId)
    await checkDianRange(tax)
    const invoice = await nextInvoice()
    const patientName = names ? [names, surnames].filter(Boolean).join(' ') : null
    const id = await recordCharge({
      site_id: siteId, service_id: svc.id, service_name: svc.name, service_date: b.date, form_units: units,
      payer_type: payerType, payer_name: payerType === 'paciente' ? patientName : payerName, payer_doc_type: payerType === 'paciente' ? clean(b.docType) : clean(b.payerDocType),
      payer_doc_number: payerType === 'paciente' ? docNumber : payerDoc, payer_phone: V.phone(b.payerPhone), payer_email: clean(b.payerEmail)?.toLowerCase() ?? null,
      patient_name: patientName || (payerType === 'paciente' ? null : `Por definir · ${payerName}`), patient_names: names, patient_surnames: surnames,
      patient_doc_type: clean(b.docType), patient_doc_number: docNumber, patient_doc: docNumber ? [clean(b.docType), docNumber].filter(Boolean).join(' ') : clean(b.patientDoc),
      description: clean(b.description), reference: clean(b.reference), invoice_number: invoice, invoiced_at: new Date().toISOString(), eps_id: bill.eps_id, entity_id: bill.entity_id,
      ...totals.fields, payment_mode: bill.payment_mode, billing_status: bill.billing_status, created_by: req.user.id
    }, items)
    return id
  }
  app.post('/facturacion/servicios', auth(STAFF), hx(async (req, res) => {
    req.params.id = await createInvoice(req, req.body || {})
    res.status(201).send(chargeDTO(await loadCharge(req)))
  }))
  // Facturas del servicio con cupos sin usar: por documento del paciente, documento/NIT de quien paga o número de factura.
  const remaining = (c) => Math.max(0, (c.form_units || 1) - (c.uses || []).length)
  const availableInvoices = async (module, query, site) => {
    const { data: svc } = await supabase.from('ips_services').select('id').eq('module', module).maybeSingle()
    const q = String(query || '').trim().toUpperCase()
    if (!svc || q.length < 3) return []
    const digits = q.replace(/[^\dA-Z]/g, '')
    const fv = /^FV-?\d+$/.test(q) ? `FV-${q.replace(/\D/g, '').padStart(7, '0')}` : null
    let sq = supabase.from('service_charges').select(CHARGE_SELECT).eq('service_id', svc.id).not('billing_status', 'in', '(anulada,por_facturar)')
      .order('service_date', { ascending: false }).limit(20)
    sq = fv ? sq.eq('invoice_number', fv) : sq.or(`patient_doc_number.eq.${digits},payer_doc_number.eq.${digits}`)
    if (site) sq = sq.eq('site_id', site)
    const { data, error } = await sq
    if (error) throw error
    return data.filter((c) => remaining(c) > 0).map((c) => ({ ...chargeDTO(c), remaining: remaining(c) }))
  }
  app.get('/facturacion/facturas-disponibles', auth(STAFF), hx(async (req, res) => {
    const module = String(req.query.modulo || '')
    if (!FORM_SERVICES[module]) return fail(res, 'Servicio sin formulario', 400)
    res.send(await availableInvoices(module, req.query.q || req.query.documento, scopeSite(req)))
  }))
  // El formulario toma un cupo de la factura: del servicio, de la sede, con cupos y, si la factura tiene paciente, del mismo documento.
  const takeInvoice = async (req, { module, chargeId, docNumber, siteId }) => {
    const { data: c } = await supabase.from('service_charges').select(CHARGE_SELECT).eq('id', Number(chargeId)).maybeSingle()
    if (!c || c.service?.module !== module) throw httpError(400, 'La factura no corresponde a este servicio')
    if (['anulada', 'por_facturar'].includes(c.billing_status)) throw httpError(400, 'La factura no está vigente')
    if (remaining(c) <= 0) throw httpError(409, `La factura ${c.invoice_number} ya no tiene cupos: todos sus servicios están registrados`)
    const doc = String(docNumber || '').replace(/[^\dA-Za-z]/g, '')
    if (c.patient_doc_number && String(c.patient_doc_number) !== doc) throw httpError(400, `La factura ${c.invoice_number} es para el paciente con documento ${c.patient_doc_number}`)
    if (siteId && c.site_id && Number(c.site_id) !== Number(siteId)) throw httpError(400, `La factura ${c.invoice_number} es de otra sede`)
    if (!canAccessSite(req, c.site_id)) throw httpError(403, 'No tienes acceso a esa factura')
    const units = c.form_units || 1
    return { ...c, unitValor: Math.round(Number(c.valor) / units), unitBase: Math.round(Number(c.valor_base) / units), unitDiscount: Math.round(Number(c.discount_amount || 0) / units) }
  }
  const linkInvoice = async (chargeId, table, sourceId, reference, patient = {}) => {
    const { error } = await supabase.from('service_charge_uses').insert({ charge_id: chargeId, source_table: table, source_id: sourceId, patient_doc_number: patient.doc || null, patient_name: patient.name || null })
    if (error) throw error
    const { data: c } = await supabase.from('service_charges').select('id, form_units, patient_doc_number, uses:service_charge_uses(id)').eq('id', chargeId).single()
    // Factura de un solo servicio: queda enlazada directamente al registro (y toma el paciente si no lo tenía).
    if ((c.form_units || 1) === 1) await supabase.from('service_charges').update({ source_table: table, source_id: sourceId, reference, ...(c.patient_doc_number ? {} : { patient_doc_number: patient.doc || null, patient_name: patient.name || null, patient_doc: patient.doc || null }) }).eq('id', chargeId)
    return true
  }

  // Facturar un servicio que llegó "por facturar" desde su módulo (por ejemplo, una citología).
  app.post('/facturacion/servicios/:id/facturar', auth(STAFF), hx(async (req, res) => {
    const c = await loadCharge(req)
    if (c.billing_status !== 'por_facturar') return fail(res, 'Este servicio ya está facturado', 409)
    const b = req.body || {}
    const items = await buildItems(c.service_id, b.items || (c.items || []).filter((i) => i.tariff_id).map((i) => ({ tariffId: i.tariff_id, quantity: i.quantity })))
    if (!items.length) return fail(res, 'Elige al menos un ítem del tarifario', 400)
    const base = items.reduce((a, i) => a + i.subtotal, 0)
    const epsId = b.epsId !== undefined ? b.epsId : c.eps_id
    const { bill, d } = await pricing({ ...b, epsId, entityId: c.entity_id }, base)
    const tax = await loadTax()
    const totals = computeTotals(items, d, bill, b, tax, c.payer_type)
    await checkDianRange(tax)
    const invoice = await nextInvoice()
    const patch = { invoice_number: invoice, invoiced_at: new Date().toISOString(), eps_id: bill.eps_id, ...totals.fields, payment_mode: bill.payment_mode, billing_status: bill.billing_status }
    const { error } = await supabase.from('service_charges').update(patch).eq('id', c.id).eq('billing_status', 'por_facturar')
    if (error) throw error
    await supabase.from('service_charge_items').delete().eq('charge_id', c.id)
    const { error: e2 } = await supabase.from('service_charge_items').insert(items.map((i) => ({ ...i, charge_id: c.id })))
    if (e2) throw e2
    if (c.source_table === 'cytology_samples') {
      const { error: e3 } = await supabase.from('cytology_samples').update({
        num_factura: invoice, eps_id: bill.eps_id, eps: bill.eps ?? null, valor_base: totals.subtotal, valor: totals.fields.valor, discount_id: d?.id ?? null, discount_name: d?.name ?? null,
        discount_amount: d ? totals.discount : null, payment_mode: bill.payment_mode, billing_status: bill.billing_status
      }).eq('id', c.source_id)
      if (e3) throw e3
    }
    res.send(chargeDTO(await loadCharge(req)))
  }))
  // Anular una factura (no se borra: el consecutivo queda registrado como anulado).
  app.post('/facturacion/servicios/:id/anular', auth(ADMIN), hx(async (req, res) => {
    const c = await loadCharge(req)
    if (['cobrada', 'pagada'].includes(c.billing_status)) return fail(res, 'El servicio ya está en una cuenta de cobro: anula primero la cuenta de cobro', 409)
    if (c.billing_status === 'anulada') return fail(res, 'La factura ya está anulada', 409)
    const reason = clean(req.body?.reason)
    if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
    const { error } = await supabase.from('service_charges').update({ billing_status: 'anulada', void_reason: reason }).eq('id', c.id)
    if (error) throw error
    if (c.source_table === 'cytology_samples') await supabase.from('cytology_samples').update({ billing_status: 'anulada' }).eq('id', c.source_id)
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Cuentas de cobro
  const pendingQuery = (req, epsId, from, to, serviceId) => {
    let q = supabase.from('service_charges').select(CHARGE_SELECT).eq('payment_mode', 'cuenta_cobro').eq('billing_status', 'pendiente').order('service_date')
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    if (epsId) q = q.eq('eps_id', epsId)
    if (serviceId) q = q.eq('service_id', serviceId)
    if (from) q = q.gte('service_date', from)
    if (to) q = q.lte('service_date', to)
    return q
  }
  app.get('/facturacion/cuentas-cobro/pendientes', auth(STAFF), hx(async (req, res) => {
    const from = ISO_DATE.test(req.query.desde || '') ? req.query.desde : null
    const to = ISO_DATE.test(req.query.hasta || '') ? req.query.hasta : null
    const { data, error } = await pendingQuery(req, Number(req.query.eps) || null, from, to, Number(req.query.servicio) || null)
    if (error) throw error
    const byEps = {}
    for (const r of data) {
      const k = r.eps_id || 0
      byEps[k] = byEps[k] || { epsId: r.eps_id, epsName: r.eps?.name || 'Sin EPS', count: 0, total: 0, services: {}, rows: [] }
      byEps[k].count += 1; byEps[k].total += Number(r.valor); byEps[k].rows.push(chargeDTO(r))
      byEps[k].services[r.service_name] = (byEps[k].services[r.service_name] || 0) + 1
    }
    res.send(Object.values(byEps).map((g) => ({ ...g, services: Object.entries(g.services).map(([name, count]) => ({ name, count })) })).sort((a, b) => b.total - a.total))
  }))
  const billDTO = (b) => ({ id: b.id, code: b.code, epsId: b.eps_id, epsName: b.eps?.name ?? null, epsNit: b.eps?.nit ?? null, agreementNumber: b.eps?.agreement_number ?? null, siteName: b.site?.name ?? null, from: b.period_from, to: b.period_to, total: Number(b.total), count: b.items_count, status: b.status, notes: b.notes, createdAt: b.created_at, paidAt: b.paid_at, createdBy: b.creator ? `${b.creator.name} ${b.creator.last_name}` : null })
  const BILL_SELECT = '*, eps:eps_insurers(name, nit, agreement_number, billing_contact, billing_email), site:sites(name), creator:users!eps_billings_created_by_fkey(name, last_name)'
  app.get('/facturacion/cuentas-cobro', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('eps_billings').select(BILL_SELECT).order('created_at', { ascending: false }).limit(200)
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    const [{ data, error }, items] = await Promise.all([q, supabase.from('service_charges').select('billing_id, service_name').not('billing_id', 'is', null)])
    if (error) throw error
    const svcBy = {}
    for (const i of items.data || []) (svcBy[i.billing_id] = svcBy[i.billing_id] || new Set()).add(i.service_name)
    res.send(data.map((b) => ({ ...billDTO(b), services: [...(svcBy[b.id] || [])] })))
  }))
  // Genera una cuenta de cobro con los servicios pendientes de una EPS en un periodo (de uno o de todos los servicios).
  app.post('/facturacion/cuentas-cobro', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const epsId = Number(b.epsId)
    if (!epsId) return fail(res, 'Elige la EPS', 400)
    const from = ISO_DATE.test(b.from || '') ? b.from : null
    const to = ISO_DATE.test(b.to || '') ? b.to : null
    const { data: rows, error } = await pendingQuery(req, epsId, from, to, Number(b.serviceId) || null)
    if (error) throw error
    const ids = Array.isArray(b.ids) && b.ids.length ? rows.filter((r) => b.ids.map(Number).includes(r.id)) : rows
    if (!ids.length) return fail(res, 'No hay servicios pendientes de cobro para esa EPS y periodo', 400)
    const site = scopeSite(req) || ids[0].site_id
    const { data: bill, error: e2 } = await supabase.from('eps_billings').insert({
      eps_id: epsId, site_id: site, period_from: from || ids[0].service_date, period_to: to || ids[ids.length - 1].service_date,
      total: ids.reduce((a, r) => a + Number(r.valor), 0), items_count: ids.length, notes: clean(b.notes), created_by: req.user.id
    }).select('id').single()
    if (e2) throw e2
    const chargeIds = ids.map((r) => r.id)
    const { error: e3 } = await supabase.from('service_charges').update({ billing_status: 'cobrada', billing_id: bill.id }).in('id', chargeIds)
    if (e3) throw e3
    await syncSources((q) => q.in('id', chargeIds), { billing_status: 'cobrada', billing_id: bill.id })
    res.status(201).send({ id: bill.id })
  }))
  const loadBill = async (req) => {
    const { data, error } = await supabase.from('eps_billings').select(BILL_SELECT).eq('id', Number(req.params.id)).maybeSingle()
    if (error) throw error
    if (!data || (data.site_id && !canAccessSite(req, data.site_id))) throw httpError(404, 'Cuenta de cobro no encontrada')
    return data
  }
  // Dashboard de facturación: cartera, recaudo, antigüedad, servicios y comportamiento por EPS.
  app.get('/facturacion/resumen', auth(STAFF), hx(async (req, res) => {
    const year = /^\d{4}$/.test(req.query.anio || '') ? req.query.anio : today().slice(0, 4)
    const site = scopeSite(req)
    let sq = supabase.from('service_charges').select('id, service_name, service_date, valor, valor_base, discount_amount, payment_mode, billing_status, eps_id').gte('service_date', `${year}-01-01`).lte('service_date', `${year}-12-31`)
    let bq = supabase.from('eps_billings').select('id, code, eps_id, total, items_count, status, created_at, paid_at')
    if (site) { sq = sq.eq('site_id', site); bq = bq.eq('site_id', site) }
    const [samples, bills, eps] = await Promise.all([sq, bq, supabase.from('eps_insurers').select('id, name, has_agreement, agreement_valid_until, discount_enabled, payment_mode')])
    for (const r of [samples, bills, eps]) if (r.error) throw r.error
    const toInvoice = samples.data.filter((x) => x.billing_status === 'por_facturar')
    const S = samples.data.filter((x) => !['por_facturar', 'anulada'].includes(x.billing_status)).map((x) => ({ ...x, fecha_examen: x.service_date })); const Bs = bills.data.filter((b) => b.status !== 'anulada')
    const sum = (a, k = 'valor') => a.reduce((t, x) => t + Number(x[k] || 0), 0)
    const days = (a, b) => Math.round((new Date(`${String(b).slice(0, 10)}T12:00:00`) - new Date(`${String(a).slice(0, 10)}T12:00:00`)) / 86400000)
    const t = today()
    const pending = S.filter((x) => x.billing_status === 'pendiente')
    const emitted = Bs.filter((b) => b.status === 'emitida')
    const paid = Bs.filter((b) => b.status === 'pagada' && String(b.paid_at || '').startsWith(year))
    const paidAll = Bs.filter((b) => b.status === 'pagada' && b.paid_at)
    const avgDays = paidAll.length ? Math.round(paidAll.reduce((a, b) => a + days(b.created_at, b.paid_at), 0) / paidAll.length) : null
    const overdue = emitted.filter((b) => days(b.created_at, t) > 30)
    const epsName = (id) => eps.data.find((e) => e.id === id)?.name || 'Sin EPS'
    const byEpsMap = {}
    const slot = (id) => (byEpsMap[id || 0] = byEpsMap[id || 0] || { epsId: id, name: epsName(id), pendiente: 0, cobrado: 0, pagado: 0, servicios: 0, descuentos: 0 })
    for (const x of S.filter((y) => y.payment_mode === 'cuenta_cobro')) { const o = slot(x.eps_id); o.servicios += 1; o.descuentos += Number(x.discount_amount || 0); if (x.billing_status === 'pendiente') o.pendiente += Number(x.valor) }
    for (const b of emitted) slot(b.eps_id).cobrado += Number(b.total)
    for (const b of paid) slot(b.eps_id).pagado += Number(b.total)
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
    const curMonth = t.startsWith(year) ? Number(t.slice(5, 7)) : 12
    const byMonth = months.slice(0, curMonth).map((m, i) => ({
      mes: MES[i],
      generado: sum(S.filter((x) => x.payment_mode === 'cuenta_cobro' && x.fecha_examen.startsWith(m))),
      caja: sum(S.filter((x) => x.payment_mode === 'contado' && x.fecha_examen.startsWith(m))),
      recaudado: sum(Bs.filter((b) => b.status === 'pagada' && String(b.paid_at || '').startsWith(m)), 'total')
    }))
    const aging = [['0–30 días', 0, 30], ['31–60 días', 31, 60], ['61–90 días', 61, 90], ['Más de 90 días', 91, 99999]].map(([name, a, b]) => {
      const list = emitted.filter((x) => { const d = days(x.created_at, t); return d >= a && d <= b })
      return { name, cuentas: list.length, valor: sum(list, 'total') }
    })
    const cuenta = S.filter((x) => x.payment_mode === 'cuenta_cobro'); const caja = S.filter((x) => x.payment_mode === 'contado')
    const recaudoBase = sum(paid, 'total') + sum(emitted, 'total')
    res.send({
      year,
      kpis: {
        pendienteValor: sum(pending), pendienteCount: pending.length,
        porFacturarValor: sum(toInvoice), porFacturarCount: toInvoice.length,
        emitidoValor: sum(emitted, 'total'), emitidoCount: emitted.length,
        pagadoValor: sum(paid, 'total'), pagadoCount: paid.length,
        recaudo: recaudoBase ? Math.round((sum(paid, 'total') / recaudoBase) * 100) : null,
        promedioDiasPago: avgDays, vencidoValor: sum(overdue, 'total'), vencidoCount: overdue.length,
        descuentosConvenio: sum(cuenta, 'discount_amount') + sum(caja.filter((x) => x.eps_id), 'discount_amount'),
        conveniosVigentes: eps.data.filter((e) => e.has_agreement && (!e.agreement_valid_until || e.agreement_valid_until >= t)).length
      },
      mix: [{ name: 'Cuenta de cobro a EPS', servicios: cuenta.length, valor: sum(cuenta) }, { name: 'Pago en caja', servicios: caja.length, valor: sum(caja) }],
      byService: Object.values(S.reduce((acc, x) => {
        const o = acc[x.service_name] = acc[x.service_name] || { name: x.service_name, servicios: 0, valor: 0, cuentaCobro: 0, caja: 0 }
        o.servicios += 1; o.valor += Number(x.valor || 0); if (x.payment_mode === 'cuenta_cobro') o.cuentaCobro += Number(x.valor || 0); else o.caja += Number(x.valor || 0)
        return acc
      }, {})).sort((a, b) => b.valor - a.valor),
      byEps: Object.values(byEpsMap).sort((a, b) => (b.pendiente + b.cobrado + b.pagado) - (a.pendiente + a.cobrado + a.pagado)),
      byMonth, aging,
      overdue: overdue.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 10).map((b) => ({ id: b.id, code: b.code, eps: epsName(b.eps_id), total: Number(b.total), dias: days(b.created_at, t) }))
    })
  }))
  app.get('/facturacion/cuentas-cobro/:id', auth(STAFF), hx(async (req, res) => {
    const b = await loadBill(req)
    const { data: rows, error } = await supabase.from('service_charges').select(CHARGE_SELECT).eq('billing_id', b.id).order('service_date')
    if (error) throw error
    res.send({ ...billDTO(b), billingContact: b.eps?.billing_contact ?? null, billingEmail: b.eps?.billing_email ?? null, rows: rows.map(chargeDTO) })
  }))
  // Marcar pagada o anular (al anular, los servicios vuelven a quedar pendientes).
  app.put('/facturacion/cuentas-cobro/:id', auth(STAFF), hx(async (req, res) => {
    const b = await loadBill(req)
    const status = req.body?.status
    if (!['pagada', 'anulada', 'emitida'].includes(status)) return fail(res, 'Estado inválido', 400)
    if (status === 'anulada' && req.user.role !== 'administrador') return fail(res, 'Solo el administrador puede anular una cuenta de cobro', 403)
    const paidAt = status === 'pagada' ? (ISO_DATE.test(req.body?.paidAt || '') ? req.body.paidAt : today()) : null
    const { error } = await supabase.from('eps_billings').update({ status, paid_at: paidAt }).eq('id', b.id)
    if (error) throw error
    const patch = status === 'pagada' ? { billing_status: 'pagada' } : status === 'anulada' ? { billing_status: 'pendiente', billing_id: null } : { billing_status: 'cobrada' }
    await syncSources((q) => q.eq('billing_id', b.id), patch)
    const { error: e2 } = await supabase.from('service_charges').update(patch).eq('billing_id', b.id)
    if (e2) throw e2
    res.send({ ok: true })
  }))

  return { resolveBilling, recordCharge, takeInvoice, linkInvoice, createInvoice, getCharge, loadTax, FORM_SERVICES }
}
