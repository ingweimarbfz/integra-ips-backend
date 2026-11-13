// =====================================================================
// Búsqueda global rápida: busca en los módulos que el usuario tiene habilitados
// (respetando su sede). Ignora tildes y mayúsculas, y exige todas las palabras.
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, userModules, scopeSite } = deps
  const STAFF = ['administrador', 'empleado']
  // Cada vocal se reemplaza por "_" (comodín de un carácter) para encontrar "Ustáriz" escribiendo "ustariz".
  const pattern = (term) => `%${term.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[%_,()]/g, ' ').trim().replace(/[aeiouAEIOU]/g, '_').replace(/[nN]/g, '_')}%`
  const words = (q) => q.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 4)
  // Todas las palabras deben aparecer en alguno de los campos.
  const match = (query, fields, terms) => terms.reduce((q, t) => q.or(fields.map((f) => `${f}.ilike.${pattern(t)}`).join(',')), query)
  const STD_ROUTE = { procesos_prioritarios: 'procesos-prioritarios', interdependencia: 'interdependencia/documentos', medicamentos: 'medicamentos', infraestructura: 'infraestructura/documentos', historia_clinica: 'historia-clinica/documentos' }

  app.get('/buscar', auth(['administrador', 'empleado', 'voluntario', 'conductor']), h(async (req, res) => {
    const q = clean(req.query.q) || ''
    const terms = words(q)
    if (!terms.length) return res.send({ q, groups: [] })
    const mods = userModules(req.user)
    const has = (m) => mods.includes(m)
    const staff = STAFF.includes(req.user.role)
    const site = scopeSite(req)
    const scoped = (query, col = 'site_id') => (site ? query.eq(col, site) : query)
    const L = 6
    const jobs = []
    const add = (key, label, promise, map) => jobs.push(promise.then(({ data }) => ({ key, label, items: (data || []).map(map) })).catch(() => ({ key, label, items: [] })))

    if (staff && has('citologias')) {
      add('citologias', 'Citologías', match(scoped(supabase.from('cytology_samples').select('id, nombre, apellidos, num_documento, num_factura, fecha_examen')), ['nombre', 'apellidos', 'num_documento', 'num_factura'], terms).order('fecha_examen', { ascending: false }).limit(L),
        (r) => ({ title: `${r.nombre || ''} ${r.apellidos || ''}`.trim(), subtitle: `Citología ${r.num_factura || r.id} · CC ${r.num_documento || '—'} · ${r.fecha_examen || ''}`, to: `/citologias/${r.id}` }))
    }
    if (staff && has('talento_humano')) {
      add('talento', 'Talento humano', match(scoped(supabase.from('th_staff').select('id, first_name, last_name, document, profession, position:th_positions(name)')), ['first_name', 'last_name', 'document', 'profession'], terms).limit(L),
        (r) => ({ title: `${r.first_name} ${r.last_name}`, subtitle: `CC ${r.document} · ${r.position?.name || r.profession || 'Sin cargo'}`, to: `/estandares/talento-humano/personal/${r.id}` }))
    }
    if (staff && has('equipos')) {
      add('equipos', 'Equipos', match(scoped(supabase.from('equipment').select('id, code, name, brand, serial, area')), ['code', 'name', 'brand', 'serial', 'area'], terms).limit(L),
        (r) => ({ title: `${r.code} · ${r.name}`, subtitle: [r.brand, r.serial && `S/N ${r.serial}`, r.area].filter(Boolean).join(' · '), to: `/equipos/${r.id}` }))
    }
    if (staff && has('personas')) {
      add('voluntarios', 'Personas / voluntarios', match(scoped(supabase.from('volunteers').select('id, first_name, last_name, document, carnet, agrupacion')), ['first_name', 'last_name', 'document', 'carnet'], terms).limit(L),
        (r) => ({ title: `${r.first_name} ${r.last_name}`, subtitle: `${r.carnet || ''} · CC ${r.document}${r.agrupacion ? ` · ${r.agrupacion}` : ''}`, to: `/socorro/personas?q=${encodeURIComponent(r.document)}` }))
    }
    if (has('socorro') || has('educacion')) {
      add('eventos', 'Eventos y actividades', match(scoped(supabase.from('gso_events').select('id, code, name, place, area, status')), ['code', 'name', 'place'], terms).order('started_at', { ascending: false }).limit(L),
        (r) => ({ title: `${r.code} · ${r.name}`, subtitle: `${r.area === 'educacion' ? 'Educación' : 'Socorro'} · ${r.place || ''} · ${r.status}`, to: `/socorro/${r.area === 'educacion' ? 'educacion' : 'eventos'}/${r.id}` }))
    }
    if (has('flota')) {
      add('vehiculos', 'Vehículos', match(supabase.from('vehicles').select('id, movil, plate, vehicle_type, brand, line'), ['plate', 'brand', 'line', 'vehicle_type'], terms).limit(L),
        (r) => ({ title: `Móvil ${r.movil} · ${r.plate}`, subtitle: [r.vehicle_type, r.brand, r.line].filter(Boolean).join(' · '), to: `/socorro/vehiculos/flota/${r.id}` }))
    }
    if (staff && has('inventario')) {
      add('productos', 'Inventario', match(supabase.from('inventory_products').select('id, code, name, category, principio_activo, registro_invima'), ['code', 'name', 'principio_activo', 'registro_invima'], terms).eq('active', true).limit(L),
        (r) => ({ title: `${r.code} · ${r.name}`, subtitle: [r.principio_activo, r.registro_invima && `INVIMA ${r.registro_invima}`].filter(Boolean).join(' · ') || r.category, to: `/socorro/inventario/existencias?q=${encodeURIComponent(r.code)}` }))
    }
    const stds = Object.keys(STD_ROUTE).filter(has)
    if (staff && stds.length) {
      let dq = match(supabase.from('std_documents').select('id, standard, name, code, category, site_id'), ['name', 'code', 'category', 'observations', 'file_name'], terms).in('standard', stds)
      if (site) dq = dq.or(`site_id.is.null,site_id.eq.${site}`)
      add('documentos', 'Documentos de estándares', dq.limit(L),
        (r) => ({ title: r.name, subtitle: [r.code, r.category].filter(Boolean).join(' · ') || 'Documento', to: `/estandares/${STD_ROUTE[r.standard]}` }))
    }
    if (req.user.role === 'administrador') {
      add('usuarios', 'Usuarios', match(supabase.from('users').select('id, name, last_name, username, identification, role'), ['name', 'last_name', 'username', 'identification'], terms).limit(L),
        (r) => ({ title: `${r.name} ${r.last_name}`, subtitle: `@${r.username} · ${r.role}`, to: '/usuarios' }))
    }
    const groups = (await Promise.all(jobs)).filter((g) => g.items.length)
    res.send({ q, groups })
  }))
}
