// =====================================================================
// Inventario institucional (Resolución 3100 de 2019)
// Catálogo de productos por categoría (medicamentos, dispositivos médicos,
// reactivos, equipos operacionales y no operacionales), bodega general
// (Seccional) y una bodega por unidad municipal o grupo de apoyo.
// Solo el administrador ingresa al inventario (siempre en la bodega general)
// y traslada a las demás bodegas. Cada bodega entrega a sus servicios de IPS,
// Educación y Socorro; los eventos consumen de la bodega de su sede.
// Lo que sale de una bodega de unidad o grupo no regresa a la bodega general.
// =====================================================================
const { pageQuery, setTotal } = require('./paging')
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, STAFF, ISO_DATE, TZ_OFFSET, todayBogota, scopeSite, canAccessSite } = deps

  const CATEGORIES = {
    medicamento: 'Medicamentos',
    dispositivo_medico: 'Dispositivos médicos',
    reactivo: 'Reactivos de diagnóstico in vitro',
    operacional: 'Equipos operacionales',
    no_operacional: 'Equipos no operacionales'
  }
  const CONSUMABLE = ['medicamento', 'dispositivo_medico', 'reactivo']
  const PREFIX = { medicamento: 'MED', dispositivo_medico: 'DM', reactivo: 'REA', operacional: 'OPE', no_operacional: 'NOP' }
  const UNITS = {
    unidad: 'Unidad', par: 'Par', caja: 'Caja', paquete: 'Paquete', rollo: 'Rollo', frasco: 'Frasco', bolsa: 'Bolsa', sobre: 'Sobre',
    ampolla: 'Ampolla', vial: 'Vial', tableta: 'Tableta', capsula: 'Cápsula', ml: 'Mililitro (ml)', l: 'Litro (L)', cm3: 'Centímetro cúbico (cm³)',
    mg: 'Miligramo (mg)', g: 'Gramo (g)', kg: 'Kilogramo (kg)', kit: 'Kit', prueba: 'Prueba', galon: 'Galón', metro: 'Metro'
  }
  const RISK = { dispositivo_medico: ['I', 'IIa', 'IIb', 'III'], reactivo: ['I', 'II', 'III'] }
  // Campos obligatorios por categoría (además de nombre y unidad de medida).
  const REQUIRED = {
    medicamento: { principio_activo: 'Principio activo', forma_farmaceutica: 'Forma farmacéutica', concentracion: 'Concentración', presentacion_comercial: 'Presentación comercial', registro_invima: 'Registro sanitario INVIMA' },
    dispositivo_medico: { descripcion: 'Descripción', marca: 'Marca', presentacion_comercial: 'Presentación comercial', registro_invima: 'Registro sanitario o permiso INVIMA', clasificacion_riesgo: 'Clasificación de riesgo' },
    reactivo: { marca: 'Marca', presentacion_comercial: 'Presentación comercial', registro_invima: 'Registro sanitario o permiso INVIMA', clasificacion_riesgo: 'Clasificación del riesgo sanitario' },
    operacional: {},
    no_operacional: {}
  }
  const FIELDS = ['principio_activo', 'forma_farmaceutica', 'concentracion', 'descripcion', 'marca', 'serie', 'presentacion_comercial', 'registro_invima', 'clasificacion_riesgo', 'vida_util']
  const EXPIRY_WARN_DAYS = 60
  const MOVE_LABELS = {
    entrada: 'Ingreso a bodega general', traslado_salida: 'Traslado enviado', traslado_entrada: 'Traslado recibido', entrega: 'Entrega a servicio / área',
    consumo: 'Consumo en actividad', salida: 'Salida a actividad', devolucion: 'Regreso de actividad', reverso: 'Reverso', ajuste: 'Ajuste', baja: 'Baja'
  }

  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v))
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => {
    try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e }
  })
  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const fullName = (u) => (u ? `${u.name} ${u.last_name}`.trim() : null)
  const rpcError = (error) => {
    if (/STOCK_INSUFICIENTE|stock_check|23514/.test(`${error.message}${error.code}`)) return httpError(400, 'Stock insuficiente para este elemento')
    if (/MISMA_BODEGA/.test(error.message)) return httpError(400, 'La bodega de origen y destino es la misma')
    if (/CANTIDAD_INVALIDA/.test(error.message)) return httpError(400, 'Cantidad inválida')
    return error
  }

  // ---------------------------------------------------------------- Bodegas (varias por sede; una sola es la general)
  const WH_SELECT = 'id, code, name, description, responsible, location, is_general, active, site_id, site:sites(id, name, type, municipality, active)'
  const loadWarehouses = async () => {
    const { data, error } = await supabase.from('warehouses').select(WH_SELECT).order('is_general', { ascending: false }).order('name')
    if (error) throw error
    return data
  }
  const warehouseById = async (id) => {
    const { data, error } = await supabase.from('warehouses').select(WH_SELECT).eq('id', Number(id)).maybeSingle()
    if (error) throw error
    return data
  }
  const generalWarehouse = async () => {
    const { data, error } = await supabase.from('warehouses').select('id, name, site_id').eq('is_general', true).maybeSingle()
    if (error) throw error
    if (!data) throw httpError(500, 'No hay bodega general configurada')
    return data
  }
  const canUseWarehouse = (req, w) => Boolean(w) && (req.user.role === 'administrador' || w.site_id === req.user.site_id)
  // Qué se consulta: una bodega (?bodega=) o una sede (?sede= del admin; la sede propia para los demás).
  const viewFilter = async (req) => {
    if (Number(req.query.bodega)) {
      const w = await warehouseById(req.query.bodega)
      if (!canUseWarehouse(req, w)) throw httpError(404, 'Bodega no encontrada')
      return { warehouse: w.id, site: w.site_id, warehouseRow: w }
    }
    return { warehouse: null, site: scopeSite(req) }
  }
  const siteForView = (req) => scopeSite(req)
  const warehouseDTO = (w) => w && ({
    id: w.id, code: w.code, name: w.name, description: w.description, responsible: w.responsible, location: w.location,
    isGeneral: w.is_general, active: w.active, siteId: w.site_id, siteName: w.site?.name, siteType: w.site?.type, municipality: w.site?.municipality
  })

  // Destinos de entrega: servicios de IPS habilitados en la sede + Educación + Socorro.
  const destinationsFor = async (siteId) => {
    const { data, error } = await supabase.from('site_services').select('service:ips_services(code, name, active)').eq('site_id', siteId)
    if (error) throw error
    return [
      ...data.map((r) => r.service).filter((x) => x?.active).map((x) => ({ key: `servicio:${x.code}`, label: `IPS · ${x.name}`, group: 'ips' })),
      { key: 'educacion', label: 'Operaciones Generales · Educación', group: 'operaciones' },
      { key: 'socorro', label: 'Operaciones Generales · Socorro', group: 'operaciones' }
    ]
  }
  const destinationLabel = (key, all) => all.find((d) => d.key === key)?.label || key

  // ---------------------------------------------------------------- Productos
  const productDTO = (p) => p && ({
    id: p.id, code: p.code, name: p.name, category: p.category, categoryLabel: CATEGORIES[p.category], unit: p.unit, unitLabel: UNITS[p.unit],
    principioActivo: p.principio_activo, formaFarmaceutica: p.forma_farmaceutica, concentracion: p.concentracion,
    descripcion: p.descripcion, marca: p.marca, serie: p.serie, presentacionComercial: p.presentacion_comercial,
    registroInvima: p.registro_invima, clasificacionRiesgo: p.clasificacion_riesgo, vidaUtil: p.vida_util,
    minStock: Number(p.min_stock), minStockGeneral: Number(p.min_stock_general), notes: p.notes, active: p.active,
    consumable: CONSUMABLE.includes(p.category)
  })
  const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

  const validateProduct = (b) => {
    const e = []
    if (!CATEGORIES[b.category]) return { errors: ['Selecciona la categoría'] }
    if (!clean(b.name)) e.push(b.category === 'reactivo' ? 'El nombre del reactivo es requerido' : 'El nombre es requerido')
    if (!UNITS[b.unit]) e.push('Selecciona la unidad de medida de la lista')
    const row = {}
    for (const f of FIELDS) row[f] = clean(b[camel(f)])
    for (const [f, label] of Object.entries(REQUIRED[b.category])) if (!row[f]) e.push(`${label} es obligatorio`)
    if (RISK[b.category] && row.clasificacion_riesgo && !RISK[b.category].includes(row.clasificacion_riesgo)) e.push('Clasificación de riesgo inválida')
    if (!RISK[b.category]) row.clasificacion_riesgo = null
    if (b.category !== 'medicamento') { row.principio_activo = null; row.forma_farmaceutica = null; row.concentracion = null }
    const min = num(b.minStock); const minG = num(b.minStockGeneral)
    if (Number.isNaN(min) || min < 0) e.push('Stock mínimo por bodega inválido')
    if (Number.isNaN(minG) || minG < 0) e.push('Stock mínimo de la bodega general inválido')
    return {
      errors: e,
      row: { ...row, name: clean(b.name), category: b.category, unit: b.unit, min_stock: min, min_stock_general: minG, notes: clean(b.notes), active: b.active !== false, updated_at: new Date().toISOString() }
    }
  }
  const nextCode = async (category) => {
    const prefix = PREFIX[category]
    const { data } = await supabase.from('inventory_products').select('code').ilike('code', `${prefix}-%`)
    const max = (data || []).reduce((m, r) => Math.max(m, Number(r.code.split('-')[1]) || 0), 0)
    return `${prefix}-${String(max + 1).padStart(3, '0')}`
  }
  // Copia en las líneas de stock los datos que se muestran en eventos y reportes.
  const syncLines = async (p) => {
    const { error } = await supabase.from('inventory_items').update({ code: p.code, name: p.name, category: p.category, unit: p.unit, min_stock: p.min_stock, updated_at: new Date().toISOString() }).eq('product_id', p.id)
    if (error) throw error
  }

  app.get('/inventario/catalogos', auth(STAFF), hx(async (req, res) => {
    const v = await viewFilter(req)
    const site = v.site
    res.send({
      categories: CATEGORIES, consumable: CONSUMABLE, units: UNITS, risk: RISK,
      required: Object.fromEntries(Object.entries(REQUIRED).map(([k, v]) => [k, Object.keys(v).map(camel)])),
      moveLabels: MOVE_LABELS, expiryWarnDays: EXPIRY_WARN_DAYS,
      destinations: await destinationsFor(site || (await generalWarehouse()).site_id)
    })
  }))

  app.get('/inventario/productos', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('inventory_products').select('*').order('category').order('name')
    if (CATEGORIES[req.query.categoria]) q = q.eq('category', req.query.categoria)
    const { data, error } = await q
    if (error) throw error
    const { data: lines, error: e2 } = await supabase.from('inventory_items').select('product_id, stock, site_id')
    if (e2) throw e2
    const site = siteForView(req)
    res.send(data.map((p) => {
      const ls = lines.filter((l) => l.product_id === p.id && (!site || l.site_id === site))
      return { ...productDTO(p), stock: ls.reduce((a, l) => a + Number(l.stock), 0) }
    }))
  }))

  app.post('/inventario/productos', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const { errors, row } = validateProduct(b)
    if (errors.length) return fail(res, errors.join('. '), 400)
    const code = clean(b.code)?.toUpperCase() || await nextCode(b.category)
    const { data, error } = await supabase.from('inventory_products').insert({ ...row, code }).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un producto con ese código', 409); throw error }
    res.status(201).send({ ...productDTO(data), stock: 0 })
  }))

  app.put('/inventario/productos/:id', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const { errors, row } = validateProduct(b)
    if (errors.length) return fail(res, errors.join('. '), 400)
    const id = Number(req.params.id)
    const { data: cur } = await supabase.from('inventory_products').select('category, code').eq('id', id).maybeSingle()
    if (!cur) return fail(res, 'Producto no encontrado', 404)
    // La categoría solo cambia entre consumibles o entre equipos, para no romper eventos registrados.
    if (CONSUMABLE.includes(cur.category) !== CONSUMABLE.includes(row.category)) {
      const { count } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('product_id', id)
      if (count) return fail(res, 'No se puede cambiar un insumo a equipo (o al revés) cuando ya tiene existencias', 400)
    }
    const code = clean(b.code)?.toUpperCase() || cur.code
    const { data, error } = await supabase.from('inventory_products').update({ ...row, code }).eq('id', id).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un producto con ese código', 409); throw error }
    await syncLines(data)
    res.send(productDTO(data))
  }))

  app.delete('/inventario/productos/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('product_id', id)
    if (count) return fail(res, 'El producto ya tiene movimientos en bodegas. Desactívalo en lugar de eliminarlo.', 409)
    const { error } = await supabase.from('inventory_products').delete().eq('id', id)
    if (error) throw error
    res.send({ message: 'Producto eliminado' })
  }))

  // ---------------------------------------------------------------- Existencias
  const LINE_SELECT = 'id, stock, lot, expiry_date, site_id, warehouse_id, product_id, active, product:inventory_products(*), site:sites(id, name, type), warehouse:warehouses(id, code, name, is_general)'
  const lineDTO = (l) => {
    const p = l.product
    const wh = l.warehouse
    const days = l.expiry_date ? daysUntil(l.expiry_date) : null
    const min = wh?.is_general ? Number(p.min_stock_general) : Number(p.min_stock)
    return {
      id: l.id, stock: Number(l.stock), lot: l.lot, expiryDate: l.expiry_date, daysToExpiry: days,
      expired: days !== null && days < 0, expiringSoon: days !== null && days >= 0 && days <= EXPIRY_WARN_DAYS,
      siteId: l.site_id, siteName: l.site?.name, siteType: l.site?.type, warehouseId: l.warehouse_id, warehouseCode: wh?.code ?? null, warehouseName: wh?.name ?? null, isGeneral: Boolean(wh?.is_general),
      minStock: min, product: productDTO(p)
    }
  }
  const loadLines = async ({ site, warehouse, category, productId, withEmpty } = {}) => {
    let q = supabase.from('inventory_items').select(LINE_SELECT)
    if (warehouse) q = q.eq('warehouse_id', warehouse)
    else if (site) q = q.eq('site_id', site)
    if (CATEGORIES[category]) q = q.eq('category', category)
    if (productId) q = q.eq('product_id', productId)
    if (!withEmpty) q = q.gt('stock', 0)
    const { data, error } = await q.order('name').order('expiry_date', { nullsFirst: false })
    if (error) throw error
    return data.map(lineDTO)
  }
  // Agrupa líneas (lotes) por bodega y producto, para alertas de stock bajo (solo productos que la bodega ha manejado).
  const groupByProduct = (lines, warehouses, products, known) => {
    const out = []
    for (const w of warehouses) {
      for (const p of products) {
        if (!p.active || !known.has(`${w.id}:${p.id}`)) continue
        const ls = lines.filter((l) => l.warehouseId === w.id && l.product.id === p.id)
        const stock = ls.reduce((a, l) => a + l.stock, 0)
        const min = w.is_general ? Number(p.min_stock_general) : Number(p.min_stock)
        out.push({ warehouseId: w.id, siteId: w.site_id, warehouseName: w.name, isGeneral: w.is_general, product: productDTO(p), stock, minStock: min, low: min > 0 && stock <= min, lots: ls.length })
      }
    }
    return out
  }
  const sum = (arr) => arr.reduce((a, l) => a + l.stock, 0)

  app.get('/inventario/bodegas', auth(STAFF), hx(async (req, res) => {
    const [whs, lines] = await Promise.all([loadWarehouses(), loadLines({})])
    let visible = req.user.role === 'administrador' ? whs : whs.filter((w) => w.site_id === req.user.site_id)
    if (req.query.todas !== '1' && req.user.role !== 'administrador') visible = visible.filter((w) => w.active)
    res.send(visible.map((w) => {
      const ls = lines.filter((l) => l.warehouseId === w.id)
      return {
        ...warehouseDTO(w),
        lines: ls.length, products: new Set(ls.map((l) => l.product.id)).size, units: sum(ls),
        expired: ls.filter((l) => l.expired).length, expiringSoon: ls.filter((l) => l.expiringSoon).length,
        byCategory: Object.keys(CATEGORIES).map((c) => ({ key: c, units: sum(ls.filter((l) => l.product.category === c)), lines: ls.filter((l) => l.product.category === c).length }))
      }
    }))
  }))

  // CRUD de bodegas (solo admin)
  const validateWarehouse = async (b, id) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre de la bodega es requerido')
    const { data: site } = await supabase.from('sites').select('id, type').eq('id', Number(b.siteId)).maybeSingle()
    if (!site) e.push('Selecciona la sede a la que pertenece la bodega')
    if (b.isGeneral && site && site.type !== 'seccional') e.push('La bodega general debe pertenecer a una seccional')
    if (id && b.active === false) {
      const { data: w } = await supabase.from('warehouses').select('is_general').eq('id', id).maybeSingle()
      if (w?.is_general) e.push('La bodega general no se puede desactivar')
      const { count } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('warehouse_id', id).gt('stock', 0)
      if (count) e.push('La bodega tiene existencias; trasládalas o dalas de baja antes de desactivarla')
    }
    return { errors: e, row: { name: clean(b.name), site_id: Number(b.siteId), description: clean(b.description), responsible: clean(b.responsible), location: clean(b.location), active: b.active !== false, updated_at: new Date().toISOString() } }
  }
  app.post('/inventario/bodegas', auth(ADMIN), hx(async (req, res) => {
    const { errors, row } = await validateWarehouse(req.body || {})
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { data, error } = await supabase.from('warehouses').insert({ ...row, is_general: false }).select(WH_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una bodega con ese nombre', 409); throw error }
    res.status(201).send(warehouseDTO(data))
  }))
  app.put('/inventario/bodegas/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const cur = await warehouseById(id)
    if (!cur) return fail(res, 'Bodega no encontrada', 404)
    const { errors, row } = await validateWarehouse(req.body || {}, id)
    if (row.site_id !== cur.site_id) {
      if (cur.is_general) errors.push('La bodega general no cambia de sede')
      const { count } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('warehouse_id', id).gt('stock', 0)
      if (count) errors.push('Solo se puede cambiar de sede una bodega sin existencias')
    }
    if (errors.length) return fail(res, errors.join('. '), 400)
    const { data, error } = await supabase.from('warehouses').update(row).eq('id', id).select(WH_SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe una bodega con ese nombre', 409); throw error }
    await supabase.from('inventory_items').update({ site_id: row.site_id }).eq('warehouse_id', id)
    res.send(warehouseDTO(data))
  }))
  app.delete('/inventario/bodegas/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const cur = await warehouseById(id)
    if (!cur) return fail(res, 'Bodega no encontrada', 404)
    if (cur.is_general) return fail(res, 'La bodega general no se puede eliminar', 400)
    const { count } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('warehouse_id', id)
    if (count) return fail(res, 'La bodega ya tiene movimientos. Desactívala en lugar de eliminarla.', 409)
    const { error } = await supabase.from('warehouses').delete().eq('id', id)
    if (error) throw error
    res.send({ message: 'Bodega eliminada' })
  }))

  app.get('/inventario/stock', auth(STAFF), hx(async (req, res) => {
    const v = await viewFilter(req)
    let lines = await loadLines({ site: v.site, warehouse: v.warehouse, category: req.query.categoria, productId: Number(req.query.producto) || null })
    const q = clean(req.query.q)?.toLowerCase()
    if (q) lines = lines.filter((l) => [l.product.name, l.product.code, l.lot, l.product.principioActivo, l.product.marca, l.product.registroInvima].some((x) => x && x.toLowerCase().includes(q)))
    if (req.query.vencimiento === 'vencidos') lines = lines.filter((l) => l.expired)
    if (req.query.vencimiento === 'proximos') lines = lines.filter((l) => l.expiringSoon)
    res.send(lines)
  }))

  // ---------------------------------------------------------------- Ingreso a bodega general (solo admin)
  app.post('/inventario/entradas', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const { data: p } = await supabase.from('inventory_products').select('*').eq('id', Number(b.productId)).maybeSingle()
    if (!p || !p.active) return fail(res, 'Selecciona un producto activo del catálogo', 400)
    const qty = num(b.quantity)
    if (Number.isNaN(qty) || qty <= 0) return fail(res, 'Cantidad inválida', 400)
    const consumable = CONSUMABLE.includes(p.category)
    const lot = clean(b.lot)?.toUpperCase() ?? null
    const expiry = clean(b.expiryDate)
    if (consumable && !lot) return fail(res, 'El lote es obligatorio', 400)
    if (consumable && !expiry) return fail(res, 'La fecha de vencimiento es obligatoria', 400)
    if (expiry && !ISO_DATE.test(expiry)) return fail(res, 'Fecha de vencimiento inválida', 400)
    if (expiry && daysUntil(expiry) < 0) return fail(res, 'No se puede ingresar un lote vencido', 400)
    const general = await generalWarehouse()
    let { data: line } = await supabase.from('inventory_items').select('id, expiry_date').eq('warehouse_id', general.id).eq('product_id', p.id).filter('lot', lot ? 'eq' : 'is', lot ?? null).maybeSingle()
    if (line && expiry && line.expiry_date && line.expiry_date !== expiry) return fail(res, `El lote ${lot} ya existe con vencimiento ${line.expiry_date}`, 409)
    if (!line) {
      const ins = await supabase.from('inventory_items').insert({
        code: p.code, name: p.name, category: p.category, unit: p.unit, stock: 0, min_stock: p.min_stock, site_id: general.site_id, warehouse_id: general.id, product_id: p.id, lot, expiry_date: expiry
      }).select('id').single()
      if (ins.error) throw ins.error
      line = ins.data
    }
    const note = [clean(b.supplier) && `Proveedor: ${clean(b.supplier)}`, clean(b.invoice) && `Factura: ${clean(b.invoice)}`, clean(b.note)].filter(Boolean).join(' · ') || null
    const { error } = await supabase.rpc('inv_move', { p_item: line.id, p_delta: qty, p_type: 'entrada', p_user: req.user.id, p_note: note, p_destination: null, p_event: null })
    if (error) throw rpcError(error)
    res.status(201).send((await loadLines({ productId: p.id, warehouse: general.id })).find((l) => l.id === line.id))
  }))

  // ---------------------------------------------------------------- Traslados (solo admin)
  // De la bodega general a cualquier otra bodega, o entre bodegas de una misma sede. Nunca de regreso a la general.
  app.post('/inventario/traslados', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const general = await generalWarehouse()
    const from = await warehouseById(Number(b.fromWarehouseId) || general.id)
    const to = await warehouseById(b.toWarehouseId)
    if (!from) return fail(res, 'Bodega de origen inválida', 400)
    if (!to) return fail(res, 'Selecciona la bodega de destino', 400)
    if (to.id === from.id) return fail(res, 'La bodega de origen y destino es la misma', 400)
    if (to.is_general) return fail(res, 'Lo entregado a una unidad o grupo no regresa a la bodega general', 400)
    if (!to.active || (to.site && !to.site.active)) return fail(res, 'La bodega de destino o su sede está inactiva', 400)
    if (!from.is_general && from.site_id !== to.site_id) return fail(res, 'Desde una bodega de unidad o grupo solo se traslada a otra bodega de la misma sede', 400)
    const items = (b.items || []).map((x) => ({ itemId: Number(x.itemId), quantity: num(x.quantity) })).filter((x) => x.itemId)
    if (!items.length) return fail(res, 'Agrega al menos un elemento al traslado', 400)
    if (new Set(items.map((x) => x.itemId)).size !== items.length) return fail(res, 'Hay elementos repetidos en el traslado', 400)
    const { data: src, error } = await supabase.from('inventory_items').select('id, warehouse_id, stock, name, lot, expiry_date').in('id', items.map((x) => x.itemId))
    if (error) throw error
    for (const it of items) {
      const s = src.find((x) => x.id === it.itemId)
      if (!s || s.warehouse_id !== from.id) return fail(res, `Los elementos deben estar en ${from.name}`, 400)
      if (Number.isNaN(it.quantity) || it.quantity <= 0) return fail(res, `Cantidad inválida para ${s.name}`, 400)
      if (it.quantity > Number(s.stock)) return fail(res, `Stock insuficiente de ${s.name}${s.lot ? ` (lote ${s.lot})` : ''}: hay ${Number(s.stock)}`, 400)
      if (s.expiry_date && daysUntil(s.expiry_date) < 0) return fail(res, `${s.name} (lote ${s.lot}) está vencido; no se puede trasladar`, 400)
    }
    const { data: ref } = await supabase.rpc('inv_next_transfer')
    const note = clean(b.note)
    for (const it of items) {
      const { error: e } = await supabase.rpc('inv_transfer', { p_item: it.itemId, p_to_warehouse: to.id, p_qty: it.quantity, p_user: req.user.id, p_note: note, p_ref: ref })
      if (e) throw rpcError(e)
    }
    res.status(201).send({ ref, toWarehouseId: to.id, warehouseName: to.name, items: items.length })
  }))

  // ---------------------------------------------------------------- Entregas semanales a servicios de IPS, Educación o Socorro
  app.post('/inventario/entregas', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const w = await warehouseById(b.warehouseId)
    if (!canUseWarehouse(req, w) || !w.active) return fail(res, 'Selecciona la bodega que entrega', 400)
    const dests = await destinationsFor(w.site_id)
    if (!dests.some((d) => d.key === b.destination)) return fail(res, 'Selecciona el servicio o área que recibe', 400)
    const receiver = clean(b.receivedBy)
    if (!receiver) return fail(res, 'Indica quién recibe la entrega', 400)
    const items = (b.items || []).map((x) => ({ itemId: Number(x.itemId), quantity: num(x.quantity) })).filter((x) => x.itemId)
    if (!items.length) return fail(res, 'Agrega al menos un elemento a la entrega', 400)
    if (new Set(items.map((x) => x.itemId)).size !== items.length) return fail(res, 'Hay elementos repetidos en la entrega', 400)
    const { data: src, error } = await supabase.from('inventory_items').select('id, warehouse_id, stock, name, lot, expiry_date').in('id', items.map((x) => x.itemId))
    if (error) throw error
    for (const it of items) {
      const s = src.find((x) => x.id === it.itemId)
      if (!s || s.warehouse_id !== w.id) return fail(res, `Los elementos deben estar en ${w.name}`, 400)
      if (Number.isNaN(it.quantity) || it.quantity <= 0) return fail(res, `Cantidad inválida para ${s.name}`, 400)
      if (it.quantity > Number(s.stock)) return fail(res, `Stock insuficiente de ${s.name}${s.lot ? ` (lote ${s.lot})` : ''}: hay ${Number(s.stock)}`, 400)
      if (s.expiry_date && daysUntil(s.expiry_date) < 0) return fail(res, `${s.name} (lote ${s.lot}) está vencido; dalo de baja en lugar de entregarlo`, 400)
    }
    const { data: ref } = await supabase.rpc('inv_next_transfer')
    const note = [`Recibe: ${receiver}`, clean(b.note)].filter(Boolean).join(' · ')
    for (const it of items) {
      const { error: e } = await supabase.rpc('inv_move', { p_item: it.itemId, p_delta: -it.quantity, p_type: 'entrega', p_user: req.user.id, p_note: note, p_destination: b.destination, p_event: null, p_ref: ref })
      if (e) throw rpcError(e)
    }
    res.status(201).send({ ref, destination: destinationLabel(b.destination, dests), items: items.length })
  }))

  // ---------------------------------------------------------------- Bajas (vencidos, averiados, pérdidas) y ajustes: solo admin
  app.post('/inventario/bajas', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const type = b.type === 'ajuste' ? 'ajuste' : 'baja'
    const qty = num(b.quantity)
    const reason = clean(b.reason)
    if (!reason) return fail(res, 'Indica el motivo', 400)
    if (Number.isNaN(qty) || qty === 0 || (type === 'baja' && qty < 0)) return fail(res, 'Cantidad inválida', 400)
    const { data: line } = await supabase.from('inventory_items').select('id').eq('id', Number(b.itemId)).maybeSingle()
    if (!line) return fail(res, 'Elemento no encontrado', 404)
    const { error } = await supabase.rpc('inv_move', { p_item: line.id, p_delta: type === 'baja' ? -qty : qty, p_type: type, p_user: req.user.id, p_note: reason, p_destination: null, p_event: null })
    if (error) throw rpcError(error)
    res.status(201).send({ message: type === 'baja' ? 'Baja registrada' : 'Ajuste registrado' })
  }))

  // ---------------------------------------------------------------- Kárdex
  const movementDTO = (m, dests) => ({
    id: m.id, type: m.type, typeLabel: MOVE_LABELS[m.type] || m.type, quantity: Number(m.quantity), stockAfter: Number(m.stock_after),
    note: m.note, createdAt: m.created_at, ref: m.transfer_ref, destination: m.destination, destinationLabel: m.destination ? destinationLabel(m.destination, dests) : null,
    user: fullName(m.users), counterpart: m.counterpart?.name ?? null,
    event: m.gso_events ? { id: m.gso_events.id, code: m.gso_events.code, name: m.gso_events.name } : null,
    item: m.item ? { id: m.item.id, name: m.item.name, code: m.item.code, category: m.item.category, unit: m.item.unit, lot: m.item.lot, siteId: m.item.site_id, siteName: m.item.site?.name, warehouseId: m.item.warehouse_id, warehouseName: m.item.warehouse?.name } : null
  })
  const allDestinations = async () => {
    const { data } = await supabase.from('ips_services').select('code, name')
    return [...(data || []).map((x) => ({ key: `servicio:${x.code}`, label: `IPS · ${x.name}` })), { key: 'educacion', label: 'Operaciones Generales · Educación' }, { key: 'socorro', label: 'Operaciones Generales · Socorro' }]
  }

  app.get('/inventario/movimientos', auth(STAFF), hx(async (req, res) => {
    const v = await viewFilter(req)
    const desde = clean(req.query.desde); const hasta = clean(req.query.hasta)
    if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
    let q = supabase.from('inventory_movements')
      .select('id, type, quantity, stock_after, note, created_at, transfer_ref, destination, users(name, last_name), counterpart:warehouses!inventory_movements_counterpart_warehouse_id_fkey(name), gso_events(id, code, name), item:inventory_items!inner(id, name, code, category, unit, lot, site_id, warehouse_id, product_id, site:sites(name), warehouse:warehouses(name))', { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: false })
    if (v.warehouse) q = q.eq('item.warehouse_id', v.warehouse)
    else if (v.site) q = q.eq('item.site_id', v.site)
    if (Number(req.query.item)) q = q.eq('item_id', Number(req.query.item))
    if (Number(req.query.producto)) q = q.eq('item.product_id', Number(req.query.producto))
    if (CATEGORIES[req.query.categoria]) q = q.eq('item.category', req.query.categoria)
    if (MOVE_LABELS[req.query.tipo]) q = q.eq('type', req.query.tipo)
    if (desde) q = q.gte('created_at', `${desde}T00:00:00${TZ_OFFSET}`)
    if (hasta) q = q.lte('created_at', `${hasta}T23:59:59${TZ_OFFSET}`)
    const { data, error, count } = await pageQuery(req, q, Math.min(Number(req.query.limite) || 300, 1000))
    if (error) throw error
    setTotal(res, count)
    const dests = await allDestinations()
    res.send(data.map((m) => movementDTO(m, dests)))
  }))

  // ---------------------------------------------------------------- Resumen (dashboard de inventario y reportes)
  app.get('/inventario/resumen', auth(STAFF), hx(async (req, res) => {
    const v = await viewFilter(req)
    if (v.site && !canAccessSite(req, v.site)) return fail(res, 'Sin acceso', 403)
    const today = todayBogota()
    const monthStart = `${today.slice(0, 7)}-01`
    const [whs, lines, prods, moves, carried] = await Promise.all([
      loadWarehouses(),
      loadLines({ site: v.site, warehouse: v.warehouse }),
      supabase.from('inventory_products').select('*'),
      supabase.from('inventory_movements').select('type, quantity, destination, created_at, item:inventory_items!inner(site_id, warehouse_id, category)')
        .gte('created_at', `${monthStart}T00:00:00${TZ_OFFSET}`),
      supabase.from('inventory_items').select('warehouse_id, product_id')
    ])
    for (const r of [prods, moves, carried]) if (r.error) throw r.error
    const products = prods.data
    const inScope = (siteId, whId) => (v.warehouse ? whId === v.warehouse : !v.site || siteId === v.site)
    const monthMoves = moves.data.filter((m) => inScope(m.item.site_id, m.item.warehouse_id))
    const known = new Set(carried.data.map((r) => `${r.warehouse_id}:${r.product_id}`))
    const visibleWh = whs.filter((w) => inScope(w.site_id, w.id) && (w.active || lines.some((l) => l.warehouseId === w.id)))
    const perProduct = groupByProduct(lines, visibleWh, products, known)
    const dests = await allDestinations()
    const deliveries = {}
    for (const m of monthMoves.filter((x) => x.type === 'entrega' || x.type === 'consumo')) {
      const key = m.type === 'consumo' ? 'actividades' : m.destination
      const label = m.type === 'consumo' ? 'Actividades (eventos)' : destinationLabel(m.destination, dests)
      deliveries[key] = deliveries[key] || { key, label, units: 0 }
      deliveries[key].units += -Number(m.quantity)
    }
    res.send({
      site: v.site, warehouse: v.warehouseRow ? warehouseDTO(v.warehouseRow) : null,
      kpis: {
        products: products.filter((p) => p.active).length,
        lines: lines.length,
        units: sum(lines),
        expired: lines.filter((l) => l.expired).length,
        expiringSoon: lines.filter((l) => l.expiringSoon).length,
        low: perProduct.filter((x) => x.low).length,
        monthIn: monthMoves.filter((m) => m.type === 'entrada' || m.type === 'traslado_entrada').reduce((a, m) => a + Number(m.quantity), 0),
        monthOut: monthMoves.filter((m) => ['entrega', 'consumo', 'baja'].includes(m.type)).reduce((a, m) => a - Number(m.quantity), 0),
        monthTransfers: monthMoves.filter((m) => m.type === 'traslado_salida').reduce((a, m) => a - Number(m.quantity), 0)
      },
      byCategory: Object.entries(CATEGORIES).map(([k, label]) => {
        const ls = lines.filter((l) => l.product.category === k)
        return { key: k, name: label, units: sum(ls), lines: ls.length, products: new Set(ls.map((l) => l.product.id)).size }
      }),
      byWarehouse: visibleWh.map((w) => {
        const ls = lines.filter((l) => l.warehouseId === w.id)
        return {
          warehouseId: w.id, siteId: w.site_id, code: w.code, name: w.name, siteName: w.site?.name, isGeneral: w.is_general, active: w.active, units: sum(ls), lines: ls.length,
          low: perProduct.filter((x) => x.warehouseId === w.id && x.low).length,
          expired: ls.filter((l) => l.expired).length, expiringSoon: ls.filter((l) => l.expiringSoon).length,
          byCategory: Object.keys(CATEGORIES).map((c) => ({ key: c, units: sum(ls.filter((l) => l.product.category === c)) }))
        }
      }),
      deliveries: Object.values(deliveries).sort((a, b) => b.units - a.units),
      expiring: lines.filter((l) => l.expired || l.expiringSoon).sort((a, b) => a.daysToExpiry - b.daysToExpiry).slice(0, 30),
      lowStock: perProduct.filter((x) => x.low).sort((a, b) => a.stock / (a.minStock || 1) - b.stock / (b.minStock || 1)).slice(0, 30)
    })
  }))
}
