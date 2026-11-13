// =====================================================================
// Multi-cliente: cada petición corre en el contexto de su organización (org_id).
// · El contexto viaja con AsyncLocalStorage desde el middleware de autenticación.
// · El cliente de Supabase filtra solo por org_id en select/update/delete y lo agrega en insert/upsert
//   de las tablas del negocio. Además se envía la cabecera x-org-id, que usan los valores por
//   defecto y las funciones de la base (consecutivos, inventario).
// · Sin contexto (login, páginas públicas, plataforma) las consultas no se filtran: esas rutas
//   deben usar runAsOrg() cuando tocan datos de un cliente.
// =====================================================================
const { AsyncLocalStorage } = require('async_hooks')

const ctx = new AsyncLocalStorage()
const currentOrg = () => ctx.getStore()?.orgId ?? null
const runAsOrg = (orgId, fn) => ctx.run({ orgId: Number(orgId) }, fn)

const TENANT_TABLES = new Set(['app_settings', 'billing_tax_settings', 'cold_chain_suppliers', 'cytology_samples', 'discounts', 'document_sends', 'document_shares', 'document_signatures', 'eps_billings', 'eps_insurers', 'equipment', 'equipment_maintenance_parts', 'equipment_maintenances', 'esavi_reports', 'gso_event_materials', 'gso_event_personnel', 'gso_event_supplies', 'gso_events', 'inventory_items', 'inventory_movements', 'inventory_products', 'ips_entities', 'ips_services', 'qdoc_documents', 'qdoc_folders', 'service_charge_items', 'service_charge_uses', 'service_charges', 'service_prices', 'service_tariffs', 'site_services', 'sites', 'std_checklists', 'std_documents', 'std_required_docs', 'temperature', 'th_checklists', 'th_contracts', 'th_documents', 'th_format_settings', 'th_position_requirements', 'th_positions', 'th_requirement_types', 'th_staff', 'users', 'vaccination_records', 'vaccination_reminder_settings', 'vaccination_reminders', 'vaccine_open_vials', 'vaccines', 'vehicle_documents', 'vehicle_inspection_items', 'vehicle_inspections', 'vehicle_maintenance_parts', 'vehicle_maintenances', 'vehicle_transfers', 'vehicle_trips', 'vehicles', 'volunteers', 'warehouses'])

const withOrg = (rows, org) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, org_id: org })) : { ...rows, org_id: org })

// Envuelve supabase.from(): las consultas a tablas del negocio quedan limitadas a la organización actual.
const scopeClient = (supabase) => {
  const rawFrom = supabase.from.bind(supabase)
  supabase.from = (table) => {
    const qb = rawFrom(table)
    const org = currentOrg()
    if (!org || !TENANT_TABLES.has(table)) return qb
    return new Proxy(qb, {
      get (target, prop) {
        const v = target[prop]
        if (typeof v !== 'function') return v
        if (prop === 'select' || prop === 'update' || prop === 'delete') return (...a) => v.apply(target, a).eq('org_id', org)
        if (prop === 'insert' || prop === 'upsert') return (rows, ...rest) => v.call(target, withOrg(rows, org), ...rest)
        return v.bind(target)
      }
    })
  }
  return supabase
}

// Cabecera para la base de datos (fetch personalizado del cliente de Supabase).
const orgHeaders = (headers) => {
  const org = currentOrg()
  if (!org) return headers
  const h = new Headers(headers || {})
  h.set('x-org-id', String(org))
  return h
}

// Tareas programadas: se ejecutan una vez por cada organización activa o en prueba.
let ensurePlan = null
const setEnsure = (fn) => { ensurePlan = fn }
const forEachOrg = async (supabase, fn) => {
  const { data } = await supabase.from('plt_organizations').select('id').in('status', ['activa', 'prueba'])
  const ids = data?.length ? data.map((o) => o.id) : [1]
  for (const id of ids) {
    try { if (ensurePlan) await ensurePlan(id); await runAsOrg(id, fn) } catch (e) { console.error(`Tarea de la organización ${id}:`, e.message) }
  }
}

module.exports = { ctx, currentOrg, runAsOrg, scopeClient, orgHeaders, forEachOrg, setEnsure, TENANT_TABLES }
