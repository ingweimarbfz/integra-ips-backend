// =====================================================================
// Cadena de frío → proveedores de los equipos que conservan la cadena de frío
// (neveras, congeladores, aires). Si la temperatura supera el límite, el dashboard
// muestra a quién llamar con los datos de contacto del proveedor.
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, scopeSite, canAccessSite } = deps
  const STAFF = ['administrador', 'empleado']
  const COLD_CATEGORIES = ['refrigeracion', 'climatizacion', 'electrico']
  const SERVICES = { mantenimiento: 'Mantenimiento y reparación', garantia: 'Garantía del fabricante', soporte: 'Soporte técnico 24/7', calibracion: 'Calibración y metrología' }
  const SELECT = 'id, service, notes, active, equipment:equipment(id, code, name, category, brand, model, serial, site_id, site:sites(name)), entity:ips_entities(id, name, nit, contact_name, phone, email, address, city, active)'
  const dto = (r) => ({
    id: r.id, service: r.service, serviceLabel: SERVICES[r.service] || r.service, notes: r.notes, active: r.active,
    equipment: r.equipment ? { id: r.equipment.id, code: r.equipment.code, name: r.equipment.name, category: r.equipment.category, brand: r.equipment.brand, model: r.equipment.model, serial: r.equipment.serial, siteId: r.equipment.site_id, siteName: r.equipment.site?.name ?? null } : null,
    provider: r.entity ? { id: r.entity.id, name: r.entity.name, nit: r.entity.nit, contactName: r.entity.contact_name, phone: r.entity.phone, email: r.entity.email, address: r.entity.address, city: r.entity.city, active: r.entity.active } : null
  })
  const list = async (site) => {
    const { data, error } = await supabase.from('cold_chain_suppliers').select(SELECT).order('id')
    if (error) throw error
    return data.map(dto).filter((r) => r.equipment && (!site || r.equipment.siteId === site))
  }

  // Equipos de la hoja de vida que conservan la cadena de frío (para asignarles proveedor).
  app.get('/temperatura/equipos-frio', auth(STAFF), h(async (req, res) => {
    let q = supabase.from('equipment').select('id, code, name, category, brand, model, site_id, site:sites(name)').in('category', COLD_CATEGORIES).order('site_id').order('name')
    const site = scopeSite(req)
    if (site) q = q.eq('site_id', site)
    const { data, error } = await q
    if (error) throw error
    res.send({ services: SERVICES, equipment: data.map((e) => ({ id: e.id, code: e.code, name: e.name, category: e.category, brand: e.brand, model: e.model, siteId: e.site_id, siteName: e.site?.name ?? null })) })
  }))
  app.get('/temperatura/proveedores', auth(STAFF), h(async (req, res) => res.send(await list(scopeSite(req)))))
  app.post('/temperatura/proveedores', auth(ADMIN), h(async (req, res) => {
    const b = req.body || {}
    const equipmentId = Number(b.equipmentId); const entityId = Number(b.entityId)
    if (!equipmentId || !entityId) return fail(res, 'Elige el equipo y el proveedor', 400)
    if (!SERVICES[b.service || 'mantenimiento']) return fail(res, 'Servicio inválido', 400)
    const [{ data: eq }, { data: en }] = await Promise.all([
      supabase.from('equipment').select('id, site_id, category').eq('id', equipmentId).maybeSingle(),
      supabase.from('ips_entities').select('id, categories').eq('id', entityId).maybeSingle()
    ])
    if (!eq || !COLD_CATEGORIES.includes(eq.category)) return fail(res, 'El equipo no es de cadena de frío', 400)
    if (!canAccessSite(req, eq.site_id)) return fail(res, 'No tienes acceso a esa sede', 403)
    if (!en) return fail(res, 'Proveedor no encontrado', 404)
    // El proveedor queda marcado como de cadena de frío en el catálogo general.
    if (!(en.categories || []).includes('cadena_frio')) await supabase.from('ips_entities').update({ categories: [...(en.categories || []), 'cadena_frio'] }).eq('id', en.id)
    const { data, error } = await supabase.from('cold_chain_suppliers').insert({ equipment_id: equipmentId, entity_id: entityId, service: b.service || 'mantenimiento', notes: clean(b.notes) }).select(SELECT).single()
    if (error) { if (error.code === '23505') return fail(res, 'Ese proveedor ya está asignado al equipo', 409); throw error }
    res.status(201).send(dto(data))
  }))
  app.delete('/temperatura/proveedores/:id', auth(ADMIN), h(async (req, res) => {
    const { error } = await supabase.from('cold_chain_suppliers').delete().eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))

  // Contactos por sede para la alerta del dashboard.
  const contactsBySite = async (siteIds) => {
    const all = await list(null)
    const out = {}
    for (const r of all) {
      if (!r.active || !r.provider?.active) continue
      if (siteIds && !siteIds.includes(r.equipment.siteId)) continue
      ;(out[r.equipment.siteId] = out[r.equipment.siteId] || []).push(r)
    }
    return out
  }
  return { contactsBySite }
}
