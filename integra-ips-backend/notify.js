// =====================================================================
// Notificaciones por Telegram
// · Cada organización configura su bot (token de @BotFather) y uno o más grupos por sección.
// · Secciones: temperatura, eventos y emergencias (socorro), vehicular (actividad y preoperacional) y educación.
// · Cada grupo pertenece a una sede: solo recibe los avisos de esa sede (sin sede = todas, para la dirección).
// · Una sección solo se puede configurar y notificar si su módulo está en el plan de la organización.
// · El envío nunca bloquea ni hace fallar el registro que lo origina (se ejecuta en segundo plano).
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, inPlan, hasFeature, TZ, userModules } = deps
  const SECTIONS = {
    temperatura: { label: 'Registro de temperatura', module: 'temperatura', hint: 'Cada lectura registrada y las que quedan fuera de rango' },
    socorro: { label: 'Eventos y emergencias', module: 'socorro', hint: 'Apertura y cierre de eventos y emergencias' },
    vehicular: { label: 'Vehicular', module: 'flota', hint: 'Actividad vehicular (salida y cierre) y preoperacional' },
    educacion: { label: 'Actividades de educación', module: 'educacion', hint: 'Apertura y cierre de actividades de educación' },
    ambulancias: { label: 'Ambulancias (traslado asistencial)', module: 'traslado', hint: 'Salida y llegada de cada traslado asistencial TAB/TAM' },
    inventario: { label: 'Inventario y bodegas', module: 'inventario', hint: 'Ingresos a la bodega general, traslados entre bodegas, entregas, bajas y ajustes' },
    academico: { label: 'Clases de educación (institución ETDH)', module: 'edu_programas', hint: 'Clases programadas, reprogramadas y canceladas (además, cada grupo académico avisa en su propio grupo de Telegram)' }
  }
  const API = 'https://api.telegram.org'
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const featureOn = () => !hasFeature || hasFeature('notificaciones_telegram')
  const gate = (req, res, next) => (featureOn() ? next() : fail(res, 'Tu plan no incluye las notificaciones por Telegram.', 403))
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const tokenOk = (t) => /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(t || '')
  const mask = (t) => (t ? `${t.split(':')[0]}:••••••${t.slice(-4)}` : null)

  const tg = async (token, method, body) => {
    const r = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) throw Object.assign(httpError(400, `Telegram: ${j.description || `error ${r.status}`}`), { migrateTo: j.parameters?.migrate_to_chat_id ? String(j.parameters.migrate_to_chat_id) : null })
    return j.result
  }
  // Al hacer administrador al bot (o al crecer), Telegram convierte el grupo en supergrupo y le cambia el id:
  // se actualiza el id guardado en las secciones y en los grupos académicos, y se reintenta el envío.
  const sendTo = async (token, chatId, html) => {
    try { await tg(token, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); return String(chatId) } catch (e) {
      if (!e.migrateTo) throw e
      await supabase.from('notification_channels').update({ chat_id: e.migrateTo }).eq('chat_id', String(chatId))
      await supabase.from('edu_groups').update({ telegram_chat_id: e.migrateTo }).eq('telegram_chat_id', String(chatId))
      await tg(token, 'sendMessage', { chat_id: e.migrateTo, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
      return e.migrateTo
    }
  }
  const loadSettings = async () => (await supabase.from('notification_settings').select('*').maybeSingle()).data
  const sectionsDTO = () => Object.entries(SECTIONS).map(([key, s]) => ({ key, label: s.label, hint: s.hint, module: s.module, available: inPlan(s.module) }))

  // Envío (en segundo plano, en el contexto de la organización de la petición).
  const send = async (section, build, siteId) => {
    if (!SECTIONS[section] || !featureOn() || !inPlan(SECTIONS[section].module)) return
    const st = await loadSettings()
    if (!st?.enabled || !st.bot_token) return
    // El mensaje puede ser texto o una función (async) que arma el texto con datos adicionales.
    const html = typeof build === 'function' ? await build() : build
    if (!html) return
    let q = supabase.from('notification_channels').select('chat_id, title, site_id').eq('section', section).eq('enabled', true)
    q = siteId ? q.or(`site_id.is.null,site_id.eq.${Number(siteId)}`) : q.is('site_id', null)
    const { data: chans } = await q
    for (const c of chans || []) {
      let status = 'enviado'; let detail = null
      let sentTo = c.chat_id
      try { sentTo = await sendTo(st.bot_token, c.chat_id, html) } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
      await supabase.from('notification_log').insert({ section, chat_id: sentTo, status, detail, site_id: siteId || null })
    }
  }
  const notify = (section, html, siteId) => { send(section, html, siteId).catch((e) => console.error('Telegram:', e.message)) }
  // Envío directo a un grupo de Telegram (p. ej. el grupo de un grupo académico de Educación), con el bot de la organización.
  const toChat = (chatId, html, section = 'academico') => {
    const run = async () => {
      if (!chatId || !featureOn() || (SECTIONS[section] && !inPlan(SECTIONS[section].module))) return
      const st = await loadSettings()
      if (!st?.enabled || !st.bot_token) return
      let status = 'enviado'; let detail = null
      let sentTo = String(chatId)
      try { sentTo = await sendTo(st.bot_token, chatId, html) } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
      await supabase.from('notification_log').insert({ section, chat_id: sentTo, status, detail, site_id: null })
    }
    run().catch((e) => console.error('Telegram:', e.message))
  }
  // Grupos donde está el bot (para elegir el grupo de Telegram de un grupo académico).
  const findGroups = async () => {
    const st = await loadSettings()
    if (!st?.bot_token) throw httpError(400, 'Primero configura el bot de Telegram en Notificaciones')
    const ups = await tg(st.bot_token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member', 'channel_post'] })
    const found = new Map()
    for (const u of ups || []) {
      const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat
      if (!chat || !['group', 'supergroup', 'channel'].includes(chat.type)) continue
      if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)) { found.delete(String(chat.id)); continue }
      found.set(String(chat.id), { chatId: String(chat.id), title: chat.title || 'Grupo sin nombre', type: chat.type })
    }
    return [...found.values()]
  }
  const when = (iso) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(iso ? new Date(iso) : new Date())

  // Mensajes de cada evento del sistema (diseño aprobado: título, separador, datos con emojis y listas con viñetas).
  const SEP = '━━━━━━━━━━━━━━━'
  const n = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }))
  const t1 = (v) => Number(v).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const hour = (iso) => new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: TZ }).format(iso ? new Date(iso) : new Date())
  const dur = (a, b) => {
    if (!a || !b) return null
    const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000))
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
  }
  const people = (list) => (list || []).map((p) => ` • ${esc(p.fullName || p.name || '—')}${p.roleLabel || p.role ? ` — ${esc(p.roleLabel || p.role)}` : ''}`).join('\n')
  const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '')
  const daysTo = (iso) => (iso ? Math.round((Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) - Date.now()) / 86400000) : null)
  // Estado de una existencia después del movimiento: en cero, vencida, por vencer, bajo el mínimo o normal.
  const stockTag = (stock, min, expiry) => {
    const d = daysTo(expiry)
    if (Number(stock) <= 0) return ' 🔴 en cero'
    if (d != null && d < 0) return ` 🔴 vencido ${fmtDate(expiry)}`
    const tags = []
    if (min != null && Number(stock) < Number(min)) tags.push(`⚠️ bajo el mínimo (${n(min)})`)
    if (d != null && d <= 60) tags.push(`vence ${fmtDate(expiry)} ⏳`)
    return tags.length ? ` · ${tags.join(' · ')}` : ' ✅'
  }
  const signed = (q) => (Number(q) > 0 ? `+${n(q, 2)}` : `−${n(Math.abs(q), 2)}`)

  const messages = {
    temperatura: (t, th, day) => {
      const hi = th && t.tempMax > th.max; const lo = th && t.tempMin < th.min
      const out = hi || lo
      const status = (day || []).map((p) => `${p.done ? '✅' : '⬜'} ${p.short}`).join(' · ')
      return `${out ? '⚠️ <b>FUERA DE RANGO</b> · ' : '🌡️ '}<b>TEMPERATURA · ${esc(t.slotLabel || t.shiftLabel || '')}</b>\n${SEP}\n` +
        `🏥 ${esc(t.siteName || '—')} · 🕒 ${hour(t.recordedAt)}\n` +
        `🔽 Mín <b>${t1(t.tempMin)} °C</b>${lo ? ' ❗ bajo el mínimo' : ''} · 🔼 Máx <b>${t1(t.tempMax)} °C</b>${hi ? ' ❗ sobre el máximo' : ''}` +
        (th ? (out ? `\n📏 Rango permitido: ${th.min}–${th.max} °C` : ` ✅ en rango (${th.min}–${th.max} °C)`) : '') +
        `\n👤 Registró: ${esc(t.createdBy || '—')}` + (status ? `\n📋 Hoy: ${status}` : '')
    },
    evento: (e, accion) => {
      const edu = e.area === 'educacion'
      const kind = edu ? 'ACTIVIDAD DE EDUCACIÓN' : 'EVENTO / EMERGENCIA'
      const per = e.personnel || []
      if (accion !== 'finalizado') {
        return `${edu ? '📚' : '🚨'} <b>${kind} ${edu ? 'ABIERTA' : 'ABIERTO'}</b>\n${SEP}\n🆔 ${esc(e.code)} · ${esc(e.name)}\n📍 ${esc(e.place || '—')} · ${esc(e.siteName || '')}\n` +
          `🕒 ${when(e.startedAt)}\n👤 Coordinador: ${esc(e.coordinator?.fullName || '—')}` + (per.length ? `\n\n👥 <b>Personal (${per.length})</b>\n${people(per)}` : '')
      }
      const mats = e.materials || []; const sup = e.supplies || []
      const back = mats.reduce((a, m) => a + (m.returned == null ? 0 : Number(m.returned)), 0); const outQ = mats.reduce((a, m) => a + Number(m.quantity), 0)
      return `✅ <b>${edu ? 'ACTIVIDAD DE EDUCACIÓN FINALIZADA' : 'EVENTO FINALIZADO'}</b>\n${SEP}\n🆔 ${esc(e.code)} · ${esc(e.name)}\n` +
        `⏱️ Duración: ${dur(e.startedAt, e.endedAt) || '—'} (${hour(e.startedAt)} → ${hour(e.endedAt)})` +
        (per.length ? `\n\n👥 <b>Personal (${per.length})</b>\n${people(per)}` : '') +
        (mats.length ? `\n\n🧰 <b>Equipos:</b> ${n(outQ)} salieron · ${n(back)} regresaron\n` + mats.map((m) => ` • ${esc(m.item?.name || 'Equipo')} ×${n(m.quantity)} → regresó ${m.returned == null ? '—' : n(m.returned)}${m.state ? ` (${esc(m.state)})` : ''}`).join('\n') : '') +
        (sup.length ? `\n💊 <b>Insumos consumidos</b>\n${sup.map((x) => ` • ${esc(x.item?.name || 'Insumo')} ×${n(x.quantity, 2)}`).join('\n')}` : '') +
        (e.generalObservation ? `\n📝 Observación: ${esc(e.generalObservation)}` : '')
    },
    viaje: (t, accion, crew) => {
      const v = t.vehicle || {}
      if (accion !== 'cerrada') {
        return `🚗 <b>SALIDA DE VEHÍCULO</b>\n${SEP}\n🆔 ${esc(t.code)} · Móvil ${esc(v.movil || '—')} (${esc([v.vehicleType, v.plate].filter(Boolean).join(' '))})\n` +
          `👨‍✈️ Conductor: ${esc(t.driver?.name || '—')}\n🎯 Actividad: ${esc(t.event ? `${t.event.code} · ${t.event.name}` : (t.activity || '—'))}\n` +
          `📍 Km salida: ${n(t.kmOut)} · 🕒 ${hour(t.startedAt)}` +
          ((crew || []).length ? `\n\n👥 <b>Personal del servicio</b>\n${people(crew)}` : '')
      }
      return `🏁 <b>LLEGADA DE VEHÍCULO</b>\n${SEP}\n🆔 ${esc(t.code)} · Móvil ${esc(v.movil || '—')}\n👨‍✈️ ${esc(t.driver?.name || '—')} · ⏱️ ${dur(t.startedAt, t.endedAt) || '—'}\n` +
        `🛣️ Km: ${n(t.kmOut)} → ${n(t.kmIn)} (${n(t.kmDiff ?? (t.kmIn - t.kmOut))} km)` +
        (t.fuelValue ? `\n⛽ Combustible: $${n(t.fuelValue)}${t.fuelGallons ? ` · ${n(t.fuelGallons, 1)} gal` : ''}` : '') +
        (t.observation ? `\n📝 ${esc(t.observation)}` : '')
    },
    // Traslado asistencial: sin datos clínicos ni documento del paciente (solo iniciales), por protección de datos.
    traslado: (t, accion) => {
      const x = t.transfer || {}; const v = t.vehicle || {}
      const ini = String(x.patientName || '').split(/\s+/).filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ')
      const pri = { urgente: '🔴 Urgente', prioritario: '🟠 Prioritario', programado: '🟢 Programado' }[x.priority] || esc(x.priority || '—')
      const cond = { estable: 'Estable', inestable: 'Inestable', critico: 'Crítico' }[x.patientCondition]
      if (accion !== 'finalizado') {
        return `🚑 <b>TRASLADO ASISTENCIAL EN CURSO</b>\n${SEP}\n🆔 ${esc(t.code)} · Móvil ${esc(v.movil || '—')} (${esc(v.vehicleType || '')})\n` +
          `${pri} · ${x.transferType === 'secundario' ? 'Secundario' : 'Primario'}\n🧍 Paciente: ${esc(ini || '—')}${cond ? ` · ${cond}` : ''}\n` +
          `📍 ${esc(x.origin || '—')} → ${esc(x.destination || '—')}\n👨‍✈️ Conductor: ${esc(t.driver?.name || '—')}\n` +
          `👥 Acompañante: ${x.companionName ? 'sí' : 'no'}\n🕒 ${hour(t.startedAt)} · Km ${n(t.kmOut)}`
      }
      return `🏥 <b>TRASLADO ASISTENCIAL FINALIZADO</b>\n${SEP}\n🆔 ${esc(t.code)} · Móvil ${esc(v.movil || '—')} (${esc(v.vehicleType || '')})\n` +
        `🧍 Paciente: ${esc(ini || '—')} · 📍 ${esc(x.origin || '—')} → ${esc(x.destination || '—')}\n` +
        `👨‍✈️ ${esc(t.driver?.name || '—')} · ⏱️ ${dur(t.startedAt, t.endedAt) || '—'}\n🛣️ Km: ${n(t.kmOut)} → ${n(t.kmIn)} (${n(t.kmDiff ?? (t.kmIn - t.kmOut))} km)`
    },
    preoperacional: (r) => {
      const v = r.vehicle || {}
      const bad = (r.items || []).filter((i) => i.ok === false)
      const ok = !bad.length && r.driverFit !== false
      return `${ok ? '✅ <b>PREOPERACIONAL SIN NOVEDADES</b>' : '⚠️ <b>PREOPERACIONAL CON NOVEDADES</b>'}\n${SEP}\n` +
        `🆔 ${esc(r.code)} · Móvil ${esc(v.movil || '—')} (${esc([v.vehicleType, v.plate].filter(Boolean).join(' '))})\n` +
        `👨‍✈️ ${esc(r.driver?.name || '—')} · Km ${n(r.km)}` +
        (bad.length ? `\n❌ <b>Novedades (${bad.length})</b>\n${bad.map((i) => ` • ${esc(i.label)}: ${esc(i.observation || 'no cumple')}`).join('\n')}` : '') +
        `\n🩺 Conductor en condiciones: ${r.driverFit === false ? `<b>No</b>${r.driverFitObservation ? ` (${esc(r.driverFitObservation)})` : ''}` : 'Sí'}` +
        (r.generalObservation ? `\n📝 ${esc(r.generalObservation)}` : '')
    },
    // Inventario: encabezado + una viñeta por elemento con lo que se movió, el saldo y su estado.
    inventario: ({ title, head = [], lines = [] }) => `📦 <b>${esc(title)}</b>\n${SEP}\n` + head.filter(Boolean).map(esc).join('\n') +
      (lines.length ? `\n\n${lines.slice(0, 15).join('\n')}` : '') + (lines.length > 15 ? `\n… y ${lines.length - 15} elemento${lines.length - 15 === 1 ? '' : 's'} más` : '') + `\n🕒 ${when()}`
  }

  // Datos para los mensajes de inventario: movimientos de una referencia (traslado o entrega) o de un elemento.
  const MOV = 'type, quantity, stock_after, item:inventory_items(id, name, lot, unit, min_stock, expiry_date, warehouse:warehouses(name))'
  const itemName = (it) => `${esc(it?.name || 'Elemento')}${it?.lot ? ` (lote ${esc(it.lot)})` : ''}`
  const invLines = {
    // Entrega: −cantidad y lo que queda en la bodega.
    salida: (movs) => movs.map((m) => ` • ${itemName(m.item)}\n   ${signed(m.quantity)} ${esc(m.item?.unit || '')} · queda ${n(m.stock_after, 2)}${stockTag(m.stock_after, m.item?.min_stock, m.item?.expiry_date)}`),
    // Traslado: lo que sale de una bodega y lo que llega a la otra.
    traslado: (movs) => {
      const outs = movs.filter((m) => m.type === 'traslado_salida'); const ins = movs.filter((m) => m.type === 'traslado_entrada')
      return outs.map((o, i) => {
        const d = ins[i]
        return ` • ${itemName(o.item)}\n   ${signed(o.quantity)} en ${esc(o.item?.warehouse?.name || '')} (queda ${n(o.stock_after, 2)})${stockTag(o.stock_after, o.item?.min_stock, o.item?.expiry_date)}` +
          (d ? `\n   → +${n(Math.abs(d.quantity), 2)} en ${esc(d.item?.warehouse?.name || '')} (queda ${n(d.stock_after, 2)})` : '')
      })
    }
  }
  const byRef = async (ref) => (await supabase.from('inventory_movements').select(MOV).eq('transfer_ref', ref).order('id')).data || []
  const lastOf = async (itemId) => (await supabase.from('inventory_movements').select(MOV).eq('item_id', itemId).order('id', { ascending: false }).limit(1)).data?.[0]
  // Personal de un evento (para la salida de un vehículo asignado a ese servicio).
  const eventPeople = async (eventId) => {
    if (!eventId) return []
    const { data } = await supabase.from('gso_event_personnel').select('id, role_label, volunteers(first_name, last_name), usr:users!gso_event_personnel_user_id_fkey(name, last_name)').eq('event_id', eventId).order('id')
    return (data || []).map((p) => ({ fullName: p.volunteers ? `${p.volunteers.first_name} ${p.volunteers.last_name}` : p.usr ? `${p.usr.name} ${p.usr.last_name}` : '—', roleLabel: p.role_label }))
  }

  // ---------------------------------------------------------------- Configuración (administrador)
  app.get('/notificaciones', auth(ADMIN), gate, hx(async (req, res) => {
    const st = await loadSettings()
    const [{ data: chans }, { data: sites }] = await Promise.all([
      supabase.from('notification_channels').select('*, site:sites(name)').order('section').order('id'),
      supabase.from('sites').select('id, name, active').order('name')
    ])
    const { data: log } = await supabase.from('notification_log').select('*').order('created_at', { ascending: false }).limit(15)
    res.send({
      bot: { configured: Boolean(st?.bot_token), tokenMasked: mask(st?.bot_token), username: st?.bot_username || null, name: st?.bot_name || null, enabled: Boolean(st?.enabled) },
      sections: sectionsDTO(),
      sites: (sites || []).filter((x) => x.active !== false).map((x) => ({ id: x.id, name: x.name })),
      channels: (chans || []).map((c) => ({ id: c.id, section: c.section, siteId: c.site_id, siteName: c.site?.name ?? null, chatId: c.chat_id, title: c.title, enabled: c.enabled, available: Boolean(SECTIONS[c.section] && inPlan(SECTIONS[c.section].module)) })),
      log: (log || []).map((l) => ({ id: l.id, section: l.section, siteId: l.site_id, chatId: l.chat_id, status: l.status, detail: l.detail, createdAt: l.created_at }))
    })
  }))
  // Guardar el bot: valida el token con Telegram (getMe). Si no se envía token, solo cambia el interruptor.
  app.put('/notificaciones/bot', auth(ADMIN), gate, hx(async (req, res) => {
    const b = req.body || {}
    const cur = await loadSettings()
    const row = { enabled: Boolean(b.enabled), updated_at: new Date().toISOString() }
    const token = clean(b.token)
    if (token) {
      if (!tokenOk(token)) return fail(res, 'El token no tiene el formato de @BotFather (números:letras)', 400)
      const me = await tg(token, 'getMe')
      Object.assign(row, { bot_token: token, bot_username: me.username, bot_name: me.first_name })
    } else if (!cur?.bot_token && row.enabled) return fail(res, 'Primero pega el token del bot', 400)
    const { error } = cur ? await supabase.from('notification_settings').update(row).not('org_id', 'is', null) : await supabase.from('notification_settings').insert(row)
    if (error) throw error
    res.send({ ok: true })
  }))
  // Buscar grupos: grupos donde está el bot (según las actualizaciones recientes de Telegram).
  app.post('/notificaciones/buscar-grupos', auth(ADMIN), gate, hx(async (req, res) => {
    const st = await loadSettings()
    if (!st?.bot_token) return fail(res, 'Primero guarda el token del bot', 400)
    const ups = await tg(st.bot_token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member', 'channel_post'] })
    const found = new Map()
    for (const u of ups || []) {
      const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat
      if (!chat || !['group', 'supergroup', 'channel'].includes(chat.type)) continue
      const left = u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)
      if (left) { found.delete(String(chat.id)); continue }
      found.set(String(chat.id), { chatId: String(chat.id), title: chat.title || 'Grupo sin nombre', type: chat.type })
    }
    res.send({ groups: [...found.values()] })
  }))
  app.post('/notificaciones/canales', auth(ADMIN), gate, hx(async (req, res) => {
    const b = req.body || {}
    if (!SECTIONS[b.section]) return fail(res, 'Sección inválida', 400)
    if (!inPlan(SECTIONS[b.section].module)) return fail(res, `Tu plan no incluye el módulo de ${SECTIONS[b.section].label}`, 403)
    const chatId = String(b.chatId || '').trim()
    if (!/^-?\d{5,20}$/.test(chatId)) return fail(res, 'Grupo inválido', 400)
    let siteId = null
    if (b.siteId && b.siteId !== 'todas') {
      const { data: site } = await supabase.from('sites').select('id').eq('id', Number(b.siteId)).maybeSingle()
      if (!site) return fail(res, 'Sede inválida', 400)
      siteId = site.id
    }
    const { data, error } = await supabase.from('notification_channels').insert({ section: b.section, site_id: siteId, chat_id: chatId, title: clean(b.title)?.slice(0, 120) ?? null }).select('*').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ese grupo ya está asignado a esta sección y sede', 409); throw error }
    res.status(201).send({ id: data.id })
  }))
  app.put('/notificaciones/canales/:id', auth(ADMIN), gate, hx(async (req, res) => {
    const { data, error } = await supabase.from('notification_channels').update({ enabled: Boolean(req.body?.enabled) }).eq('id', Number(req.params.id)).select('id').maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 'Grupo no encontrado', 404)
    res.send({ ok: true })
  }))
  app.delete('/notificaciones/canales/:id', auth(ADMIN), gate, hx(async (req, res) => {
    const { error } = await supabase.from('notification_channels').delete().eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))
  app.post('/notificaciones/canales/:id/prueba', auth(ADMIN), gate, hx(async (req, res) => {
    const st = await loadSettings()
    if (!st?.bot_token) return fail(res, 'Primero guarda el token del bot', 400)
    const { data: c } = await supabase.from('notification_channels').select('*').eq('id', Number(req.params.id)).maybeSingle()
    if (!c) return fail(res, 'Grupo no encontrado', 404)
    await tg(st.bot_token, 'sendMessage', { chat_id: c.chat_id, parse_mode: 'HTML', text: `✅ <b>Prueba de Integra IPS</b>\nEste grupo recibirá las notificaciones de <b>${esc(SECTIONS[c.section]?.label || c.section)}</b>.\nEnviada por ${esc(`${req.user.name} ${req.user.last_name}`.trim())} · ${when()}` })
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Mis notificaciones (cualquier usuario)
  // Cada usuario ve los grupos de Telegram que le corresponden (secciones de sus módulos y su sede; estudiantes y docentes,
  // además, los grupos de sus grupos académicos) y pide un enlace personal para unirse (un uso, válido 24 horas).
  // El bot debe ser administrador del grupo con permiso para invitar.
  const myChats = async (u) => {
    const out = []
    const mods = userModules ? userModules(u) : []
    if (!['estudiante', 'docente'].includes(u.role)) {
      const { data: chans } = await supabase.from('notification_channels').select('*, site:sites(name)').eq('enabled', true).order('section')
      for (const c of chans || []) {
        const sec = SECTIONS[c.section]
        if (!sec || !inPlan(sec.module) || !(u.role === 'administrador' || mods.includes(sec.module))) continue
        if (u.role !== 'administrador' && c.site_id && u.site_id && Number(c.site_id) !== Number(u.site_id)) continue
        if (out.some((x) => x.chatId === c.chat_id)) continue
        out.push({ key: `c${c.id}`, chatId: c.chat_id, title: c.title || sec.label, kind: 'seccion', label: sec.label, hint: sec.hint, site: c.site?.name || 'Todas las sedes' })
      }
    }
    let groupIds = []
    if (u.role === 'estudiante') {
      const { data: st } = await supabase.from('edu_students').select('id').eq('user_id', u.id).maybeSingle()
      if (st) { const { data: enr } = await supabase.from('edu_enrollments').select('group_id').eq('student_id', st.id).in('status', ['matriculado', 'aplazado']); groupIds = (enr || []).map((e) => e.group_id).filter(Boolean) }
    } else if (u.role === 'docente') {
      const { data: ses } = await supabase.from('edu_sessions').select('group_id').eq('teacher_user_id', u.id)
      groupIds = (ses || []).map((x) => x.group_id)
    }
    groupIds = [...new Set(groupIds)]
    if (groupIds.length) {
      const { data: gs } = await supabase.from('edu_groups').select('id, code, telegram_chat_id, telegram_title, program:edu_programs(name)').in('id', groupIds).not('telegram_chat_id', 'is', null)
      for (const g of gs || []) out.push({ key: `g${g.id}`, chatId: g.telegram_chat_id, title: g.telegram_title || `Grupo ${g.code}`, kind: 'grupo', label: `${g.program?.name || 'Educación'} · grupo ${g.code}`, hint: 'Clases programadas, cambios, cancelaciones, recordatorios, talleres y material nuevo de tu grupo', site: null })
    }
    return out
  }
  app.get('/mis-notificaciones', auth(), gate, hx(async (req, res) => {
    const st = await loadSettings()
    if (!st?.bot_token || !st.enabled) return res.send({ enabled: false, items: [] })
    const items = await myChats(req.user)
    // ¿Ya está el usuario en el grupo? Solo si tiene vinculado su Telegram (no aplica); se indica si el bot puede invitar.
    let botId = null
    try { botId = (await tg(st.bot_token, 'getMe')).id } catch { /* sin conexión */ }
    const withState = await Promise.all(items.map(async ({ chatId, ...x }) => {
      let canInvite = null
      if (botId) { try { const m = await tg(st.bot_token, 'getChatMember', { chat_id: chatId, user_id: botId }); canInvite = m.status === 'creator' || (m.status === 'administrator' && m.can_invite_users !== false) } catch { canInvite = false } }
      return { ...x, canInvite }
    }))
    res.send({ enabled: true, bot: st.bot_username ? `@${st.bot_username}` : null, items: withState })
  }))
  app.post('/mis-notificaciones/:key/unirme', auth(), gate, hx(async (req, res) => {
    const st = await loadSettings()
    if (!st?.bot_token || !st.enabled) return fail(res, 'Las notificaciones de Telegram no están activas', 400)
    const item = (await myChats(req.user)).find((x) => x.key === req.params.key)
    if (!item) return fail(res, 'Ese grupo no está disponible para ti', 404)
    try {
      const link = await tg(st.bot_token, 'createChatInviteLink', { chat_id: item.chatId, name: `${req.user.name || ''} ${req.user.last_name || ''}`.trim().slice(0, 32) || 'Integra', member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 86400 })
      res.send({ link: link.invite_link, expiresIn: '24 horas' })
    } catch (e) {
      fail(res, 'El bot no puede crear la invitación: pide al administrador que haga al bot administrador del grupo con permiso para invitar usuarios.', 409)
    }
  }))

  return { notify, toChat, findGroups, esc, messages, SECTIONS, byRef, lastOf, eventPeople, invLines, stockTag, signed }
}
