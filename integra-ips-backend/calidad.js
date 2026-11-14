// =====================================================================
// Calidad IPS · Documentos generales
// · Ítems principales configurables (nivel 1, con su tipo) y carpetas internas hasta el 3.er nivel.
// · En cualquier carpeta se cargan documentos y formatos (PDF, imágenes, Word, Excel) como en Procesos prioritarios.
// · Filtros por ítem principal, tipo de ítem, tipo de archivo y texto; resumen para el dashboard.
// · Cada servicio de IPS tiene su propio árbol (qdoc_folders.service_id); sin servicio = documentos generales.
//   Las subcarpetas heredan el servicio de su ítem principal. Filtro: ?servicio=general | <id> (sin él, todos).
// =====================================================================
const crypto = require('crypto')
const { htmlFields } = require('./htmldoc')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite } = deps
  const STAFF = ['administrador', 'empleado']
  const BUCKET = 'estandares'
  const MAX = 15 * 1024 * 1024
  const MAX_LEVEL = 3
  const KINDS = ['Direccionamiento', 'Habilitación', 'Calidad y PAMEC', 'Acreditación', 'Administrativo', 'Financiero', 'Jurídico', 'Talento humano', 'Otro']
  const CATEGORIES = ['Política', 'Plan', 'Manual', 'Procedimiento', 'Formato', 'Acta', 'Informe', 'Certificado', 'Estado financiero', 'Contrato', 'Resolución / acto administrativo', 'Imagen / evidencia', 'Otro']
  const TYPES = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/html': 'html'
  }
  const FILE_GROUPS = { pdf: ['pdf'], imagen: ['png', 'jpg', 'webp'], word: ['doc', 'docx'], excel: ['xls', 'xlsx'], html: ['html'] }
  const WARN_DAYS = 30
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })

  const upload = async (file) => {
    const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(file?.data || '')
    if (!m || !TYPES[m[1]] || m[1] === 'text/html') throw httpError(400, 'Tipo de archivo no permitido. Carga PDF, imágenes (PNG, JPG), Word o Excel.')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > MAX) throw httpError(400, 'El archivo supera 15 MB')
    const path = `doc_generales/${crypto.randomBytes(10).toString('hex')}.${TYPES[m[1]]}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: m[1], upsert: false })
    if (error) throw error
    const name = (clean(file.name) || `documento.${TYPES[m[1]]}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160)
    return { file_url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, file_path: path, file_name: name, file_type: m[1], file_size: buffer.length }
  }
  const remove = async (path) => { if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {}) }
  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const validity = (iso) => (!iso ? null : daysUntil(iso) < 0 ? 'vencido' : daysUntil(iso) <= WARN_DAYS ? 'por_vencer' : 'vigente')

  // ---------------------------------------------------------------- Servicios
  // Servicios de IPS activos que el usuario puede ver: el administrador, todos (o los de la sede elegida);
  // el empleado, los habilitados en su sede.
  const servicesFor = async (req) => {
    const { data, error } = await supabase.from('ips_services').select('id, code, name, module, site_services(site_id)').eq('active', true).order('name')
    if (error) throw error
    const site = scopeSite(req)
    return data.filter((s) => !site || (s.site_services || []).some((x) => Number(x.site_id) === Number(site))).map((s) => ({ id: s.id, code: s.code, name: s.name, module: s.module }))
  }
  // ?servicio=general → null (generales); ?servicio=<id> → ese servicio; sin parámetro → undefined (todos).
  const serviceParam = (v) => (v === 'general' ? null : Number(v) || undefined)
  const inService = (f, sid) => sid === undefined || (f.service_id ?? null) === sid

  // ---------------------------------------------------------------- Carpetas
  const loadFolders = async () => {
    const { data, error } = await supabase.from('qdoc_folders').select('*').order('level').order('sort_order').order('name')
    if (error) throw error
    return data
  }
  // Ruta (de la raíz a la carpeta) y el ítem principal al que pertenece.
  const pathOf = (folders, id) => { const out = []; let f = folders.find((x) => x.id === id); while (f) { out.unshift(f); f = folders.find((x) => x.id === f.parent_id) } return out }
  const descendants = (folders, id) => { const out = [id]; for (let i = 0; i < out.length; i++) folders.filter((f) => f.parent_id === out[i]).forEach((f) => out.push(f.id)); return out }
  const folderDTO = (f, folders, counts) => {
    const path = pathOf(folders, f.id)
    return {
      id: f.id, parentId: f.parent_id, level: f.level, serviceId: f.service_id ?? null, code: f.code, name: f.name, kind: path[0]?.kind ?? null, rootId: path[0]?.id ?? f.id, description: f.description, sortOrder: f.sort_order, active: f.active,
      path: path.map((p) => ({ id: p.id, name: p.name, code: p.code })),
      docs: counts[f.id] || 0, totalDocs: descendants(folders, f.id).reduce((a, x) => a + (counts[x] || 0), 0)
    }
  }
  const docCounts = async (req) => {
    let q = supabase.from('qdoc_documents').select('folder_id')
    const site = scopeSite(req)
    if (site) q = q.or(`site_id.is.null,site_id.eq.${site}`)
    const { data } = await q
    return (data || []).reduce((a, d) => { a[d.folder_id] = (a[d.folder_id] || 0) + 1; return a }, {})
  }
  app.get('/calidad/carpetas', auth(STAFF), hx(async (req, res) => {
    const [folders, counts, services] = await Promise.all([loadFolders(), docCounts(req), servicesFor(req)])
    const sid = serviceParam(req.query.servicio)
    const visible = folders.filter((f) => (f.active || req.user.role === 'administrador') && inService(f, sid) && (f.service_id == null || services.some((s) => s.id === f.service_id)))
    res.send({ kinds: KINDS, categories: CATEGORIES, maxLevel: MAX_LEVEL, maxSize: MAX, types: TYPES, services, folders: visible.map((f) => folderDTO(f, folders, counts)) })
  }))
  const folderRow = async (b, current) => {
    const name = clean(b.name)
    if (!name) throw httpError(400, 'Escribe el nombre de la carpeta')
    const parentId = current ? current.parent_id : Number(b.parentId) || null
    let level = 1
    let serviceId = current ? current.service_id ?? null : null
    if (parentId) {
      const { data: parent } = await supabase.from('qdoc_folders').select('id, level, service_id').eq('id', parentId).maybeSingle()
      if (!parent) throw httpError(404, 'Carpeta superior no encontrada')
      level = parent.level + 1
      if (level > MAX_LEVEL) throw httpError(400, `Solo se permiten carpetas hasta el ${MAX_LEVEL}.er nivel`)
      serviceId = parent.service_id ?? null
    } else if (!current) {
      // Ítem principal nuevo: va a los generales o al árbol del servicio elegido.
      serviceId = Number(b.serviceId) || null
      if (serviceId) {
        const { data: svc } = await supabase.from('ips_services').select('id').eq('id', serviceId).maybeSingle()
        if (!svc) throw httpError(404, 'Servicio no encontrado')
      }
    }
    if (level === 1 && b.kind && !KINDS.includes(b.kind)) throw httpError(400, 'Tipo de ítem inválido')
    return { parent_id: parentId, level, service_id: serviceId, name: name.slice(0, 160), code: clean(b.code), kind: level === 1 ? (b.kind || 'Otro') : null, description: clean(b.description), sort_order: Number(b.sortOrder) || 0, active: b.active !== false, updated_at: new Date().toISOString() }
  }
  app.post('/calidad/carpetas', auth(ADMIN), hx(async (req, res) => {
    const row = await folderRow(req.body || {})
    const { data, error } = await supabase.from('qdoc_folders').insert({ ...row, created_by: req.user.id }).select('*').single()
    if (error) { if (error.code === '23505') throw httpError(409, 'Ya existe una carpeta con ese nombre en ese lugar'); throw error }
    res.status(201).send(data)
  }))
  app.put('/calidad/carpetas/:id', auth(ADMIN), hx(async (req, res) => {
    const { data: cur } = await supabase.from('qdoc_folders').select('*').eq('id', Number(req.params.id)).maybeSingle()
    if (!cur) throw httpError(404, 'Carpeta no encontrada')
    const row = await folderRow(req.body || {}, cur)
    const { data, error } = await supabase.from('qdoc_folders').update(row).eq('id', cur.id).select('*').single()
    if (error) { if (error.code === '23505') throw httpError(409, 'Ya existe una carpeta con ese nombre en ese lugar'); throw error }
    res.send(data)
  }))
  app.delete('/calidad/carpetas/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const [{ count: subs }, { count: docs }] = await Promise.all([
      supabase.from('qdoc_folders').select('id', { count: 'exact', head: true }).eq('parent_id', id),
      supabase.from('qdoc_documents').select('id', { count: 'exact', head: true }).eq('folder_id', id)
    ])
    if (subs || docs) return fail(res, 'La carpeta tiene subcarpetas o documentos: muévelos o elimínalos primero', 409)
    const { error } = await supabase.from('qdoc_folders').delete().eq('id', id)
    if (error) throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Documentos
  const SELECT = '*, site:sites(name), creator:users!qdoc_documents_created_by_fkey(name, last_name)'
  const docDTO = (d, folders) => {
    const path = folders ? pathOf(folders, d.folder_id) : []
    return {
      id: d.id, folderId: d.folder_id, serviceId: path[0]?.service_id ?? null, folderPath: path.map((p) => p.name).join(' / '), rootName: path[0]?.name ?? null, kind: path[0]?.kind ?? null,
      siteId: d.site_id, siteName: d.site?.name ?? null, name: d.name, category: d.category, code: d.code, version: d.version, observations: d.observations,
      validUntil: d.valid_until, validity: validity(d.valid_until), daysLeft: d.valid_until ? daysUntil(d.valid_until) : null,
      fileUrl: d.file_url, fileName: d.file_name, fileType: d.file_type, fileExt: TYPES[d.file_type], fileSize: d.file_size,
      description: d.description ?? null, isHtml: d.file_type === 'text/html', contentHtml: d.content_html ?? null,
      createdBy: d.creator ? `${d.creator.name} ${d.creator.last_name}` : null, createdById: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at
    }
  }
  const docRow = (b) => {
    const name = clean(b.name)
    if (!name) throw httpError(400, 'El nombre del documento es requerido')
    const until = clean(b.validUntil)
    if (until && !ISO_DATE.test(until)) throw httpError(400, 'Fecha de vigencia inválida')
    if (!Number(b.folderId)) throw httpError(400, 'Elige la carpeta')
    return { folder_id: Number(b.folderId), name: name.slice(0, 200), category: clean(b.category), code: clean(b.code), version: clean(b.version), observations: clean(b.observations), description: clean(b.description), valid_until: until }
  }
  const siteFor = (req, v) => (req.user.role !== 'administrador' ? req.user.site_id : (v === '' || v == null || v === 'general' ? null : Number(v) || null))
  app.get('/calidad/documentos', auth(STAFF), hx(async (req, res) => {
    const [all, services] = await Promise.all([loadFolders(), servicesFor(req)])
    // Solo carpetas generales o de servicios que el usuario puede ver.
    const folders = all.filter((f) => { const root = pathOf(all, f.id)[0]; return root?.service_id == null || services.some((s) => s.id === root.service_id) })
    let q = supabase.from('qdoc_documents').select(SELECT).order('name')
    const site = scopeSite(req)
    if (site) q = q.or(`site_id.is.null,site_id.eq.${site}`)
    const folderId = Number(req.query.carpeta) || Number(req.query.item) || null
    const sid = serviceParam(req.query.servicio)
    if (folderId) q = q.in('folder_id', (req.query.subcarpetas === '0' ? [folderId] : descendants(folders, folderId)).filter((id) => folders.some((f) => f.id === id)).concat(0))
    else q = q.in('folder_id', folders.filter((f) => inService(f, sid)).map((f) => f.id).concat(0))
    if (clean(req.query.categoria)) q = q.eq('category', clean(req.query.categoria))
    const { data, error } = await q
    if (error) throw error
    let rows = data.map((d) => docDTO(d, folders))
    if (clean(req.query.tipoItem)) rows = rows.filter((d) => d.kind === req.query.tipoItem)
    if (FILE_GROUPS[req.query.tipo]) rows = rows.filter((d) => FILE_GROUPS[req.query.tipo].includes(d.fileExt))
    const text = clean(req.query.q)?.toLowerCase()
    if (text) rows = rows.filter((d) => [d.name, d.code, d.category, d.observations, d.description, d.fileName, d.folderPath].some((v) => v && v.toLowerCase().includes(text)))
    res.send(rows)
  }))
  const loadDoc = async (req) => {
    const { data } = await supabase.from('qdoc_documents').select(SELECT).eq('id', Number(req.params.id)).maybeSingle()
    if (!data || (data.site_id && !canAccessSite(req, data.site_id))) throw httpError(404, 'Documento no encontrado')
    return data
  }
  app.post('/calidad/documentos', auth(STAFF), hx(async (req, res) => {
    const r = docRow(req.body || {})
    const isHtml = req.body?.kind === 'html'
    if (!isHtml && !req.body?.file) return fail(res, 'Carga el archivo del documento', 400)
    const f = isHtml ? htmlFields(r.name, req.body.contentHtml, httpError) : await upload(req.body.file)
    const { data, error } = await supabase.from('qdoc_documents').insert({ ...r, ...f, site_id: siteFor(req, req.body.siteId), created_by: req.user.id, updated_by: req.user.id }).select(SELECT).single()
    if (error) { await remove(f.file_path); throw error }
    res.status(201).send(docDTO(data, await loadFolders()))
  }))
  app.put('/calidad/documentos/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadDoc(req)
    const upd = { ...docRow({ ...req.body, folderId: req.body?.folderId || cur.folder_id }), updated_by: req.user.id, updated_at: new Date().toISOString() }
    if (req.user.role === 'administrador' && 'siteId' in (req.body || {})) upd.site_id = siteFor(req, req.body.siteId)
    let f = null
    if (cur.file_type === 'text/html') { if ('contentHtml' in (req.body || {})) Object.assign(upd, htmlFields(upd.name, req.body.contentHtml, httpError)) } else if (req.body?.file) { f = await upload(req.body.file); Object.assign(upd, f) }
    const { data, error } = await supabase.from('qdoc_documents').update(upd).eq('id', cur.id).select(SELECT).single()
    if (error) { if (f) await remove(f.file_path); throw error }
    if (f) await remove(cur.file_path)
    res.send(docDTO(data, await loadFolders()))
  }))
  app.delete('/calidad/documentos/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadDoc(req)
    if (!ADMIN.includes(req.user.role) && cur.created_by !== req.user.id) return fail(res, 'Solo el administrador o quien cargó el documento puede eliminarlo', 403)
    const { error } = await supabase.from('qdoc_documents').delete().eq('id', cur.id)
    if (error) throw error
    await remove(cur.file_path)
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Dashboard
  app.get('/calidad/resumen', auth(STAFF), hx(async (req, res) => {
    const [allFolders, services] = await Promise.all([loadFolders(), servicesFor(req)])
    const sid = serviceParam(req.query.servicio)
    const known = (f) => f.service_id == null || services.some((s) => s.id === f.service_id)
    let q = supabase.from('qdoc_documents').select(SELECT).order('created_at', { ascending: false })
    const site = scopeSite(req)
    if (site) q = q.or(`site_id.is.null,site_id.eq.${site}`)
    const { data, error } = await q
    if (error) throw error
    const allDocs = data.map((d) => docDTO(d, allFolders))
    // Resumen por servicio (siempre completo, para comparar) y el detalle del servicio elegido.
    const summarize = (fs, ds) => {
      const subs = fs.filter((f) => f.level > 1)
      return {
        documentos: ds.length, items: fs.filter((f) => f.level === 1 && f.active).length, carpetas: subs.length,
        sinCargar: subs.filter((s) => !ds.some((d) => d.folderId === s.id) && !fs.some((x) => x.parent_id === s.id)).length,
        vencidos: ds.filter((d) => d.validity === 'vencido').length, porVencer: ds.filter((d) => d.validity === 'por_vencer').length
      }
    }
    const scopeOf = (s) => { const fs = allFolders.filter((f) => known(f) && inService(f, s)); const ids = new Set(fs.map((f) => f.id)); return { fs, ds: allDocs.filter((d) => ids.has(d.folderId)) } }
    const byService = [{ id: null, name: 'Generales', code: 'general' }, ...services].map((s) => { const { fs, ds } = scopeOf(s.id); return { id: s.id, code: s.code, name: s.name, ...summarize(fs, ds) } })
    const { fs: folders, ds: docs } = scopeOf(sid)
    const roots = folders.filter((f) => f.level === 1 && f.active)
    const byItem = roots.map((r) => {
      const ids = descendants(folders, r.id)
      const list = docs.filter((d) => ids.includes(d.folderId))
      const subs = folders.filter((f) => ids.includes(f.id) && f.id !== r.id)
      return { id: r.id, serviceId: r.service_id ?? null, code: r.code, name: r.name, kind: r.kind, documentos: list.length, carpetas: subs.length, carpetasVacias: subs.filter((s) => !docs.some((d) => d.folderId === s.id) && !folders.some((x) => x.parent_id === s.id)).length, vencidos: list.filter((d) => d.validity === 'vencido').length, porVencer: list.filter((d) => d.validity === 'por_vencer').length }
    })
    const byType = Object.entries(FILE_GROUPS).map(([k, exts]) => ({ name: { pdf: 'PDF', imagen: 'Imagen', word: 'Word', excel: 'Excel', html: 'En línea' }[k], value: docs.filter((d) => exts.includes(d.fileExt)).length }))
    res.send({
      kpis: { documentos: docs.length, items: roots.length, carpetas: folders.filter((f) => f.level > 1).length, vencidos: docs.filter((d) => d.validity === 'vencido').length, porVencer: docs.filter((d) => d.validity === 'por_vencer').length, sinCargar: byItem.reduce((a, x) => a + x.carpetasVacias, 0) },
      services, byService, byItem, byType,
      expiring: docs.filter((d) => d.validity && d.validity !== 'vigente').sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 8),
      recent: docs.slice(0, 8)
    })
  }))
}
