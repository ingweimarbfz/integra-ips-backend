// =====================================================================
// Recordatorios de la siguiente dosis de vacuna (correo y WhatsApp), N días antes (por defecto 8).
// · Se ejecuta solo una vez al día a la hora configurada (y a demanda desde la pantalla).
// · Modo prueba: solo se envía a los celulares y correos autorizados; el resto queda "omitido".
// · Correo: SMTP del servidor. WhatsApp: API oficial de WhatsApp Business (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
//   y opcionalmente WHATSAPP_TEMPLATE); sin API queda "manual" con el enlace wa.me listo para enviar.
// =====================================================================
const tenant = require('./tenant')
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, todayBogota, getSettings, share, TZ } = deps
  const STAFF = ['administrador', 'empleado']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const addDays = (iso, d) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }
  const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
  const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
  const longDate = (iso) => { const d = new Date(`${iso}T12:00:00Z`); return `${DAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}` }
  const digits = (p) => String(p || '').replace(/\D/g, '')
  const waNumber = (p) => { const d = digits(p); return d.length === 10 ? `57${d}` : d }
  const waReady = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID)
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  const loadConfig = async () => (await supabase.from('vaccination_reminder_settings').select('*').maybeSingle()).data
  const cfgDTO = (c) => ({ enabled: c.enabled, daysBefore: c.days_before, sendEmail: c.send_email, sendWhatsapp: c.send_whatsapp, runHour: c.run_hour, testMode: c.test_mode, testPhones: c.test_phones || [], testEmails: c.test_emails || [], officeHours: c.office_hours, lastRunOn: c.last_run_on })

  // Recordatorio por enviar: la última dosis de cada paciente y biológico con la siguiente dosis en los próximos N días.
  const dueRecords = async (cfg, onlyRecord) => {
    const t = todayBogota()
    let q = supabase.from('vaccination_records').select('id, site_id, applied_on, patient_doc_number, names, surnames, phone, email, vaccine_id, dose_label, next_dose_date, next_dose_label, vaccine:vaccines(name), site:sites(name, address, phone, municipality)')
    q = onlyRecord ? q.eq('id', onlyRecord) : q.gte('next_dose_date', t).lte('next_dose_date', addDays(t, cfg.days_before))
    const { data, error } = await q
    if (error) throw error
    if (!data.length) return []
    const { data: later } = await supabase.from('vaccination_records').select('id, patient_doc_number, vaccine_id, applied_on').in('patient_doc_number', [...new Set(data.map((r) => r.patient_doc_number))])
    return data.filter((r) => !(later || []).some((x) => x.patient_doc_number === r.patient_doc_number && x.vaccine_id === r.vaccine_id && (x.applied_on > r.applied_on || (x.applied_on === r.applied_on && x.id > r.id))))
  }

  // ---------------------------------------------------------------- Mensajes
  const buildMessages = async (r, cfg) => {
    const s = await getSettings()
    const first = String(r.names || '').split(' ')[0]
    const link = await share.linkFor('carnet', r.patient_doc_number, r.site_id, null)
    const base = (process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN?.split(',')[0] || '').replace(/\/$/, '')
    const url = `${base}/p/${link.token}`
    const place = [r.site?.name, r.site?.address, r.site?.municipality].filter(Boolean).join(' · ')
    const phone = r.site?.phone
    const when = longDate(r.next_dose_date)
    const whatsapp = [
      `💉 *Recordatorio de vacunación*`,
      ``,
      `Hola, *${first}* 👋`,
      `Te recordamos que el *${when}* te corresponde la *${(r.next_dose_label || 'siguiente dosis').toLowerCase()} dosis* de *${r.vaccine?.name}*.`,
      ``,
      `📍 *Dónde:* ${place || s.ipsName}`,
      cfg.office_hours ? `🕗 *Horario:* ${cfg.office_hours}` : null,
      `🪪 *Trae:* tu documento de identidad y tu carnet de vacunación.`,
      ``,
      `📄 Tu carnet: ${url}`,
      ``,
      phone ? `¿Necesitas reprogramar? Llámanos al ${phone} o responde este mensaje.` : `¿Necesitas reprogramar? Responde este mensaje.`,
      ``,
      `_${s.ipsName}_`
    ].filter((x) => x !== null).join('\n')
    const color = s.primaryColor || '#D7282F'
    const subject = `Recordatorio: ${r.next_dose_label || 'siguiente'} dosis de ${r.vaccine?.name} el ${when}`
    const row = (icon, label, value) => `<tr><td style="padding:6px 0;width:28px;font-size:18px;vertical-align:top">${icon}</td><td style="padding:6px 0;color:#475569;font-size:14px"><b style="color:#0F172A">${label}</b><br>${value}</td></tr>`
    const emailHtml = `<!doctype html><html><body style="margin:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.08)">
<tr><td style="background:${color};padding:18px 24px;color:#fff">
  ${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="${esc(s.ipsName)}" style="max-height:44px;background:#fff;border-radius:8px;padding:4px 8px;margin-bottom:10px"><br>` : ''}
  <span style="font-size:13px;opacity:.9">Recordatorio de vacunación</span><br>
  <span style="font-size:22px;font-weight:bold">Tu próxima dosis es el ${esc(when)}</span>
</td></tr>
<tr><td style="padding:22px 24px">
  <p style="margin:0 0 14px;font-size:15px;color:#0F172A">Hola, <b>${esc(first)}</b>:</p>
  <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.5">Te recordamos que te corresponde la <b>${esc((r.next_dose_label || 'siguiente').toLowerCase())} dosis</b> de <b>${esc(r.vaccine?.name)}</b>. Completar el esquema te protege a ti y a tu familia.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#F8FAFC;border-radius:10px;padding:8px 14px">
    ${row('📅', 'Fecha', esc(when))}
    ${row('📍', 'Dónde', esc(place || s.ipsName))}
    ${cfg.office_hours ? row('🕗', 'Horario', esc(cfg.office_hours)) : ''}
    ${row('🪪', 'Qué llevar', 'Tu documento de identidad y tu carnet de vacunación')}
  </table>
  <p style="text-align:center;margin:22px 0 8px"><a href="${esc(url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Ver mi carnet de vacunación</a></p>
  <p style="margin:14px 0 0;font-size:13px;color:#64748B;text-align:center">${phone ? `¿Necesitas reprogramar? Llámanos al <b>${esc(phone)}</b>.` : '¿Necesitas reprogramar? Responde este correo.'}</p>
</td></tr>
<tr><td style="background:#F8FAFC;padding:14px 24px;font-size:11px;color:#94A3B8;text-align:center">${esc(s.ipsName)} · Recibes este mensaje porque te vacunaste con nosotros. Tus datos se tratan según la Ley 1581 de 2012.</td></tr>
</table></td></tr></table></body></html>`
    return { whatsapp, waLink: `https://wa.me/${waNumber(r.phone)}?text=${encodeURIComponent(whatsapp)}`, subject, emailHtml, url, when }
  }

  // ---------------------------------------------------------------- Envío
  const allowed = (cfg, channel, recipient) => !cfg.test_mode || (channel === 'correo' ? (cfg.test_emails || []).map((x) => x.toLowerCase()).includes(String(recipient).toLowerCase()) : (cfg.test_phones || []).map(digits).includes(digits(recipient)))
  const sendWhatsappApi = async (to, text, r, m) => {
    const tpl = process.env.WHATSAPP_TEMPLATE
    // Fuera de la ventana de 24 h, Meta solo permite mensajes con plantilla aprobada.
    const body = tpl
      ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es' }, components: [{ type: 'body', parameters: [String(r.names || '').split(' ')[0], `${r.next_dose_label} dosis de ${r.vaccine?.name}`, m.when, m.url].map((t) => ({ type: 'text', text: t })) }] } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } }
    const resp = await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!resp.ok) throw new Error(`WhatsApp ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const record = (row) => supabase.from('vaccination_reminders').upsert(row, { onConflict: 'record_id,channel,due_date' })
  const run = async (opts = {}) => {
    const cfg = await loadConfig()
    // Interruptor general: apagado no se envía nada (ni automático ni a demanda).
    if (!cfg.enabled) throw httpError(409, 'El envío general de recordatorios está desactivado: actívalo en la configuración para enviar')
    const recs = await dueRecords(cfg, opts.recordId)
    const out = []
    for (const r of recs) {
      const { data: done } = await supabase.from('vaccination_reminders').select('channel, status').eq('record_id', r.id).eq('due_date', r.next_dose_date)
      const m = await buildMessages(r, cfg)
      const channels = [cfg.send_email && 'correo', cfg.send_whatsapp && 'whatsapp'].filter(Boolean)
      for (const ch of channels) {
        if (!opts.force && (done || []).some((d) => d.channel === ch && ['enviado', 'manual'].includes(d.status))) continue
        const recipient = ch === 'correo' ? r.email : r.phone
        const base = { record_id: r.id, channel: ch, due_date: r.next_dose_date, recipient: recipient || null }
        let status; let detail = null
        if (!recipient) status = 'sin_contacto'
        else if (!allowed(cfg, ch, recipient)) { status = 'omitido'; detail = 'Modo prueba: destinatario no autorizado' }
        else if (ch === 'correo') {
          if (!share.smtpReady()) { status = 'sin_configurar'; detail = 'Falta configurar el correo del servidor (SMTP)' } else {
            try { await share.mailer().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: recipient, subject: m.subject, html: m.emailHtml, text: m.whatsapp.replace(/[*_]/g, '') }); status = 'enviado' } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
          }
        } else if (waReady()) {
          try { await sendWhatsappApi(waNumber(recipient), m.whatsapp, r, m); status = 'enviado' } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
        } else { status = 'manual'; detail = m.waLink }
        await record({ ...base, status, detail, sent_at: status === 'enviado' ? new Date().toISOString() : null })
        out.push({ recordId: r.id, patient: `${r.names} ${r.surnames || ''}`.trim(), channel: ch, status })
      }
    }
    if (!opts.recordId) await supabase.from('vaccination_reminder_settings').update({ last_run_on: todayBogota() })
    return out
  }

  // Tarea diaria: revisa cada 15 minutos y ejecuta una vez al día desde la hora configurada (hora de Colombia).
  const planOn = () => !deps.hasFeature || deps.hasFeature('recordatorios_vacunas')
  const tick = async () => {
    if (!planOn()) return
    try {
      const cfg = await loadConfig()
      if (!cfg?.enabled) return // envío general apagado
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date())) % 24
      if (hour >= cfg.run_hour && cfg.last_run_on !== todayBogota()) await run()
    } catch (e) { console.error('Recordatorios de vacunación:', e.message) }
  }
  const tickAll = () => tenant.forEachOrg(supabase, tick)
  setTimeout(tickAll, 20000)
  setInterval(tickAll, 15 * 60000).unref()

  // ---------------------------------------------------------------- API
  app.get('/vacunacion/recordatorios', auth(STAFF), hx(async (req, res) => {
    const cfg = await loadConfig()
    const { data, error } = await supabase.from('vaccination_reminders').select('*, record:vaccination_records(id, site_id, names, surnames, patient_doc_number, next_dose_label, next_dose_date, vaccine:vaccines(name))').order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    res.send({
      config: cfgDTO(cfg), planIncluded: planOn(), channels: { email: share.smtpReady(), whatsapp: waReady() },
      items: data.map((x) => ({ id: x.id, recordId: x.record_id, channel: x.channel, dueDate: x.due_date, recipient: x.recipient, status: x.status, detail: x.detail, sentAt: x.sent_at, createdAt: x.created_at, patient: `${x.record?.names || ''} ${x.record?.surnames || ''}`.trim(), docNumber: x.record?.patient_doc_number, vaccine: x.record?.vaccine?.name, dose: x.record?.next_dose_label }))
    })
  }))
  app.put('/vacunacion/recordatorios/config', auth(ADMIN), hx(async (req, res) => {
    if (!planOn()) return fail(res, 'Tu plan no incluye los recordatorios automáticos de próxima dosis. Consulta las opciones de plan.', 403)
    const b = req.body || {}
    const days = Number(b.daysBefore); const hour = Number(b.runHour)
    if (!(days >= 1 && days <= 60)) return fail(res, 'Los días de anticipación deben estar entre 1 y 60', 400)
    if (!(hour >= 0 && hour <= 23)) return fail(res, 'Hora inválida', 400)
    const phones = (Array.isArray(b.testPhones) ? b.testPhones : []).map(digits).filter((x) => x.length >= 10)
    const emails = (Array.isArray(b.testEmails) ? b.testEmails : []).map((x) => clean(x)?.toLowerCase()).filter((x) => x && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
    const { data, error } = await supabase.from('vaccination_reminder_settings').update({ enabled: Boolean(b.enabled), days_before: days, send_email: Boolean(b.sendEmail), send_whatsapp: Boolean(b.sendWhatsapp), run_hour: hour, test_mode: b.testMode !== false, test_phones: phones, test_emails: emails, office_hours: clean(b.officeHours), updated_at: new Date().toISOString() }).select('*').single()
    if (error) throw error
    res.send(cfgDTO(data))
  }))
  app.put('/vacunacion/recordatorios/envio-general', auth(ADMIN), hx(async (req, res) => {
    if (!planOn()) return fail(res, 'Tu plan no incluye los recordatorios automáticos de próxima dosis. Consulta las opciones de plan.', 403)
    const { data, error } = await supabase.from('vaccination_reminder_settings').update({ enabled: Boolean(req.body?.enabled), updated_at: new Date().toISOString() }).select('*').single()
    if (error) throw error
    res.send(cfgDTO(data))
  }))
  app.post('/vacunacion/recordatorios/ejecutar', auth(ADMIN), hx(async (req, res) => (!planOn() ? fail(res, 'Tu plan no incluye los recordatorios automáticos de próxima dosis. Consulta las opciones de plan.', 403) : res.send({ results: await run({ recordId: Number(req.body?.recordId) || null, force: Boolean(req.body?.force) }) }))))
  app.get('/vacunacion/recordatorios/vista-previa/:recordId', auth(STAFF), hx(async (req, res) => {
    const cfg = await loadConfig()
    const [r] = await dueRecords({ ...cfg, days_before: 3650 }, Number(req.params.recordId))
    if (!r || !r.next_dose_date) throw httpError(404, 'Ese registro no tiene una siguiente dosis pendiente')
    const m = await buildMessages(r, cfg)
    res.send({ patient: `${r.names} ${r.surnames || ''}`.trim(), phone: r.phone, email: r.email, whatsapp: m.whatsapp, waLink: m.waLink, subject: m.subject, emailHtml: m.emailHtml })
  }))
  // WhatsApp manual: quien atiende abrió el enlace y envió el mensaje.
  app.post('/vacunacion/recordatorios/:id/enviado', auth(STAFF), hx(async (req, res) => {
    const { error } = await supabase.from('vaccination_reminders').update({ status: 'enviado', sent_at: new Date().toISOString() }).eq('id', Number(req.params.id))
    if (error) throw error
    res.send({ ok: true })
  }))
}
