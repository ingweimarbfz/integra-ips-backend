// =====================================================================
// Preoperacional diario del vehículo (basado en la lista de chequeo SURA
// para automóvil o pick-up). Lo diligencia el conductor; si un ítem no
// cumple, se documenta con observación y fotos.
// =====================================================================
const ITEMS = [
  { key: 'llantas', label: 'Estado de las llantas', help: 'Verifica la profundidad del labrado, presión, cortaduras o protuberancias.' },
  { key: 'luces', label: 'Luces', help: 'Verifica el funcionamiento de luces altas y bajas, posición, direccionales, freno, reversa y estacionarias.' },
  { key: 'bocina', label: 'Bocina', help: 'Verifica su funcionamiento.' },
  { key: 'espejos', label: 'Espejos', help: 'Revisa y posiciona correctamente los espejos laterales y central.' },
  { key: 'niveles', label: 'Niveles de líquidos', help: 'Verifica aceite, líquido de frenos, limpiaparabrisas, refrigerante y dirección hidráulica (si aplica).' },
  { key: 'fugas', label: 'Fugas de fluidos', help: 'Verifica que no existan fugas ni humedades en el habitáculo del motor ni en el piso donde parquea.' },
  { key: 'frenos', label: 'Estado de frenos', help: 'Verifica el estado de las pastillas y una óptima tensión del pedal y del freno de parqueo.' },
  { key: 'parabrisas', label: 'Parabrisas', help: 'Verifica que no esté fisurado y el funcionamiento de las plumillas.' },
  { key: 'retencion', label: 'Elementos de retención', help: 'Revisa el estado del cinturón de seguridad y el anclaje de las sillas.' },
  { key: 'documentos', label: 'Documentos', help: 'Verifica la tarjeta de propiedad, SOAT y revisión técnico-mecánica (si aplica).' },
  { key: 'prevencion', label: 'Equipos de prevención', help: 'Revisa caja de herramientas, extintor, botiquín, conos, tacos, linterna, llanta de repuesto, gato, cruceta y chaleco reflectivo.' },
  { key: 'tablero', label: 'Luces de tablero y testigos', help: 'Antes de iniciar la marcha, verifica que todos los testigos, excepto el de parqueo, estén apagados.' }
]
const MAX_ITEM_PHOTOS = 3
const MAX_GENERAL_PHOTOS = 6

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ISO_DATE, TZ, TZ_OFFSET, todayBogota, uploadImage, removeStoredFile, scopeSite, applyScope } = deps
  const VIEW = ['administrador', 'empleado', 'conductor']
  const IMG = ['image/png', 'image/jpeg', 'image/webp']
  const fullName = (u) => (u ? `${u.name} ${u.last_name}` : null)
  const SELECT = '*, vehicles(id, movil, plate, vehicle_type, brand, line, site_id), driver:users!vehicle_inspections_driver_id_fkey(id, name, last_name, identification), site:sites(name), vehicle_inspection_items(*)'

  const dto = (r) => ({
    id: r.id, code: r.code, inspectedAt: r.inspected_at, date: r.inspection_date, km: Number(r.km),
    driverFit: r.driver_fit, driverFitObservation: r.driver_fit_observation, result: r.result, anomalies: r.anomalies,
    generalObservation: r.general_observation, generalPhotos: r.general_photos || [], siteName: r.site?.name ?? null,
    vehicle: r.vehicles ? { id: r.vehicles.id, movil: r.vehicles.movil, plate: r.vehicles.plate, vehicleType: r.vehicles.vehicle_type, brand: r.vehicles.brand, line: r.vehicles.line } : null,
    driver: r.driver ? { id: r.driver.id, name: fullName(r.driver), identification: r.driver.identification } : null,
    items: r.vehicle_inspection_items
      ? ITEMS.map((it) => {
        const x = r.vehicle_inspection_items.find((i) => i.item_key === it.key)
        return { ...it, ok: x ? x.ok : null, observation: x?.observation ?? null, photos: x?.photos || [] }
      })
      : undefined
  })

  app.get('/vehiculos-preoperacional/items', auth(VIEW), (req, res) => res.send(ITEMS))

  // Listado: el conductor ve los suyos; admin y empleado ven los de la sede (o todas).
  app.get('/vehiculos-preoperacional', auth(VIEW), h(async (req, res) => {
    const desde = clean(req.query.desde); const hasta = clean(req.query.hasta)
    if ((desde && !ISO_DATE.test(desde)) || (hasta && !ISO_DATE.test(hasta))) return fail(res, 'Fechas inválidas', 400)
    let q = supabase.from('vehicle_inspections').select(SELECT.replace(', vehicle_inspection_items(*)', '')).order('inspected_at', { ascending: false }).limit(300)
    q = req.user.role === 'conductor' ? q.eq('driver_id', req.user.id) : applyScope(q, scopeSite(req))
    if (req.query.vehiculo) q = q.eq('vehicle_id', Number(req.query.vehiculo))
    if (req.query.resultado) q = q.eq('result', req.query.resultado)
    if (desde) q = q.gte('inspection_date', desde)
    if (hasta) q = q.lte('inspection_date', hasta)
    const { data, error } = await q
    if (error) throw error
    res.send(data.map(dto))
  }))

  // Preoperacional de hoy para un vehículo (se usa al iniciar un reporte diario).
  app.get('/vehiculos-preoperacional/hoy', auth(VIEW), h(async (req, res) => {
    const vehicleId = Number(req.query.vehiculo)
    if (!vehicleId) return fail(res, 'Indica el vehículo', 400)
    let q = supabase.from('vehicle_inspections').select('id, code, result, anomalies, driver_id, inspected_at').eq('vehicle_id', vehicleId).eq('inspection_date', todayBogota()).order('inspected_at', { ascending: false })
    if (req.query.conductor) q = q.eq('driver_id', Number(req.query.conductor))
    const { data, error } = await q.limit(1)
    if (error) throw error
    res.send(data[0] || null)
  }))

  app.get('/vehiculos-preoperacional/:id', auth(VIEW), h(async (req, res) => {
    const { data, error } = await supabase.from('vehicle_inspections').select(SELECT).eq('id', Number(req.params.id)).maybeSingle()
    if (error) throw error
    const allowed = data && (req.user.role === 'administrador' || data.driver_id === req.user.id || (req.user.role === 'empleado' && data.site_id === req.user.site_id))
    if (!allowed) return fail(res, 'Preoperacional no encontrado', 404)
    res.send(dto(data))
  }))

  // Registro: solo el conductor, una vez por vehículo y día.
  app.post('/vehiculos-preoperacional', auth(['conductor']), h(async (req, res) => {
    const b = req.body || {}
    const { data: v } = await supabase.from('vehicles').select('id, movil, current_km, site_id, status').eq('id', Number(b.vehicleId)).maybeSingle()
    if (!v) return fail(res, 'Busca el vehículo por su número de móvil', 400)
    if (v.status === 'fuera_servicio') return fail(res, 'El vehículo está fuera de servicio', 400)

    const errors = []
    const km = Number(b.km)
    if (b.km === '' || b.km == null || Number.isNaN(km)) errors.push('Ingresa el kilometraje del tacómetro')
    else if (km < Number(v.current_km)) errors.push(`El kilometraje no puede ser menor al último registrado (${Number(v.current_km)} km)`)
    else if (km - Number(v.current_km) > 2000) errors.push('El kilometraje es muy superior al último registrado; revisa el valor')
    if (typeof b.driverFit !== 'boolean') errors.push('Responde si estás en condiciones de salud y descanso para conducir')
    if (b.driverFit === false && !clean(b.driverFitObservation)) errors.push('Describe por qué no estás en condiciones de conducir')
    const answers = new Map((b.items || []).map((i) => [i.key, i]))
    for (const it of ITEMS) {
      const a = answers.get(it.key)
      if (!a || typeof a.ok !== 'boolean') errors.push(`Responde "${it.label}"`)
      else if (!a.ok && !clean(a.observation)) errors.push(`Describe la anomalía en "${it.label}"`)
      else if ((a.photos || []).length > MAX_ITEM_PHOTOS) errors.push(`Máximo ${MAX_ITEM_PHOTOS} fotos en "${it.label}"`)
    }
    if ((b.generalPhotos || []).length > MAX_GENERAL_PHOTOS) errors.push(`Máximo ${MAX_GENERAL_PHOTOS} fotos generales`)
    if (errors.length) return fail(res, errors.join('. '), 400)

    const { data: dup } = await supabase.from('vehicle_inspections').select('code').eq('vehicle_id', v.id).eq('driver_id', req.user.id).eq('inspection_date', todayBogota()).maybeSingle()
    if (dup) return fail(res, `Ya registraste el preoperacional de hoy para la Móvil ${v.movil} (${dup.code})`, 409)

    // Subir fotos (solo se guardan las que llegan con los ítems que no cumplen o como generales).
    const uploaded = []
    const up = async (dataUrl, prefix) => {
      const url = await uploadImage('vehicles', prefix, dataUrl, IMG)
      if (!url) throw Object.assign(new Error('Una de las fotos no es válida (PNG, JPG o WEBP de máximo 2 MB)'), { status: 400 })
      uploaded.push(url)
      return url
    }
    try {
      const itemRows = []
      for (const it of ITEMS) {
        const a = answers.get(it.key)
        const photos = []
        for (const p of (a.photos || [])) photos.push(await up(p, `pre-${v.movil}-${it.key}`))
        itemRows.push({ item_key: it.key, ok: a.ok, observation: clean(a.observation), photos })
      }
      const general = []
      for (const p of (b.generalPhotos || [])) general.push(await up(p, `pre-${v.movil}-general`))
      const anomalies = itemRows.filter((r) => !r.ok).length + (b.driverFit ? 0 : 1)

      const { data: ins, error } = await supabase.from('vehicle_inspections').insert({
        vehicle_id: v.id, driver_id: req.user.id, site_id: v.site_id, km, driver_fit: b.driverFit,
        driver_fit_observation: clean(b.driverFitObservation), result: anomalies === 0 ? 'apto' : 'no_apto', anomalies,
        general_observation: clean(b.generalObservation), general_photos: general
      }).select('id').single()
      if (error) throw error
      const { error: e2 } = await supabase.from('vehicle_inspection_items').insert(itemRows.map((r) => ({ ...r, inspection_id: ins.id })))
      if (e2) { await supabase.from('vehicle_inspections').delete().eq('id', ins.id); throw e2 }

      // El km leído actualiza el vehículo si no hay una actividad abierta.
      if (km > Number(v.current_km)) {
        const { data: open } = await supabase.from('vehicle_trips').select('id').eq('vehicle_id', v.id).eq('status', 'abierto').limit(1)
        if (!open?.length) await supabase.from('vehicles').update({ current_km: km, updated_at: new Date().toISOString() }).eq('id', v.id)
      }
      const { data } = await supabase.from('vehicle_inspections').select(SELECT).eq('id', ins.id).single()
      res.status(201).send(dto(data))
    } catch (e) {
      for (const u of uploaded) await removeStoredFile('vehicles', u)
      if (e.status) return fail(res, e.message, e.status)
      throw e
    }
  }))

  app.delete('/vehiculos-preoperacional/:id', auth(['administrador']), h(async (req, res) => {
    const { data } = await supabase.from('vehicle_inspections').select('general_photos, vehicle_inspection_items(photos)').eq('id', Number(req.params.id)).maybeSingle()
    if (!data) return fail(res, 'Preoperacional no encontrado', 404)
    await supabase.from('vehicle_inspections').delete().eq('id', Number(req.params.id))
    for (const u of [...(data.general_photos || []), ...data.vehicle_inspection_items.flatMap((i) => i.photos || [])]) await removeStoredFile('vehicles', u)
    res.send({ message: 'Preoperacional eliminado' })
  }))

  // Resumen para el dashboard de flota.
  app.get('/vehiculos-preoperacional-resumen', auth(VIEW), h(async (req, res) => {
    const today = todayBogota()
    const site = req.user.role === 'conductor' ? req.user.site_id : scopeSite(req)
    const [veh, ins] = await Promise.all([
      applyScope(supabase.from('vehicles').select('id, movil, plate, status'), site).neq('status', 'fuera_servicio').order('movil'),
      applyScope(supabase.from('vehicle_inspections').select('id, code, vehicle_id, result, anomalies, inspected_at, inspection_date, driver:users!vehicle_inspections_driver_id_fkey(name, last_name)'), site)
        .gte('inspection_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)).order('inspected_at', { ascending: false })
    ])
    if (veh.error) throw veh.error
    if (ins.error) throw ins.error
    const rows = veh.data.map((v) => {
      const last = ins.data.find((i) => i.vehicle_id === v.id)
      return { vehicleId: v.id, movil: v.movil, plate: v.plate, today: last?.inspection_date === today, last: last ? { id: last.id, code: last.code, result: last.result, anomalies: last.anomalies, date: last.inspection_date, driver: fullName(last.driver) } : null }
    })
    res.send({
      today, vehicles: rows,
      doneToday: rows.filter((r) => r.today).length,
      noAptoToday: rows.filter((r) => r.today && r.last.result === 'no_apto').length,
      monthCount: ins.data.filter((i) => i.inspection_date.slice(0, 7) === today.slice(0, 7)).length
    })
  }))
}
module.exports.ITEMS = ITEMS
