// =====================================================================
// Notificaciones por Telegram
// · Cada organización configura su bot (token de @BotFather) y uno o más grupos por sección.
// · Secciones: temperatura, eventos y emergencias (socorro), vehicular (actividad y preoperacional) y educación.
// · Cada grupo pertenece a una sede: solo recibe los avisos de esa sede (sin sede = todas, para la dirección).
// · Una sección solo se puede configurar y notificar si su módulo está en el plan de la organización.
// · El envío nunca bloquea ni hace fallar el registro que lo origina (se ejecuta en segundo plano).
// =====================================================================
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, inPlan, hasFeature, TZ } = deps
  const SECTIONS = {
    temperatura: { label: 'Registro de temperatura', module: 'temperatura', hint: 'Cada lectura registrada y las que quedan fuera de rango' },
    socorro: { label: 'Eventos y emergencias', module: 'socorro', hint: 'Apertura y cierre de eventos y emergencias' },
    vehicular: { label: 'Vehicular', module: 'flota', hint: 'Actividad vehicular (salida y cierre) y preoperacional' },
    educacion: { label: 'Actividades de educación', module: 'educacion', hint: 'Apertura y cierre de actividades de educación' }
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
    if (!j.ok) throw httpError(400, `Telegram: ${j.description || `error ${r.status}`}`)
    return j.result
  }
  const loadSettings = async () => (await supabase.from('notification_settings').select('*').maybeSingle()).data
  const sectionsDTO = () => Object.entries(SECTIONS).map(([key, s]) => ({ key, label: s.label, hint: s.hint, module: s.module, available: inPlan(s.module) }))

  // Envío (en segundo plano, en el contexto de la organización de la petición).
  const send = async (section, html, siteId) => {
    if (!SECTIONS[section] || !featureOn() || !inPlan(SECTIONS[section].module)) return
    const st = await loadSettings()
    if (!st?.enabled || !st.bot_token) return
    let q = supabase.from('notification_channels').select('chat_id, title, site_id').eq('section', section).eq('enabled', true)
    q = siteId ? q.or(`site_id.is.null,site_id.eq.${Number(siteId)}`) : q.is('site_id', null)
    const { data: chans } = await q
    for (const c of chans || []) {
      let status = 'enviado'; let detail = null
      try { await tg(st.bot_token, 'sendMessage', { chat_id: c.chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
      await supabase.from('notification_log').insert({ section, chat_id: c.chat_id, status, detail, site_id: siteId || null })
    }
  }
  const notify = (section, html, siteId) => { send(section, html, siteId).catch((e) => console.error('Telegram:', e.message)) }
  const when = (iso) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(iso ? new Date(iso) : new Date())

  // Mensajes de cada evento del sistema.
  const messages = {
    temperatura: (t, th) => {
      const out = th && (t.tempMax > th.max || t.tempMin < th.min)
      return `${out ? '⚠️ <b>Temperatura fuera de rango</b>' : '🌡️ <b>Registro de temperatura</b>'}\n` +
        `Sede: ${esc(t.siteName || '—')}\nLectura: ${esc(t.slotLabel || t.shiftLabel || '')}\n` +
        `Mínima: <b>${t.tempMin} °C</b> · Máxima: <b>${t.tempMax} °C</b>${th ? `\nRango permitido: ${th.min}–${th.max} °C` : ''}\n` +
        `Registró: ${esc(t.createdBy || '—')} · ${when(t.recordedAt)}`
    },
    evento: (e, accion) => `${e.area === 'educacion' ? '📚' : '🚨'} <b>${e.area === 'educacion' ? 'Actividad de educación' : 'Evento / emergencia'} ${accion}</b>\n` +
      `${esc(e.code)} · ${esc(e.name)}\nLugar: ${esc(e.place || '—')}\nSede: ${esc(e.siteName || '—')}` +
      `${e.coordinator ? `\nCoordinador: ${esc(e.coordinator.fullName || `${e.coordinator.firstName || ''} ${e.coordinator.lastName || ''}`.trim())}` : ''}\n${when(accion === 'finalizado' ? e.endedAt : e.startedAt)}`,
    viaje: (t, accion) => `🚑 <b>Actividad vehicular ${accion}</b>\n${esc(t.code)} · Móvil ${esc(t.vehicle?.movil || '—')} (${esc(t.vehicle?.plate || '')})\n` +
      `Conductor: ${esc(t.driver?.name || '—')}\nActividad: ${esc(t.activity || '—')}${t.event ? `\nEvento: ${esc(t.event.code)} · ${esc(t.event.name)}` : ''}\n` +
      (accion === 'cerrada' ? `Km: ${t.kmOut} → ${t.kmIn ?? '—'} (${t.kmDiff ?? '—'} km)\n${when(t.endedAt)}` : `Km de salida: ${t.kmOut}\n${when(t.startedAt)}`),
    preoperacional: (r) => `${r.result === 'no_apto' || (r.anomalies || 0) > 0 ? '⚠️' : '✅'} <b>Preoperacional</b> ${esc(r.code)}\n` +
      `Móvil ${esc(r.vehicle?.movil || '—')} (${esc(r.vehicle?.plate || '')}) · ${esc(r.siteName || '')}\nConductor: ${esc(r.driver?.name || '—')}\n` +
      `Resultado: <b>${esc(r.result || '—')}</b>${r.anomalies ? ` · ${r.anomalies} novedad${r.anomalies === 1 ? '' : 'es'}` : ''}\nKm: ${r.km}\n${when(r.inspectedAt)}`
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

  return { notify, messages, SECTIONS }
}
