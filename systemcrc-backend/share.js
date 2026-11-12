// =====================================================================
// Compartir documentos con el paciente: carnet de vacunación y facturas.
// · Se genera un enlace privado (token aleatorio, vence en 30 días) a una vista pública de solo lectura.
// · Envío por correo (SMTP configurado en el servidor) y por WhatsApp (enlace wa.me con el mensaje listo).
// · Cada envío queda registrado (canal, destinatario, quién lo envió).
// Variables de entorno: PUBLIC_APP_URL (URL del sistema), SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// =====================================================================
const crypto = require('crypto')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, canAccessSite, getSettings, billing, vaccination } = deps
  const STAFF = ['administrador', 'empleado']
  const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
  const DAYS = 30
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const smtpReady = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  let transport = null
  const mailer = () => {
    if (!transport) {
      const nodemailer = require('nodemailer')
      const port = Number(process.env.SMTP_PORT || 587)
      transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
    }
    return transport
  }
  const appUrl = (req) => (process.env.PUBLIC_APP_URL || req.headers.origin || '').replace(/\/$/, '')
  const LABEL = { carnet: 'carnet de vacunación', factura: 'factura' }

  // Valida que el documento exista y que el usuario tenga acceso; devuelve sus datos y el contacto sugerido.
  const resolveDoc = async (req, kind, ref) => {
    if (kind === 'carnet') {
      const doc = String(ref || '').replace(/[^\dA-Za-z]/g, '')
      const records = await vaccination.history(doc)
      if (!records.length) throw httpError(404, 'No hay vacunas registradas para ese documento')
      const last = records[records.length - 1]
      if (req && last.siteId && !records.some((r) => canAccessSite(req, r.siteId))) throw httpError(403, 'No tienes acceso a ese carnet')
      return { ref: doc, siteId: last.siteId, name: last.patient, phone: last.phone, email: last.email, title: `Carnet de vacunación · ${last.patient}`, data: { patient: last, records } }
    }
    if (kind === 'factura') {
      const c = await billing.getCharge(ref)
      if (!c || !c.numFactura) throw httpError(404, 'Factura no encontrada')
      if (req && c.siteId && !canAccessSite(req, c.siteId)) throw httpError(403, 'No tienes acceso a esa factura')
      return { ref: String(c.id), siteId: c.siteId, name: c.payer?.name || c.paciente, phone: c.payer?.phone || null, email: c.payer?.email || null, title: `Factura ${c.numFactura}`, data: c }
    }
    throw httpError(400, 'Documento inválido')
  }
  const getOrCreateShare = async (req, kind, doc) => linkFor(kind, doc.ref, doc.siteId, req?.user?.id ?? null)
  // Enlace privado vigente (o uno nuevo) para un documento; también lo usan los recordatorios automáticos.
  const linkFor = async (kind, ref, siteId, userId) => {
    const now = new Date().toISOString()
    const { data: found } = await supabase.from('document_shares').select('token, expires_at').eq('kind', kind).eq('ref', ref).gt('expires_at', new Date(Date.now() + 86400000).toISOString()).order('created_at', { ascending: false }).limit(1)
    if (found?.[0]) return found[0]
    const token = crypto.randomBytes(24).toString('base64url')
    const expires = new Date(Date.now() + DAYS * 86400000).toISOString()
    const { error } = await supabase.from('document_shares').insert({ token, kind, ref, site_id: siteId || null, created_by: userId, created_at: now, expires_at: expires })
    if (error) throw error
    return { token, expires_at: expires }
  }
  const logSend = (token, channel, recipient, user, status = 'enviado', error = null) => supabase.from('document_sends').insert({ token, channel, recipient, created_by: user, status, error })

  // Enlace privado + datos de contacto sugeridos para el envío.
  const sendOff = () => deps.hasFeature && !deps.hasFeature('envio_documentos')
  app.post('/compartir', auth(STAFF), hx(async (req, res) => {
    if (sendOff()) return fail(res, 'Tu plan no incluye el envío de documentos por correo y WhatsApp. Consulta las opciones de plan.', 403)
    const { kind, ref } = req.body || {}
    const doc = await resolveDoc(req, kind, ref)
    const share = await getOrCreateShare(req, kind, doc)
    const url = `${appUrl(req)}/p/${share.token}`
    const settings = await getSettings()
    const message = `Hola ${doc.name || ''}. ${settings.ipsName} le comparte su ${LABEL[kind]}: ${url} (enlace válido hasta ${share.expires_at.slice(0, 10).split('-').reverse().join('/')}).`
    res.send({ token: share.token, url, expiresAt: share.expires_at, title: doc.title, contact: { name: doc.name, phone: doc.phone, email: doc.email }, message, emailConfigured: smtpReady() })
  }))
  // Registro de un envío por WhatsApp o enlace copiado (el envío lo hace el navegador).
  app.post('/compartir/:token/registro', auth(STAFF), hx(async (req, res) => {
    const channel = ['whatsapp', 'enlace'].includes(req.body?.channel) ? req.body.channel : 'enlace'
    await logSend(req.params.token, channel, clean(req.body?.recipient), req.user.id)
    res.send({ ok: true })
  }))
  // Envío por correo desde el servidor.
  app.post('/compartir/correo', auth(STAFF), hx(async (req, res) => {
    if (sendOff()) return fail(res, 'Tu plan no incluye el envío de documentos por correo y WhatsApp. Consulta las opciones de plan.', 403)
    const { kind, ref } = req.body || {}
    const email = clean(req.body?.email)?.toLowerCase()
    if (!email || !EMAIL_RE.test(email)) return fail(res, 'Escribe un correo válido', 400)
    if (!smtpReady()) return fail(res, 'El servidor no tiene configurado el correo (SMTP). Usa "Abrir en mi correo" o configura SMTP_HOST, SMTP_USER y SMTP_PASS.', 503)
    const doc = await resolveDoc(req, kind, ref)
    const share = await getOrCreateShare(req, kind, doc)
    const url = `${appUrl(req)}/p/${share.token}`
    const s = await getSettings()
    const color = s.primaryColor || '#D7282F'
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1C1530">
      ${s.logoUrl ? `<img src="${s.logoUrl}" alt="${s.ipsName}" style="max-height:56px;margin-bottom:12px">` : ''}
      <h2 style="margin:0 0 8px">${doc.title}</h2>
      <p>Hola ${doc.name || ''},</p>
      <p>${s.ipsName} le comparte su ${LABEL[kind]}. Puede verlo, imprimirlo o guardarlo en PDF desde este enlace:</p>
      <p><a href="${url}" style="display:inline-block;background:${color};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Ver ${LABEL[kind]}</a></p>
      <p style="font-size:12px;color:#666">El enlace es personal y vence el ${share.expires_at.slice(0, 10).split('-').reverse().join('/')}. Si usted no solicitó este documento, ignore este mensaje.</p>
      <p style="font-size:11px;color:#999">Sus datos se tratan según la Ley 1581 de 2012 (Habeas Data).</p></div>`
    try {
      await mailer().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email, subject: `${doc.title} · ${s.shortName || s.ipsName}`, html, text: `${doc.title}\n\n${s.ipsName} le comparte su ${LABEL[kind]}: ${url}` })
      await logSend(share.token, 'correo', email, req.user.id)
      res.send({ ok: true })
    } catch (e) {
      await logSend(share.token, 'correo', email, req.user.id, 'error', e.message)
      fail(res, `No se pudo enviar el correo: ${e.message}`, 502)
    }
  }))

  // Vista pública (sin sesión) del documento compartido. Solo lectura, con fecha de vencimiento.
  app.get('/publico/documento/:token', hx(async (req, res) => {
    const { data: share } = await supabase.from('document_shares').select('*').eq('token', String(req.params.token || '')).maybeSingle()
    if (!share) throw httpError(404, 'El enlace no existe')
    if (share.expires_at < new Date().toISOString()) throw httpError(410, 'El enlace venció: solicite uno nuevo a la IPS')
    const doc = await resolveDoc(null, share.kind, share.ref)
    await supabase.from('document_shares').update({ views: (share.views || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('token', share.token)
    const s = await getSettings()
    let dian = null
    if (share.kind === 'factura') {
      const t = await billing.loadTax()
      dian = { resolution: t.dian_resolution, prefix: t.dian_prefix, from: t.dian_from, to: t.dian_to, validUntil: t.dian_valid_until }
    }
    // Solo lo necesario para el documento (sin datos de contacto ni dirección).
    const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))
    const data = share.kind === 'factura'
      ? { ...pick(doc.data, ['numFactura', 'fecha', 'invoicedAt', 'serviceName', 'paciente', 'documento', 'payer', 'epsName', 'items', 'valorBase', 'descuento', 'descuentoNombre', 'iva', 'total', 'shared', 'valor', 'paymentMode', 'billingStatus', 'siteName']), dian }
      : { patient: pick(doc.data.patient, ['patient', 'docType', 'docNumber', 'birthDate', 'sex', 'epsName', 'populationGroup']), records: doc.data.records.map((r) => pick(r, ['id', 'appliedOn', 'vaccineId', 'vaccine', 'pai', 'dose', 'lot', 'vaccinator', 'vaccinatorSignature', 'siteName', 'nextDoseDate', 'nextDoseLabel'])) }
    res.send({ kind: share.kind, expiresAt: share.expires_at, institution: { name: s.ipsName, shortName: s.shortName, logoUrl: s.logoUrl, primaryColor: s.primaryColor }, data })
  }))
  return { linkFor, smtpReady, mailer }
}
