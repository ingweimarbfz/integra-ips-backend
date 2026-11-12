// =====================================================================
// Paginación de listados: ?pagina=N&limite=M (máx. 200 por página).
// El total va en la cabecera X-Total-Count. Sin ?pagina se conserva el tope anterior de cada listado.
// =====================================================================
const PAGE_MAX = 200
const pageQuery = (req, q, fallbackLimit) => {
  const page = Number(req.query.pagina)
  if (!(page >= 1)) return q.limit(fallbackLimit)
  const limit = Math.min(Math.max(Number(req.query.limite) || 50, 1), PAGE_MAX)
  const from = (Math.floor(page) - 1) * limit
  return q.range(from, from + limit - 1)
}
const setTotal = (res, count) => { if (Number.isFinite(count)) res.set('X-Total-Count', String(count)) }
module.exports = { pageQuery, setTotal, PAGE_MAX }
