// =====================================================================
// Centro de notificaciones (IIPS-022)
// Cada módulo registra uno o más "proveedores" de avisos con register(). El endpoint GET /alertas
// los ejecuta para el usuario (según sus módulos, su rol y los servicios de su sede) y devuelve:
//   · counts: { '<ruta del menú>': n } → burbujas con conteo en cada ítem del menú
//   · items: avisos con nivel (bad | warn | info), mensaje y enlace → campana y toasts
// Para sumar avisos de un módulo nuevo basta con registrar otro proveedor; el menú no cambia.
// =====================================================================
const providers = []

// p = { key, module, route, roles?, service?, run: async (req) => [{ id, level, title, message, link?, date? }] }
//   · module: llave de módulo (userModules); route: ítem del menú donde se cuenta.
//   · service: módulo de IPS que debe tener la sede (cadena_frio, citologia, ambulancias) o 'any'.
const register = (p) => {
  if (!p?.key || !p.route || typeof p.run !== 'function') throw new Error('Proveedor de avisos inválido')
  if (!providers.some((x) => x.key === p.key)) providers.push(p)
}

const LEVEL_ORDER = { bad: 0, warn: 1, info: 2 }
const CACHE_MS = 60000
const MAX_ITEMS = 150

const install = (app, deps) => {
  const { auth, h, userModules, inPlan, siteServices, scopeSite } = deps
  const cache = new Map()
  const allowed = (user, p) => {
    if (p.module && !inPlan(p.module)) return false
    if (p.module && !userModules(user).includes(p.module)) return false
    if (p.roles && !p.roles.includes(user.role)) return false
    if (p.service && user.role !== 'administrador') {
      const mods = siteServices(user.site).map((x) => x.module)
      if (p.service === 'any' ? !mods.length : !mods.includes(p.service)) return false
    }
    return true
  }
  app.get('/alertas', auth(), h(async (req, res) => {
    const key = `${req.user.org_id}:${req.user.id}:${scopeSite(req) || 'all'}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS && req.query.fresh !== '1') return res.send(hit.data)
    const mine = providers.filter((p) => allowed(req.user, p))
    const results = await Promise.all(mine.map(async (p) => {
      try {
        const list = (await p.run(req)) || []
        return list.map((x) => ({ ...x, id: `${p.key}:${x.id}`, source: p.key, route: p.route, link: x.link || p.route, level: LEVEL_ORDER[x.level] === undefined ? 'info' : x.level }))
      } catch (e) {
        console.error('Avisos', p.key, e.message)
        return []
      }
    }))
    const items = results.flat()
    const counts = {}
    for (const x of items) counts[x.route] = (counts[x.route] || 0) + 1
    items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || String(a.date || '9').localeCompare(String(b.date || '9')))
    const data = { at: new Date().toISOString(), total: items.length, counts, items: items.slice(0, MAX_ITEMS) }
    cache.set(key, { at: Date.now(), data })
    if (cache.size > 2000) cache.clear()
    res.send(data)
  }))
  // Tras registrar o corregir algo, el frontend pide los avisos sin caché (?fresh=1).
}

module.exports = { register, install, providers }
