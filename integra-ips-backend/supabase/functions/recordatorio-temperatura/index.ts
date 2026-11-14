// =====================================================================
// Recordatorio por Telegram de las lecturas de temperatura no registradas.
// pg_cron la llama cada 5 minutos (cabecera x-cron-secret). Para cada organización activa o en
// prueba con Telegram y cadena de frío en el plan: 30 minutos después de cada hora de toma, si la
// lectura de esa hora no está registrada en una sede, avisa al grupo "temperatura" de la sede
// (y a los grupos sin sede). Cada aviso se envía una sola vez (temperature_reminders_sent).
// Prueba sin enviar: body { "dry": true, "now": "08:31" } con la misma cabecera.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const TZ = 'America/Bogota'
const DELAY_MIN = 30 // minutos después de la hora de toma
const GRACE_MIN = 90 // si la tarea no corrió a tiempo, no se avisan lecturas de hace más de esto
const SHIFTS: Record<string, string> = { manana: 'Mañana', tarde: 'Tarde' }
const DEFAULT_REMINDERS = { enabled: true, reminders: [{ time: '09:00', shift: 'manana' }, { time: '12:00', shift: 'manana' }, { time: '14:00', shift: 'tarde' }, { time: '18:00', shift: 'tarde' }] }
const SEP = '━━━━━━━━━━━━━━━'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const esc = (t: unknown) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

type Reading = { shift: string; slot: number; time: string; label: string; short: string }
// Mismo plan de lecturas que el backend (index.js → readingPlan).
const readingPlan = (cfg: { reminders: { time: string; shift: string }[] }): Reading[] => {
  const out: Reading[] = []
  for (const shift of Object.keys(SHIFTS)) {
    const times = (cfg.reminders || []).filter((r) => r.shift === shift).map((r) => r.time).sort().slice(0, 4)
    const list = times.length ? times : (shift === 'manana' ? ['08:00', '12:00'] : ['14:00', '18:00'])
    list.forEach((time, i) => out.push({ shift, slot: i + 1, time, label: `${SHIFTS[shift]} · ${i + 1}.ª lectura (${time})`, short: `${shift === 'manana' ? 'M' : 'T'}${i + 1}` }))
  }
  return out
}
const reminderConfig = (settings: any) => {
  const r = settings?.reminders
  return r && Array.isArray(r.reminders) ? { enabled: r.enabled !== false, reminders: r.reminders } : DEFAULT_REMINDERS
}

const nowBogota = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}` }
}

const message = (siteName: string, p: Reading, day: { short: string; done: boolean }[], minutesLate: number) =>
  `⏰ <b>RECORDATORIO · TEMPERATURA</b>\n${SEP}\n` +
  `🏥 ${esc(siteName)}\n` +
  `📋 ${esc(p.label)}\n` +
  `⚠️ Ya pasaron ${minutesLate} minutos de la hora de toma y la lectura <b>aún no está registrada</b>.\n` +
  `📋 Hoy: ${day.map((d) => `${d.done ? '✅' : '⬜'} ${d.short}`).join(' · ')}\n` +
  `👉 Regístrala en Integra IPS → Temperatura.`

const tg = async (token: string, chatId: string, text: string) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(`Telegram: ${j.description || `error ${r.status}`}`)
}

// Plan comercial (igual que platform.js): sin plan = sin restricción; suspendida o cancelada = nada.
const planAllows = (org: any, feats: { key: string; module_key: string | null }[]) => {
  if (!org.plan) return true
  const keys = new Set([...(org.plan.features || []), ...(org.extra_features || [])])
  const modules = new Set(feats.filter((f) => f.module_key && keys.has(f.key)).map((f) => f.module_key))
  return keys.has('notificaciones_telegram') && modules.has('temperatura')
}

const runOrg = async (org: any, today: string, hhmm: string, dry: boolean) => {
  const out: any[] = []
  const [{ data: st }, { data: svc }] = await Promise.all([
    sb.from('notification_settings').select('enabled, bot_token').eq('org_id', org.id).maybeSingle(),
    sb.from('ips_services').select('id, settings, active').eq('org_id', org.id).eq('module', 'cadena_frio').maybeSingle()
  ])
  if (!st?.enabled || !st.bot_token || !svc?.active) return out
  const cfg = reminderConfig(svc.settings)
  if (!cfg.enabled) return out
  const plan = readingPlan(cfg)
  const now = toMin(hhmm)
  const due = plan.filter((p) => now >= toMin(p.time) + DELAY_MIN && now < toMin(p.time) + DELAY_MIN + GRACE_MIN)
  if (!due.length) return out

  const siteIds = ((await sb.from('site_services').select('site_id').eq('org_id', org.id).eq('service_id', svc.id)).data || []).map((x: any) => x.site_id)
  if (!siteIds.length) return out
  const [{ data: sites }, { data: temps }, { data: chans }] = await Promise.all([
    sb.from('sites').select('id, name').eq('org_id', org.id).in('id', siteIds),
    sb.from('temperature').select('site_id, shift, slot').eq('org_id', org.id).eq('record_date', today).in('site_id', siteIds),
    sb.from('notification_channels').select('chat_id, site_id').eq('org_id', org.id).eq('section', 'temperatura').eq('enabled', true)
  ])
  const done = (siteId: number, p: Reading) => (temps || []).some((t: any) => t.site_id === siteId && t.shift === p.shift && (t.slot || 1) === p.slot)

  for (const site of sites || []) {
    const targets = (chans || []).filter((c: any) => c.site_id == null || c.site_id === site.id)
    if (!targets.length) continue
    for (const p of due) {
      if (done(site.id, p)) continue
      const text = message(site.name, p, plan.map((x) => ({ short: x.short, done: done(site.id, x) })), now - toMin(p.time))
      if (dry) { out.push({ org: org.id, site: site.name, reading: p.label, chats: targets.length, text }); continue }
      // Se marca antes de enviar: si otra ejecución ya lo marcó, no se repite.
      const { data: mark } = await sb.from('temperature_reminders_sent').upsert({ org_id: org.id, site_id: site.id, record_date: today, shift: p.shift, slot: p.slot }, { onConflict: 'org_id,site_id,record_date,shift,slot', ignoreDuplicates: true }).select('id')
      if (!mark?.length) continue
      for (const c of targets) {
        let status = 'enviado'; let detail: string | null = null
        try { await tg(st.bot_token, c.chat_id, text) } catch (e) { status = 'error'; detail = String((e as Error).message).slice(0, 300) }
        await sb.from('notification_log').insert({ org_id: org.id, section: 'temperatura', chat_id: c.chat_id, status, detail: detail || `Recordatorio: ${p.label}`, site_id: site.id })
        out.push({ org: org.id, site: site.name, reading: p.label, chat: c.chat_id, status })
      }
    }
  }
  return out
}

Deno.serve(async (req) => {
  const secret = req.headers.get('x-cron-secret') || ''
  const { data: ok } = await sb.rpc('temp_reminder_secret_ok', { p_secret: secret })
  if (!ok) return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  const body = await req.json().catch(() => ({}))
  const dry = body?.dry === true
  const clock = nowBogota()
  const hhmm = dry && /^([01]\d|2[0-3]):[0-5]\d$/.test(body?.now || '') ? body.now : clock.hhmm
  const today = dry && /^\d{4}-\d{2}-\d{2}$/.test(body?.date || '') ? body.date : clock.date

  const [{ data: orgs }, { data: feats }] = await Promise.all([
    sb.from('plt_organizations').select('id, status, extra_features, plan:plt_plans(features)').in('status', ['activa', 'prueba']),
    sb.from('plt_features').select('key, module_key')
  ])
  const results: any[] = []
  for (const org of orgs || []) {
    if (!planAllows(org, feats || [])) continue
    try { results.push(...await runOrg(org, today, hhmm, dry)) } catch (e) { results.push({ org: org.id, error: String((e as Error).message) }) }
  }
  return new Response(JSON.stringify({ date: today, now: hhmm, dry, results }), { headers: { 'Content-Type': 'application/json' } })
})
