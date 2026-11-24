// =====================================================================
// Académico ETDH (IIPS-019 · fase 1)
// Institución de Educación para el Trabajo y el Desarrollo Humano (Decreto 1075 de 2015).
// · Programas: cursos, diplomados, seminarios y carreras técnicas, con su pensum (periodos → asignaturas y horas).
//   billing_mode 'total': se cobra el valor del programa completo; 'periodo': cada semestre tiene su valor.
// · Grupos (cohortes) por sede, estudiantes y matrículas con su liquidación (descuento y convenio).
// · Portal del estudiante: el estudiante (rol 'estudiante') consulta su programa.
// Alcance por sede: el administrador ve todo (o la sede elegida con ?sede=); los demás, su sede.
// =====================================================================
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const V = require('./validate')
const tenant = require('./tenant')

const KINDS = { curso: 'Curso', diplomado: 'Diplomado', seminario: 'Seminario', carrera_tecnica: 'Carrera técnica', otro: 'Otro' }
const CERT_TYPES = { tecnico_laboral: 'Certificado de técnico laboral por competencias', conocimientos_academicos: 'Certificado de conocimientos académicos', asistencia: 'Constancia de asistencia' }
const MODALITIES = { presencial: 'Presencial', virtual: 'Virtual', mixta: 'Mixta' }
const BILLING = { total: 'Valor total del programa', periodo: 'Por periodo (semestre)' }
const SUBJECT_KINDS = { teorico: 'Teórico', practico: 'Práctico', teorico_practico: 'Teórico-práctico', practica_laboral: 'Práctica laboral' }
const SHIFTS = { mañana: 'Mañana', tarde: 'Tarde', noche: 'Noche', fin_de_semana: 'Fin de semana', mixta: 'Mixta' }
const GROUP_STATUS = { planeado: 'Planeado', en_curso: 'En curso', finalizado: 'Finalizado', cancelado: 'Cancelado' }
const STUDENT_STATUS = { activo: 'Activo', inactivo: 'Inactivo', graduado: 'Graduado', retirado: 'Retirado' }
const ENROLL_STATUS = { preinscrito: 'Preinscrito', matriculado: 'Matriculado', aplazado: 'Aplazado', retirado: 'Retirado', finalizado: 'Finalizado' }
const ACTIVE_ENROLL = ['preinscrito', 'matriculado', 'aplazado']
const DOC_TYPES = ['CC', 'TI', 'CE', 'PPT', 'PA', 'RC']
const EXPIRY_WARN_DAYS = 180

const alerts = require('./alerts')

module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, ISO_DATE, todayBogota, scopeSite, canAccessSite, targetSite, uploadImage, notifier } = deps
  const STAFF = ['administrador', 'empleado']
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const num = (v, d = 0) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v))
  const money = (v) => Math.round(num(v) * 100) / 100
  const date = (v) => (clean(v) && ISO_DATE.test(clean(v)) ? clean(v) : null)
  const oneOf = (map, v, d) => (v && map[v] ? v : d)
  const toUTC = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const daysUntil = (iso) => Math.round((toUTC(iso) - toUTC(todayBogota())) / 86400000)
  const registrationState = (iso) => (!iso ? null : daysUntil(iso) < 0 ? 'vencido' : daysUntil(iso) <= EXPIRY_WARN_DAYS ? 'por_vencer' : 'vigente')
  const must = async (q) => { const { data, error } = await q; if (error) throw error; return data }

  // ---------------------------------------------------------------- Catálogos
  app.get('/academico/catalogos', auth(), (req, res) => res.send({ kinds: KINDS, certTypes: CERT_TYPES, modalities: MODALITIES, billing: BILLING, subjectKinds: SUBJECT_KINDS, shifts: SHIFTS, groupStatus: GROUP_STATUS, studentStatus: STUDENT_STATUS, enrollStatus: ENROLL_STATUS, docTypes: DOC_TYPES }))

  // ---------------------------------------------------------------- Programas y pensum
  const PROGRAM_SELECT = '*, periods:edu_program_periods(id, number, name, price, subjects:edu_subjects(id, code, name, kind, hours, sort_order)), groups:edu_groups(id, status)'
  const programDTO = (p) => {
    const periods = (p.periods || []).sort((a, b) => a.number - b.number).map((x) => {
      const subjects = (x.subjects || []).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, hours: s.hours }))
      return { id: x.id, number: x.number, name: x.name, price: Number(x.price), hours: subjects.reduce((a, s) => a + s.hours, 0), subjects }
    })
    const totalHours = periods.reduce((a, x) => a + x.hours, 0)
    return {
      id: p.id, code: p.code, name: p.name, kind: p.kind, kindLabel: KINDS[p.kind], certType: p.cert_type, certLabel: CERT_TYPES[p.cert_type], certificateTemplateId: p.certificate_template_id ?? null,
      modality: p.modality, billingMode: p.billing_mode, periodLabel: p.period_label,
      price: Number(p.price), totalPrice: p.billing_mode === 'total' ? Number(p.price) : periods.reduce((a, x) => a + x.price, 0),
      registrationNumber: p.registration_number, registrationDate: p.registration_date, registrationExpires: p.registration_expires,
      registrationState: registrationState(p.registration_expires), occupation: p.occupation, description: p.description, active: p.active,
      totalHours, periodsCount: periods.length, subjectsCount: periods.reduce((a, x) => a + x.subjects.length, 0),
      groupsActive: (p.groups || []).filter((g) => ['planeado', 'en_curso'].includes(g.status)).length,
      periods
    }
  }
  const loadProgram = async (id) => {
    const p = await must(supabase.from('edu_programs').select(PROGRAM_SELECT).eq('id', Number(id)).maybeSingle())
    if (!p) throw httpError(404, 'Programa no encontrado')
    return programDTO(p)
  }
  const programRow = (b) => {
    const e = []
    if (!clean(b.code)) e.push('El código es requerido')
    if (!clean(b.name)) e.push('El nombre es requerido')
    if (!KINDS[b.kind]) e.push('Tipo de programa inválido')
    if (!BILLING[b.billingMode]) e.push('Forma de cobro inválida')
    if (num(b.price) < 0) e.push('El valor no puede ser negativo')
    if (clean(b.registrationExpires) && !date(b.registrationExpires)) e.push('Fecha de vencimiento del registro inválida')
    if (e.length) throw httpError(400, e.join('. '))
    return {
      code: clean(b.code).toUpperCase().slice(0, 20), name: clean(b.name).slice(0, 160), kind: b.kind,
      cert_type: oneOf(CERT_TYPES, b.certType, b.kind === 'carrera_tecnica' ? 'tecnico_laboral' : 'asistencia'),
      modality: oneOf(MODALITIES, b.modality, 'presencial'), billing_mode: b.billingMode,
      period_label: clean(b.periodLabel)?.slice(0, 30) || 'Semestre', price: money(b.price),
      registration_number: clean(b.registrationNumber), registration_date: date(b.registrationDate), registration_expires: date(b.registrationExpires),
      occupation: clean(b.occupation), description: clean(b.description)?.slice(0, 2000) ?? null, active: b.active !== false
    }
  }

  app.get('/academico/programas', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_programs').select(PROGRAM_SELECT).order('name')
    if (req.query.activos) q = q.eq('active', true)
    res.send((await must(q)).map(programDTO))
  }))
  app.get('/academico/programas/:id', auth(STAFF), hx(async (req, res) => res.send(await loadProgram(req.params.id))))

  app.post('/academico/programas', auth(ADMIN), hx(async (req, res) => {
    const row = programRow(req.body || {})
    const { data, error } = await supabase.from('edu_programs').insert({ ...row, created_by: req.user.id }).select('id').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un programa con ese código', 409); throw error }
    // Un curso arranca con su único periodo; la carrera técnica, con el primer semestre.
    await must(supabase.from('edu_program_periods').insert({ program_id: data.id, number: 1, name: row.kind === 'carrera_tecnica' ? `${row.period_label} 1` : 'Único', price: 0 }))
    res.status(201).send(await loadProgram(data.id))
  }))

  app.put('/academico/programas/:id', auth(ADMIN), hx(async (req, res) => {
    const row = programRow(req.body || {})
    const { data, error } = await supabase.from('edu_programs').update({ ...row, updated_at: new Date().toISOString() }).eq('id', Number(req.params.id)).select('id').maybeSingle()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un programa con ese código', 409); throw error }
    if (!data) return fail(res, 'Programa no encontrado', 404)
    res.send(await loadProgram(data.id))
  }))

  app.delete('/academico/programas/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const { count: groups } = await supabase.from('edu_groups').select('id', { count: 'exact', head: true }).eq('program_id', id)
    const { count: enr } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('program_id', id)
    if (groups || enr) return fail(res, 'El programa ya tiene grupos o matrículas. Desactívalo en lugar de eliminarlo.', 409)
    await must(supabase.from('edu_programs').delete().eq('id', id))
    res.send({ message: 'Programa eliminado' })
  }))

  // Pensum completo: periodos (por número) con sus asignaturas. Los periodos que conservan su número se
  // actualizan (las matrículas siguen apuntando a ellos); los que desaparecen se eliminan si no tienen matrículas.
  app.put('/academico/programas/:id/pensum', auth(ADMIN), hx(async (req, res) => {
    const program = await loadProgram(req.params.id)
    const periods = Array.isArray(req.body?.periods) ? req.body.periods : []
    if (!periods.length) return fail(res, 'El pensum debe tener al menos un periodo', 400)
    if (periods.length > 20) return fail(res, 'Máximo 20 periodos', 400)
    const errors = []
    const clean_ = periods.map((p, i) => {
      const subjects = (Array.isArray(p.subjects) ? p.subjects : []).filter((s) => clean(s.name)).map((s, j) => {
        if (num(s.hours) < 0 || num(s.hours) > 5000) errors.push(`Horas inválidas en ${clean(s.name)}`)
        return { code: clean(s.code)?.slice(0, 20) ?? null, name: clean(s.name).slice(0, 160), kind: oneOf(SUBJECT_KINDS, s.kind, 'teorico_practico'), hours: Math.round(num(s.hours)), sort_order: j }
      })
      if (num(p.price) < 0) errors.push(`Valor inválido en el periodo ${i + 1}`)
      return { number: i + 1, name: clean(p.name)?.slice(0, 60) || `${program.periodLabel} ${i + 1}`, price: money(p.price), subjects }
    })
    if (errors.length) return fail(res, errors.join('. '), 400)
    const existing = program.periods
    const gone = existing.filter((x) => x.number > clean_.length)
    if (gone.length) {
      const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).in('period_id', gone.map((x) => x.id))
      if (count) return fail(res, `No se pueden quitar periodos con matrículas (${gone.map((x) => x.name).join(', ')}).`, 409)
      await must(supabase.from('edu_program_periods').delete().in('id', gone.map((x) => x.id)))
    }
    for (const p of clean_) {
      const prev = existing.find((x) => x.number === p.number)
      let periodId = prev?.id
      if (prev) await must(supabase.from('edu_program_periods').update({ name: p.name, price: p.price }).eq('id', prev.id))
      else periodId = (await must(supabase.from('edu_program_periods').insert({ program_id: program.id, number: p.number, name: p.name, price: p.price }).select('id').single())).id
      await must(supabase.from('edu_subjects').delete().eq('period_id', periodId))
      if (p.subjects.length) await must(supabase.from('edu_subjects').insert(p.subjects.map((s) => ({ ...s, program_id: program.id, period_id: periodId }))))
    }
    await supabase.from('edu_programs').update({ updated_at: new Date().toISOString() }).eq('id', program.id)
    res.send(await loadProgram(program.id))
  }))

  // ---------------------------------------------------------------- Grupos
  const GROUP_SELECT = '*, program:edu_programs(id, code, name, kind, period_label), site:sites(id, name), enrollments:edu_enrollments(id, status)'
  const groupDTO = (g) => ({
    id: g.id, code: g.code, programId: g.program_id, program: g.program ? { id: g.program.id, code: g.program.code, name: g.program.name, kind: g.program.kind, periodLabel: g.program.period_label } : null,
    siteId: g.site_id, siteName: g.site?.name ?? null, shift: g.shift, shiftLabel: SHIFTS[g.shift], startDate: g.start_date, endDate: g.end_date,
    capacity: g.capacity, currentPeriod: g.current_period, status: g.status, statusLabel: GROUP_STATUS[g.status], notes: g.notes,
    telegram: g.telegram_chat_id ? { chatId: g.telegram_chat_id, title: g.telegram_title } : null,
    enrolled: (g.enrollments || []).filter((e) => ['matriculado', 'preinscrito'].includes(e.status)).length
  })
  const groupRow = async (req, b) => {
    const e = []
    if (!clean(b.code)) e.push('El código del grupo es requerido')
    if (!Number(b.programId)) e.push('Selecciona el programa')
    if (clean(b.startDate) && !date(b.startDate)) e.push('Fecha de inicio inválida')
    if (clean(b.endDate) && !date(b.endDate)) e.push('Fecha de fin inválida')
    if (date(b.startDate) && date(b.endDate) && date(b.endDate) < date(b.startDate)) e.push('La fecha de fin es anterior a la de inicio')
    if (e.length) throw httpError(400, e.join('. '))
    return {
      code: clean(b.code).toUpperCase().slice(0, 20), program_id: Number(b.programId), site_id: await targetSite(req, b.siteId),
      shift: oneOf(SHIFTS, b.shift, 'mañana'), start_date: date(b.startDate), end_date: date(b.endDate),
      capacity: Number(b.capacity) > 0 ? Math.round(Number(b.capacity)) : null, current_period: Math.max(1, Math.round(num(b.currentPeriod, 1))),
      status: oneOf(GROUP_STATUS, b.status, 'planeado'), notes: clean(b.notes)?.slice(0, 1000) ?? null,
      // Grupo de Telegram del grupo académico (avisos de clases). Solo el administrador lo cambia.
      ...(req.user.role === 'administrador' && 'telegramChatId' in b ? { telegram_chat_id: /^-?\d{5,20}$/.test(String(b.telegramChatId || '')) ? String(b.telegramChatId) : null, telegram_title: clean(b.telegramTitle)?.slice(0, 120) ?? null } : {})
    }
  }
  const loadGroup = async (id) => {
    const g = await must(supabase.from('edu_groups').select(GROUP_SELECT).eq('id', Number(id)).maybeSingle())
    if (!g) throw httpError(404, 'Grupo no encontrado')
    return g
  }

  app.get('/academico/grupos', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_groups').select(GROUP_SELECT).order('start_date', { ascending: false, nullsFirst: false }).order('code')
    const site = scopeSite(req); if (site) q = q.eq('site_id', site)
    if (Number(req.query.programa)) q = q.eq('program_id', Number(req.query.programa))
    if (GROUP_STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
    res.send((await must(q)).map(groupDTO))
  }))
  app.post('/academico/grupos', auth(STAFF), hx(async (req, res) => {
    const row = await groupRow(req, req.body || {})
    const { data, error } = await supabase.from('edu_groups').insert(row).select('id').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un grupo con ese código', 409); throw error }
    res.status(201).send(groupDTO(await loadGroup(data.id)))
  }))
  app.put('/academico/grupos/:id', auth(STAFF), hx(async (req, res) => {
    const g = await loadGroup(req.params.id)
    if (!canAccessSite(req, g.site_id)) return fail(res, 'Ese grupo es de otra sede', 403)
    const row = await groupRow(req, req.body || {})
    const { error } = await supabase.from('edu_groups').update({ ...row, updated_at: new Date().toISOString() }).eq('id', g.id)
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un grupo con ese código', 409); throw error }
    res.send(groupDTO(await loadGroup(g.id)))
  }))
  app.delete('/academico/grupos/:id', auth(ADMIN), hx(async (req, res) => {
    const g = await loadGroup(req.params.id)
    if ((g.enrollments || []).length) return fail(res, 'El grupo tiene matrículas. Cámbialo a cancelado o finalizado.', 409)
    await must(supabase.from('edu_groups').delete().eq('id', g.id))
    res.send({ message: 'Grupo eliminado' })
  }))

  // ---------------------------------------------------------------- Estudiantes
  const STUDENT_SELECT = '*, site:sites(id, name), user:users!edu_students_user_id_fkey(id, username, active)'
  const studentDTO = (s) => ({
    id: s.id, siteId: s.site_id, siteName: s.site?.name ?? null, docType: s.doc_type, docNumber: s.doc_number,
    firstName: s.first_name, lastName: s.last_name, fullName: `${s.first_name} ${s.last_name}`.trim(), birthDate: s.birth_date, gender: s.gender,
    phone: s.phone, email: s.email, address: s.address, municipality: s.municipality, eps: s.eps, educationLevel: s.education_level,
    guardianName: s.guardian_name, guardianPhone: s.guardian_phone, status: s.status, statusLabel: STUDENT_STATUS[s.status], notes: s.notes,
    portal: s.user ? { userId: s.user.id, username: s.user.username, active: s.user.active } : null, createdAt: s.created_at
  })
  const studentRow = async (req, b) => {
    const e = []
    const docType = DOC_TYPES.includes(b.docType) ? b.docType : null
    if (!docType) e.push('Tipo de documento inválido')
    if (!V.docNumber(b.docNumber)) e.push('El número de documento es requerido')
    const docErr = V.docError(b.docNumber, docType); if (docErr) e.push(docErr)
    if (!clean(b.firstName)) e.push('Los nombres son requeridos')
    if (!clean(b.lastName)) e.push('Los apellidos son requeridos')
    if (clean(b.birthDate) && !date(b.birthDate)) e.push('Fecha de nacimiento inválida')
    const ph = V.phoneError(b.phone, 'El celular'); if (ph) e.push(ph)
    const gph = V.phoneError(b.guardianPhone, 'El teléfono del acudiente'); if (gph) e.push(gph)
    const em = V.emailError(b.email); if (em) e.push(em)
    if (e.length) throw httpError(400, e.join('. '))
    return {
      site_id: await targetSite(req, b.siteId), doc_type: docType, doc_number: V.docNumber(b.docNumber),
      first_name: clean(b.firstName).slice(0, 80), last_name: clean(b.lastName).slice(0, 80), birth_date: date(b.birthDate), gender: clean(b.gender),
      phone: V.phone(b.phone), email: clean(b.email)?.toLowerCase() ?? null, address: clean(b.address), municipality: clean(b.municipality),
      eps: clean(b.eps), education_level: clean(b.educationLevel), guardian_name: clean(b.guardianName), guardian_phone: V.phone(b.guardianPhone),
      status: oneOf(STUDENT_STATUS, b.status, 'activo'), notes: clean(b.notes)?.slice(0, 2000) ?? null
    }
  }
  const loadStudent = async (req, id) => {
    const s = await must(supabase.from('edu_students').select(STUDENT_SELECT).eq('id', Number(id)).maybeSingle())
    if (!s) throw httpError(404, 'Estudiante no encontrado')
    if (!canAccessSite(req, s.site_id)) throw httpError(403, 'Ese estudiante es de otra sede')
    return s
  }

  app.get('/academico/estudiantes', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_students').select(`${STUDENT_SELECT}, enrollments:edu_enrollments(id, status, program:edu_programs(code, name), group:edu_groups(code))`).order('last_name').order('first_name').limit(1000)
    const site = scopeSite(req); if (site) q = q.eq('site_id', site)
    if (STUDENT_STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
    const text = clean(req.query.q)
    if (text) {
      const t = text.replace(/[%,()]/g, ' ').trim()
      q = q.or(`first_name.ilike.%${t}%,last_name.ilike.%${t}%,doc_number.ilike.%${t}%`)
    }
    res.send((await must(q)).map((s) => ({
      ...studentDTO(s),
      enrollments: (s.enrollments || []).filter((e) => ACTIVE_ENROLL.includes(e.status)).map((e) => ({ id: e.id, status: e.status, program: e.program?.name, programCode: e.program?.code, group: e.group?.code ?? null }))
    })))
  }))
  app.get('/academico/estudiantes/:id', auth(STAFF), hx(async (req, res) => {
    const s = await loadStudent(req, req.params.id)
    const enr = await must(supabase.from('edu_enrollments').select(ENROLL_SELECT).eq('student_id', s.id).order('enrolled_at', { ascending: false }))
    res.send({ ...studentDTO(s), enrollments: enr.map(enrollDTO) })
  }))
  app.post('/academico/estudiantes', auth(STAFF), hx(async (req, res) => {
    const row = await studentRow(req, req.body || {})
    const { data, error } = await supabase.from('edu_students').insert({ ...row, created_by: req.user.id }).select('id').single()
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un estudiante con ese documento', 409); throw error }
    res.status(201).send(studentDTO(await loadStudent(req, data.id)))
  }))
  app.put('/academico/estudiantes/:id', auth(STAFF), hx(async (req, res) => {
    const s = await loadStudent(req, req.params.id)
    const row = await studentRow(req, req.body || {})
    const { error } = await supabase.from('edu_students').update({ ...row, updated_at: new Date().toISOString() }).eq('id', s.id)
    if (error) { if (error.code === '23505') return fail(res, 'Ya existe un estudiante con ese documento', 409); throw error }
    res.send(studentDTO(await loadStudent(req, s.id)))
  }))
  app.delete('/academico/estudiantes/:id', auth(ADMIN), hx(async (req, res) => {
    const s = await loadStudent(req, req.params.id)
    const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('student_id', s.id)
    if (count) return fail(res, 'El estudiante tiene matrículas. Cambia su estado a retirado o inactivo.', 409)
    await must(supabase.from('edu_students').delete().eq('id', s.id))
    if (s.user_id) await supabase.from('users').update({ active: false }).eq('id', s.user_id)
    res.send({ message: 'Estudiante eliminado' })
  }))

  // Acceso al portal: crea (o reactiva) un usuario con rol estudiante en la sede del estudiante.
  app.post('/academico/estudiantes/:id/acceso', auth(ADMIN), hx(async (req, res) => {
    const s = await loadStudent(req, req.params.id)
    const b = req.body || {}
    const username = clean(b.username) || s.doc_number
    if (s.user_id) {
      const patch = { active: true, username, updated_at: new Date().toISOString() }
      if (b.password) { if (b.password.length < 6) return fail(res, 'La contraseña debe tener al menos 6 caracteres', 400); patch.password_hash = await bcrypt.hash(b.password, 10) }
      const { error } = await supabase.from('users').update(patch).eq('id', s.user_id)
      if (error) { if (error.code === '23505') return fail(res, 'Ese nombre de usuario ya existe', 409); throw error }
    } else {
      if (!b.password || b.password.length < 6) return fail(res, 'La contraseña debe tener al menos 6 caracteres', 400)
      if (!s.site_id) return fail(res, 'Asigna la sede del estudiante antes de crear su acceso', 400)
      const { data: u, error } = await supabase.from('users').insert({
        identification: s.doc_number, name: s.first_name, last_name: s.last_name, username, email: s.email,
        password_hash: await bcrypt.hash(b.password, 10), role: 'estudiante', site_id: s.site_id, modules: null, remunerado: false, active: true
      }).select('id').single()
      if (error) { if (error.code === '23505') return fail(res, 'Ya existe un usuario con esa identificación o nombre de usuario', 409); throw error }
      await must(supabase.from('edu_students').update({ user_id: u.id }).eq('id', s.id))
    }
    res.send(studentDTO(await loadStudent(req, s.id)))
  }))
  app.delete('/academico/estudiantes/:id/acceso', auth(ADMIN), hx(async (req, res) => {
    const s = await loadStudent(req, req.params.id)
    if (s.user_id) await must(supabase.from('users').update({ active: false, updated_at: new Date().toISOString() }).eq('id', s.user_id))
    res.send(studentDTO(await loadStudent(req, s.id)))
  }))

  // ---------------------------------------------------------------- Matrículas, liquidación y cuenta por cobrar
  const ENROLL_SELECT = '*, program:edu_programs(id, code, name, kind, billing_mode, period_label, cert_type, registration_number), group:edu_groups(id, code, shift), period:edu_program_periods(id, number, name), student:edu_students(id, first_name, last_name, doc_type, doc_number, site_id, phone, email, address, municipality, user_id), plan:edu_installments(id, number, due_date, amount), payments:edu_payments(id, receipt_number, paid_at, amount, method, reference, notes, voided, voided_reason, voided_at, created_at)'
  const PAY_METHODS = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', consignacion: 'Consignación', convenio: 'Pago del convenio', otro: 'Otro' }
  // Cuenta de la matrícula: los pagos vigentes se aplican a las cuotas en orden de vencimiento.
  const account = (e) => {
    const today = todayBogota()
    const total = Number(e.total_value)
    const pays = (e.payments || []).filter((p) => !p.voided)
    const paid = Math.round(pays.reduce((a, p) => a + Number(p.amount), 0) * 100) / 100
    let left = paid
    const plan = (e.plan || []).sort((a, b) => a.number - b.number).map((q) => {
      const amount = Number(q.amount)
      const applied = Math.min(amount, Math.max(0, left)); left -= applied
      const due = Math.round((amount - applied) * 100) / 100
      const status = due <= 0 ? 'pagada' : q.due_date < today ? 'vencida' : applied > 0 ? 'parcial' : 'pendiente'
      return { id: q.id, number: q.number, dueDate: q.due_date, amount, paid: applied, balance: due, status, daysLate: status === 'vencida' ? daysUntil(today) - daysUntil(q.due_date) : 0 }
    })
    const overdue = plan.filter((q) => q.status === 'vencida')
    const balance = Math.max(0, Math.round((total - paid) * 100) / 100)
    return {
      total, paid, balance, overdue: overdue.reduce((a, q) => a + q.balance, 0), overdueCount: overdue.length,
      maxDaysLate: overdue.reduce((a, q) => Math.max(a, q.daysLate), 0), nextDue: plan.find((q) => q.balance > 0) || null,
      state: balance <= 0 ? 'paz_y_salvo' : overdue.length ? 'en_mora' : 'al_dia', plan,
      payments: (e.payments || []).sort((a, b) => b.receipt_number - a.receipt_number).map((p) => ({ id: p.id, receiptNumber: p.receipt_number, paidAt: p.paid_at, amount: Number(p.amount), method: p.method, methodLabel: PAY_METHODS[p.method], reference: p.reference, notes: p.notes, voided: p.voided, voidedReason: p.voided_reason, createdAt: p.created_at }))
    }
  }
  const enrollDTO = (e) => ({
    id: e.id, studentId: e.student_id, student: e.student ? { id: e.student.id, fullName: `${e.student.first_name} ${e.student.last_name}`.trim(), docType: e.student.doc_type, docNumber: e.student.doc_number } : null,
    programId: e.program_id, program: e.program ? { id: e.program.id, code: e.program.code, name: e.program.name, kind: e.program.kind, billingMode: e.program.billing_mode, periodLabel: e.program.period_label } : null,
    groupId: e.group_id, group: e.group ? { id: e.group.id, code: e.group.code, shift: e.group.shift } : null,
    periodId: e.period_id, period: e.period ? { id: e.period.id, number: e.period.number, name: e.period.name } : null,
    academicPeriod: e.academic_period, enrolledAt: e.enrolled_at, status: e.status, statusLabel: ENROLL_STATUS[e.status],
    baseValue: Number(e.base_value), discountPct: Number(e.discount_pct), discountValue: Number(e.discount_value ?? 0),
    discountId: e.discount_id, paymentPlanId: e.payment_plan_id, discountReason: e.discount_reason, agreementId: e.agreement_id, agreementName: e.agreement_name, agreementValue: Number(e.agreement_value), totalValue: Number(e.total_value),
    installments: e.installments, installmentValue: Math.round(Number(e.total_value) / e.installments), firstDueDate: e.first_due_date || e.enrolled_at, notes: e.notes, createdAt: e.created_at,
    invoice: { number: e.invoice_number, invoicedAt: e.invoiced_at, agreementNumber: e.agreement_invoice_number, agreementInvoicedAt: e.agreement_invoiced_at, voided: e.invoice_voided || [] },
    contract: { required: e.contract_required, signedAt: e.contract_signed_at, signerName: e.contract_signer_name, signatureUrl: e.contract_signature_url, rulesAcceptedAt: e.rules_accepted_at, rulesVersion: e.rules_version },
    account: account(e)
  })
  // Valor de la matrícula: el del programa (cobro total) o el del periodo (cobro por semestre),
  // menos el descuento del catálogo (porcentaje o valor fijo) y menos el aporte del convenio del catálogo.
  // Nunca queda negativo. El número de cuotas sale del plan de pagos elegido.
  const discountAmountOf = (d, base) => (!d ? 0 : d.type === 'valor' ? Math.min(Number(d.value), base) : Math.round(base * Number(d.value)) / 100)
  const enrollRow = async (b, current) => {
    const e = []
    const programId = Number(b.programId ?? current?.program_id)
    const program = await must(supabase.from('edu_programs').select('id, kind, billing_mode, price, active, periods:edu_program_periods(id, number, price)').eq('id', programId).maybeSingle())
    if (!program) throw httpError(400, 'Selecciona el programa')
    if (!program.active && !current) e.push('El programa está inactivo')
    let periodId = Number(b.periodId) || null
    let base = Number(program.price)
    if (program.billing_mode === 'periodo') {
      const period = (program.periods || []).find((p) => p.id === periodId)
      if (!period) e.push('Selecciona el periodo (semestre) que se matricula')
      else base = Number(period.price)
    } else {
      periodId = periodId && (program.periods || []).some((p) => p.id === periodId) ? periodId : null
    }
    const groupId = Number(b.groupId) || null
    if (groupId) {
      const g = await must(supabase.from('edu_groups').select('id, program_id').eq('id', groupId).maybeSingle())
      if (!g || g.program_id !== program.id) e.push('El grupo no pertenece al programa seleccionado')
    }
    // Descuento: solo del catálogo.
    const discountId = Number(b.discountId) || null
    const d = discountId ? await must(supabase.from('edu_discounts').select('id, name, type, value, active').eq('id', discountId).maybeSingle()) : null
    if (discountId && !d) e.push('Descuento inválido')
    if (d && !d.active && Number(current?.discount_id) !== d.id) e.push('El descuento está inactivo')
    const discount = discountAmountOf(d, base)
    // Convenio: solo del catálogo; aporta su porcentaje sobre el valor ya descontado.
    const agreementId = Number(b.agreementId) || null
    const a = agreementId ? await must(supabase.from('edu_agreements').select('id, name, contribution_pct, active').eq('id', agreementId).maybeSingle()) : null
    if (agreementId && !a) e.push('Convenio inválido')
    if (a && !a.active && Number(current?.agreement_id) !== a.id) e.push('El convenio está inactivo')
    const agreement = a ? Math.round((base - discount) * Number(a.contribution_pct)) / 100 : 0
    // Plan de pagos: del catálogo y del tipo del programa. Sin planes configurados, de contado.
    const planId = Number(b.paymentPlanId) || null
    const plan = planId ? await must(supabase.from('edu_payment_plans').select('id, installments, interval_months, program_kind, active').eq('id', planId).maybeSingle()) : null
    if (planId && !plan) e.push('Plan de pagos inválido')
    if (plan && !['todos', program.kind].includes(plan.program_kind)) e.push('El plan de pagos no aplica a este tipo de programa')
    if (plan && !plan.active && Number(current?.payment_plan_id) !== plan.id) e.push('El plan de pagos está inactivo')
    if (clean(b.enrolledAt) && !date(b.enrolledAt)) e.push('Fecha de matrícula inválida')
    if (clean(b.firstDueDate) && !date(b.firstDueDate)) e.push('Fecha de la primera cuota inválida')
    if (e.length) throw httpError(400, e.join('. '))
    const enrolledAt = date(b.enrolledAt) || current?.enrolled_at || todayBogota()
    return {
      program_id: program.id, group_id: groupId, period_id: periodId, academic_period: clean(b.academicPeriod)?.slice(0, 20) ?? null,
      enrolled_at: enrolledAt, status: oneOf(ENROLL_STATUS, b.status, 'matriculado'),
      base_value: base, discount_id: d?.id ?? null, discount_pct: d?.type === 'porcentaje' ? Number(d.value) : 0, discount_value: discount, discount_reason: d?.name ?? null,
      agreement_id: a?.id ?? null, agreement_name: a?.name ?? null, agreement_value: agreement,
      total_value: Math.max(0, Math.round((base - discount - agreement) * 100) / 100), installments: plan?.installments || 1, payment_plan_id: plan?.id ?? null,
      first_due_date: date(b.firstDueDate) || enrolledAt, _interval: plan?.interval_months || 1,
      contract_required: program.kind === 'carrera_tecnica' || Boolean(current?.contract_required),
      notes: clean(b.notes)?.slice(0, 1000) ?? null
    }
  }
  // Plan de cuotas iguales y mensuales desde la primera fecha; la última absorbe el redondeo.
  const addMonths = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
  }
  const buildPlan = async (enrollmentId, row) => {
    await must(supabase.from('edu_installments').delete().eq('enrollment_id', enrollmentId))
    const each = Math.round(row.total_value / row.installments)
    const rows = Array.from({ length: row.installments }, (_, i) => ({
      enrollment_id: enrollmentId, number: i + 1, due_date: addMonths(row.first_due_date, i * (row._interval || 1)),
      amount: i < row.installments - 1 ? each : Math.round((row.total_value - each * (row.installments - 1)) * 100) / 100
    }))
    await must(supabase.from('edu_installments').insert(rows))
  }
  const activePayments = (e) => (e.payments || []).filter((p) => !p.voided)
  const loadEnrollment = async (req, id) => {
    const e = await must(supabase.from('edu_enrollments').select(ENROLL_SELECT).eq('id', Number(id)).maybeSingle())
    if (!e) throw httpError(404, 'Matrícula no encontrada')
    if (req.user.role === 'estudiante') { if (!e.student || Number(e.student.user_id) !== Number(req.user.id)) throw httpError(403, 'Esa matrícula no es tuya') } else if (!canAccessSite(req, e.student?.site_id)) throw httpError(403, 'Esa matrícula es de otra sede')
    return e
  }
  const duplicate = (error) => error?.code === '23505'
  // Un estudiante no puede quedar en dos grupos con clases a la misma hora (clases futuras no canceladas).
  const enrollmentClash = async (studentId, groupId, exceptEnrollment) => {
    if (!groupId) return null
    const today = todayBogota()
    let q = supabase.from('edu_enrollments').select('id, group_id').eq('student_id', studentId).in('status', ['preinscrito', 'matriculado', 'aplazado']).not('group_id', 'is', null).neq('group_id', groupId)
    if (exceptEnrollment) q = q.neq('id', exceptEnrollment)
    const others = [...new Set(((await q).data || []).map((e) => e.group_id))]
    if (!others.length) return null
    const [{ data: mine }, { data: theirs }] = await Promise.all([
      supabase.from('edu_sessions').select('date, start_time, end_time').eq('group_id', groupId).gte('date', today).neq('status', 'cancelada').limit(2000),
      supabase.from('edu_sessions').select('date, start_time, end_time, group:edu_groups(code)').in('group_id', others).gte('date', today).neq('status', 'cancelada').limit(5000)
    ])
    const byDate = {}
    for (const x of theirs || []) (byDate[x.date] = byDate[x.date] || []).push(x)
    for (const m of (mine || []).sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const hit = (byDate[m.date] || []).find((x) => String(x.start_time).slice(0, 5) < String(m.end_time).slice(0, 5) && String(x.end_time).slice(0, 5) > String(m.start_time).slice(0, 5))
      if (hit) return `El estudiante ya está en el grupo ${hit.group?.code}, que tiene clase el ${m.date} de ${String(hit.start_time).slice(0, 5)} a ${String(hit.end_time).slice(0, 5)}, a la misma hora que este grupo.`
    }
    return null
  }

  app.get('/academico/matriculas', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_enrollments').select(ENROLL_SELECT).order('enrolled_at', { ascending: false }).limit(1000)
    if (Number(req.query.grupo)) q = q.eq('group_id', Number(req.query.grupo))
    if (Number(req.query.programa)) q = q.eq('program_id', Number(req.query.programa))
    if (ENROLL_STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
    const site = scopeSite(req)
    const rows = (await must(q)).filter((e) => !site || Number(e.student?.site_id) === Number(site))
    res.send(rows.map(enrollDTO))
  }))
  app.get('/academico/matriculas/:id', auth(STAFF), hx(async (req, res) => res.send(enrollDTO(await loadEnrollment(req, req.params.id)))))
  app.post('/academico/matriculas', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const s = await loadStudent(req, b.studentId)
    const { _interval, ...row } = await enrollRow(b)
    if (['preinscrito', 'matriculado', 'aplazado'].includes(row.status)) { const c = await enrollmentClash(s.id, row.group_id); if (c) return fail(res, c, 409) }
    const { data, error } = await supabase.from('edu_enrollments').insert({ ...row, student_id: s.id, created_by: req.user.id }).select('id').single()
    if (duplicate(error)) return fail(res, 'El estudiante ya tiene una matrícula activa en ese programa y periodo', 409)
    if (error) throw error
    await buildPlan(data.id, { ...row, _interval })
    // Factura al matricular (los preinscritos se facturan cuando pasan a matriculados).
    if (row.status === 'matriculado') await invoiceEnrollment(await loadEnrollment(req, data.id))
    res.status(201).send(enrollDTO(await loadEnrollment(req, data.id)))
  }))
  app.put('/academico/matriculas/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadEnrollment(req, req.params.id)
    const { _interval, ...row } = await enrollRow({ ...req.body, programId: cur.program_id }, cur)
    if (row.group_id && (row.group_id !== cur.group_id || !['preinscrito', 'matriculado', 'aplazado'].includes(cur.status)) && ['preinscrito', 'matriculado', 'aplazado'].includes(row.status)) { const c = await enrollmentClash(cur.student_id, row.group_id, cur.id); if (c) return fail(res, c, 409) }
    const money2 = (x) => Math.round(Number(x) * 100)
    const valueChanged = money2(row.total_value) !== money2(cur.total_value) || money2(row.agreement_value) !== money2(cur.agreement_value)
    const planChanged = valueChanged || row.installments !== cur.installments || row.first_due_date !== (cur.first_due_date || cur.enrolled_at) || row.payment_plan_id !== cur.payment_plan_id
    if (planChanged && activePayments(cur).length) return fail(res, 'La matrícula ya tiene pagos: no se puede cambiar el valor ni el plan de cuotas. Anula los pagos primero.', 409)
    if (valueChanged && (cur.invoice_number || cur.agreement_invoice_number)) return fail(res, 'La matrícula ya está facturada: anula la factura antes de cambiar el valor.', 409)
    const { error } = await supabase.from('edu_enrollments').update({ ...row, updated_at: new Date().toISOString() }).eq('id', cur.id)
    if (duplicate(error)) return fail(res, 'El estudiante ya tiene una matrícula activa en ese programa y periodo', 409)
    if (error) throw error
    if (planChanged || !(cur.plan || []).length) await buildPlan(cur.id, { ...row, _interval })
    if (row.status === 'matriculado') await invoiceEnrollment(await loadEnrollment(req, cur.id))
    res.send(enrollDTO(await loadEnrollment(req, cur.id)))
  }))
  app.delete('/academico/matriculas/:id', auth(ADMIN), hx(async (req, res) => {
    const cur = await loadEnrollment(req, req.params.id)
    if ((cur.payments || []).length) return fail(res, 'La matrícula tiene pagos registrados (aunque estén anulados). Cámbiala a retirada en lugar de eliminarla.', 409)
    if (cur.invoice_number || cur.agreement_invoice_number || (cur.invoice_voided || []).length) return fail(res, 'La matrícula tiene factura (vigente o anulada): el consecutivo no se puede perder. Cámbiala a retirada.', 409)
    await must(supabase.from('edu_enrollments').delete().eq('id', cur.id))
    res.send({ message: 'Matrícula eliminada' })
  }))

  // ---------------------------------------------------------------- Facturación de la matrícula
  // Una factura al estudiante por su parte (programa completo o semestre) y otra al convenio por su aporte.
  // Comparten la numeración DIAN de la IPS (next_invoice_number: consecutivo por organización).
  // Servicios educativos de instituciones ETDH: excluidos de IVA.
  const invoiceDigits = (n) => Number(String(n || '').replace(/\D/g, '')) || 0
  const lastInvoiceUsed = async () => {
    const [{ data: sc }, { data: ed }] = await Promise.all([
      supabase.from('service_charges').select('invoice_number').not('invoice_number', 'is', null).order('invoice_number', { ascending: false }).limit(1),
      supabase.from('edu_enrollments').select('invoice_number, agreement_invoice_number').or('invoice_number.not.is.null,agreement_invoice_number.not.is.null').limit(5000)
    ])
    return Math.max(invoiceDigits(sc?.[0]?.invoice_number), ...(ed || []).flatMap((x) => [invoiceDigits(x.invoice_number), invoiceDigits(x.agreement_invoice_number)]), 0)
  }
  const nextInvoiceNumber = async () => {
    const { data: tax } = await supabase.from('billing_tax_settings').select('dian_valid_until, dian_to').maybeSingle()
    if (tax?.dian_valid_until && tax.dian_valid_until < todayBogota()) throw httpError(409, 'La resolución de facturación DIAN está vencida: actualízala en Facturación → Impuestos y numeración')
    if (tax?.dian_to && (await lastInvoiceUsed()) >= tax.dian_to) throw httpError(409, 'Se agotó el rango de numeración autorizado por la DIAN: actualízalo en Facturación → Impuestos y numeración')
    const { data, error } = await supabase.rpc('next_invoice_number')
    if (error) throw error
    return data
  }
  const invoiceEnrollment = async (e) => {
    const patch = {}
    const now = new Date().toISOString()
    if (!e.invoice_number && Number(e.total_value) > 0) Object.assign(patch, { invoice_number: await nextInvoiceNumber(), invoiced_at: now })
    if (!e.agreement_invoice_number && Number(e.agreement_value) > 0) Object.assign(patch, { agreement_invoice_number: await nextInvoiceNumber(), agreement_invoiced_at: now })
    if (Object.keys(patch).length) await must(supabase.from('edu_enrollments').update(patch).eq('id', e.id))
    return Object.keys(patch).length > 0
  }
  app.post('/academico/matriculas/:id/facturar', auth(STAFF), hx(async (req, res) => {
    const e = await loadEnrollment(req, req.params.id)
    if (!['matriculado', 'finalizado', 'aplazado'].includes(e.status)) return fail(res, 'Solo se facturan matrículas en estado matriculado', 400)
    if (!(await invoiceEnrollment(e))) return fail(res, 'La matrícula ya está facturada (o no tiene valor a facturar)', 409)
    res.send(enrollDTO(await loadEnrollment(req, e.id)))
  }))
  app.post('/academico/matriculas/:id/anular-factura', auth(ADMIN), hx(async (req, res) => {
    const e = await loadEnrollment(req, req.params.id)
    const reason = clean(req.body?.reason)
    if (!reason) return fail(res, 'Indica el motivo de la anulación', 400)
    const which = ['estudiante', 'convenio'].includes(req.body?.tipo) ? [req.body.tipo] : ['estudiante', 'convenio']
    const voided = [...(e.invoice_voided || [])]
    const patch = {}
    const now = new Date().toISOString()
    if (which.includes('estudiante') && e.invoice_number) { voided.push({ number: e.invoice_number, kind: 'estudiante', reason: reason.slice(0, 300), at: now, by: req.user.id }); Object.assign(patch, { invoice_number: null, invoiced_at: null }) }
    if (which.includes('convenio') && e.agreement_invoice_number) { voided.push({ number: e.agreement_invoice_number, kind: 'convenio', reason: reason.slice(0, 300), at: now, by: req.user.id }); Object.assign(patch, { agreement_invoice_number: null, agreement_invoiced_at: null }) }
    if (!Object.keys(patch).length) return fail(res, 'No hay factura vigente para anular', 409)
    await must(supabase.from('edu_enrollments').update({ ...patch, invoice_voided: voided }).eq('id', e.id))
    res.send(enrollDTO(await loadEnrollment(req, e.id)))
  }))
  // ---------------------------------------------------------------- Libro de facturas de Educación
  // Una fila por factura (al estudiante o al convenio), vigente o anulada, con su estado de pago. ?desde=&hasta= (fecha de emisión).
  // También lo usa Facturación (IPS) para mostrar el consecutivo completo: app.locals.eduInvoices.
  const eduInvoices = async (req, { from, to } = {}) => {
    const site = scopeSite(req)
    const rows = await must(supabase.from('edu_enrollments').select(`${ENROLL_SELECT}, group_full:edu_groups(site:sites(id, name))`).limit(5000))
    const inRange = (d) => (!from || d >= from) && (!to || d <= to)
    const out = []
    for (const e of rows.filter((x) => (x.invoice_number || x.agreement_invoice_number || (x.invoice_voided || []).length) && (!site || Number(x.student?.site_id) === Number(site)))) {
      const st = e.student ? { name: `${e.student.first_name} ${e.student.last_name}`.trim(), doc: `${e.student.doc_type} ${e.student.doc_number}` } : { name: '—', doc: '' }
      const concept = [e.program?.name, e.period?.name, e.academic_period && `periodo ${e.academic_period}`].filter(Boolean).join(' · ')
      const base = { origin: 'educacion', originLabel: 'Educación', enrollmentId: e.id, studentId: e.student_id, programId: e.program_id, program: e.program?.name, site: e.group_full?.site?.name || null, concept }
      if (e.invoice_number) {
        const a = account(e)
        const d = String(e.invoiced_at || e.enrolled_at).slice(0, 10)
        if (inRange(d)) out.push({ ...base, key: `e${e.id}`, kind: 'estudiante', kindLabel: 'Estudiante', number: e.invoice_number, issuedAt: d, customer: st.name, customerDoc: st.doc,
          subtotal: Number(e.base_value), discount: Number(e.discount_value || 0) + Number(e.agreement_value || 0), iva: 0, total: Number(e.total_value), status: 'vigente',
          payment: a.balance <= 0 ? { label: 'Pagada', tone: 'ok' } : a.overdue > 0 ? { label: `En mora · saldo ${Math.round(a.balance).toLocaleString('es-CO')}`, tone: 'bad' } : { label: `Pendiente · saldo ${Math.round(a.balance).toLocaleString('es-CO')}`, tone: 'warn' },
          balance: Math.max(0, a.balance), href: `/educacion/facturas/${e.id}` })
      }
      if (e.agreement_invoice_number) {
        const d = String(e.agreement_invoiced_at || e.enrolled_at).slice(0, 10)
        if (inRange(d)) out.push({ ...base, key: `c${e.id}`, kind: 'convenio', kindLabel: 'Convenio', number: e.agreement_invoice_number, issuedAt: d, customer: e.agreement_name || 'Convenio', customerDoc: '',
          concept: `Aporte del convenio · ${st.name} · ${concept}`, subtotal: Number(e.agreement_value), discount: 0, iva: 0, total: Number(e.agreement_value), status: 'vigente',
          payment: { label: 'Por cobrar al convenio', tone: 'info' }, balance: Number(e.agreement_value), href: `/educacion/facturas/${e.id}?tipo=convenio` })
      }
      for (const v of e.invoice_voided || []) {
        const d = String(v.at || '').slice(0, 10)
        if (!inRange(d)) continue
        out.push({ ...base, key: `v${e.id}-${v.number}`, kind: v.kind, kindLabel: v.kind === 'convenio' ? 'Convenio' : 'Estudiante', number: v.number, issuedAt: d, customer: v.kind === 'convenio' ? (e.agreement_name || 'Convenio') : st.name, customerDoc: v.kind === 'convenio' ? '' : st.doc,
          subtotal: null, discount: null, iva: 0, total: null, status: 'anulada', voidReason: v.reason, payment: { label: 'Anulada', tone: 'bad' }, balance: 0, href: null })
      }
    }
    return out.sort((a, b) => String(b.number).localeCompare(String(a.number)))
  }
  app.locals.eduInvoices = eduInvoices
  app.get('/academico/facturas', auth(STAFF), hx(async (req, res) => {
    res.send(await eduInvoices(req, { from: date(req.query.desde), to: date(req.query.hasta) }))
  }))
  // Factura imprimible: ?tipo=estudiante (por defecto) | convenio.
  app.get('/academico/matriculas/:id/factura', auth([...STAFF, 'estudiante']), hx(async (req, res) => {
    const raw = await loadEnrollment(req, req.params.id)
    const e = enrollDTO(raw)
    const kind = req.query.tipo === 'convenio' ? 'convenio' : 'estudiante'
    if (kind === 'convenio' && req.user.role === 'estudiante') return fail(res, 'No disponible', 403)
    const number = kind === 'convenio' ? raw.agreement_invoice_number : raw.invoice_number
    if (!number) return fail(res, 'La matrícula no tiene factura vigente', 404)
    const [{ data: org }, { data: tax }, cfg, agreement, st] = await Promise.all([
      supabase.from('plt_organizations').select('name, nit, city').eq('id', tenant.currentOrg()).maybeSingle(),
      supabase.from('billing_tax_settings').select('dian_resolution, dian_prefix, dian_from, dian_to, dian_valid_until').maybeSingle(),
      settingsOf(),
      raw.agreement_id ? supabase.from('edu_agreements').select('name, nit, contact_name, phone, email').eq('id', raw.agreement_id).maybeSingle().then((r) => r.data) : null,
      must(supabase.from('edu_students').select('first_name, last_name, doc_type, doc_number, phone, email, address, municipality').eq('id', raw.student_id).single())
    ])
    const concept = `${e.program?.name}${e.period ? ` · ${e.period.name}` : ''}${e.academicPeriod ? ` · periodo ${e.academicPeriod}` : ''}`
    const studentName = `${st.first_name} ${st.last_name}`.trim()
    const lines = kind === 'convenio'
      ? [{ description: `Aporte del convenio a la matrícula de ${studentName} (${st.doc_type} ${st.doc_number}) · ${concept}`, value: e.agreementValue }]
      : [
          { description: `Matrícula · ${concept}`, value: e.baseValue },
          ...(e.discountValue > 0 ? [{ description: `Descuento: ${e.discountReason || 'descuento'}${e.discountPct ? ` (${e.discountPct} %)` : ''}`, value: -e.discountValue }] : []),
          ...(e.agreementValue > 0 ? [{ description: `Aporte del convenio ${e.agreementName} (se factura a la entidad)`, value: -e.agreementValue }] : [])
        ]
    const total = kind === 'convenio' ? e.agreementValue : e.totalValue
    res.send({
      kind, number, issuedAt: kind === 'convenio' ? raw.agreement_invoiced_at : raw.invoiced_at, concept, lines, subtotal: total, iva: 0, total,
      ivaNote: 'Servicio educativo excluido de IVA (Estatuto Tributario, art. 476).',
      issuer: { name: cfg.institution || org?.name, nit: org?.nit, city: org?.city, logoUrl: cfg.logoUrl },
      resolution: tax ? { number: tax.dian_resolution, prefix: tax.dian_prefix, from: tax.dian_from, to: tax.dian_to, validUntil: tax.dian_valid_until } : null,
      buyer: kind === 'convenio'
        ? { name: agreement?.name || e.agreementName, docType: 'NIT', docNumber: agreement?.nit, phone: agreement?.phone, email: agreement?.email, contact: agreement?.contact_name }
        : { name: studentName, docType: st.doc_type, docNumber: st.doc_number, phone: st.phone, email: st.email, address: [st.address, st.municipality].filter(Boolean).join(', ') },
      payment: kind === 'convenio' ? { mode: 'Crédito (convenio)', plan: [] } : { mode: e.installments > 1 ? `Crédito · ${e.installments} cuotas` : 'Contado', plan: e.account.plan.map((q) => ({ number: q.number, dueDate: q.dueDate, amount: q.amount })) },
      enrollmentId: e.id, student: { name: studentName, docType: st.doc_type, docNumber: st.doc_number }
    })
  }))

  // ---------------------------------------------------------------- Pagos y recibos de caja
  const settingsOf = async () => {
    const [{ data: app }, { data: edu }] = await Promise.all([
      supabase.from('app_settings').select('ips_name, short_name, logo_url, edu_logo_url').maybeSingle(),
      supabase.from('edu_settings').select('*').maybeSingle()
    ])
    return {
      institution: app?.ips_name || '', shortName: app?.short_name || '', logoUrl: app?.edu_logo_url || app?.logo_url || null,
      rulesTitle: edu?.rules_title || 'Reglamento estudiantil', rulesText: edu?.rules_text || null, rulesVersion: edu?.rules_version || '1.0',
      contractClauses: edu?.contract_clauses || null, refundPolicy: edu?.refund_policy || null,
      attendanceFormat: { code: edu?.attendance_format_code || null, name: edu?.attendance_format_name || 'Registro de asistencia', version: edu?.attendance_format_version || null },
      minAttendancePct: Number(edu?.min_attendance_pct ?? 80), directorUserId: edu?.director_user_id ?? null, passingScore: Number(edu?.passing_score ?? 3)
    }
  }
  app.post('/academico/matriculas/:id/pagos', auth(STAFF), hx(async (req, res) => {
    const e = await loadEnrollment(req, req.params.id)
    const b = req.body || {}
    const amount = money(b.amount)
    const acc = account(e)
    if (!(amount > 0)) return fail(res, 'El valor del pago debe ser mayor que cero', 400)
    if (amount > acc.balance) return fail(res, `El pago supera el saldo pendiente (${acc.balance.toLocaleString('es-CO')})`, 400)
    if (clean(b.paidAt) && !date(b.paidAt)) return fail(res, 'Fecha de pago inválida', 400)
    if (clean(b.paidAt) && date(b.paidAt) > todayBogota()) return fail(res, 'La fecha de pago no puede ser futura', 400)
    const method = oneOf(PAY_METHODS, b.method, 'efectivo')
    // Recibo consecutivo por organización; si dos pagos chocan, se reintenta con el siguiente número.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: last } = await supabase.from('edu_payments').select('receipt_number').order('receipt_number', { ascending: false }).limit(1).maybeSingle()
      const receipt = (last?.receipt_number || 0) + 1
      const { data, error } = await supabase.from('edu_payments').insert({
        enrollment_id: e.id, receipt_number: receipt, paid_at: date(b.paidAt) || todayBogota(), amount, method,
        reference: clean(b.reference)?.slice(0, 80) ?? null, notes: clean(b.notes)?.slice(0, 300) ?? null, created_by: req.user.id
      }).select('id').single()
      if (duplicate(error)) continue
      if (error) throw error
      return res.status(201).send({ id: data.id, receiptNumber: receipt, enrollment: enrollDTO(await loadEnrollment(req, e.id)) })
    }
    fail(res, 'No se pudo asignar el número de recibo. Intenta de nuevo.', 409)
  }))
  app.post('/academico/pagos/:id/anular', auth(ADMIN), hx(async (req, res) => {
    const p = await must(supabase.from('edu_payments').select('id, enrollment_id, voided').eq('id', Number(req.params.id)).maybeSingle())
    if (!p) return fail(res, 'Pago no encontrado', 404)
    await loadEnrollment(req, p.enrollment_id)
    if (p.voided) return fail(res, 'El pago ya está anulado', 409)
    if (!clean(req.body?.reason)) return fail(res, 'Indica el motivo de la anulación', 400)
    await must(supabase.from('edu_payments').update({ voided: true, voided_reason: clean(req.body.reason).slice(0, 300), voided_at: new Date().toISOString(), voided_by: req.user.id }).eq('id', p.id))
    res.send(enrollDTO(await loadEnrollment(req, p.enrollment_id)))
  }))
  // Recibo de caja (lo ve el personal y el estudiante dueño de la matrícula).
  app.get('/academico/pagos/:id', auth([...STAFF, 'estudiante']), hx(async (req, res) => {
    const p = await must(supabase.from('edu_payments').select('*').eq('id', Number(req.params.id)).maybeSingle())
    if (!p) return fail(res, 'Pago no encontrado', 404)
    const e = enrollDTO(await loadEnrollment(req, p.enrollment_id))
    const raw = await must(supabase.from('edu_enrollments').select('student:edu_students(first_name, last_name, doc_type, doc_number, phone, email, address, municipality)').eq('id', p.enrollment_id).single())
    const cashier = p.created_by ? (await supabase.from('users').select('name, last_name').eq('id', p.created_by).maybeSingle()).data : null
    res.send({
      id: p.id, receiptNumber: p.receipt_number, paidAt: p.paid_at, amount: Number(p.amount), method: p.method, methodLabel: PAY_METHODS[p.method], reference: p.reference, notes: p.notes,
      voided: p.voided, voidedReason: p.voided_reason, createdAt: p.created_at, cashier: cashier ? `${cashier.name} ${cashier.last_name}`.trim() : null,
      student: raw.student ? { fullName: `${raw.student.first_name} ${raw.student.last_name}`.trim(), docType: raw.student.doc_type, docNumber: raw.student.doc_number, phone: raw.student.phone, email: raw.student.email, address: [raw.student.address, raw.student.municipality].filter(Boolean).join(', ') } : null,
      enrollment: { id: e.id, program: e.program, group: e.group, period: e.period, academicPeriod: e.academicPeriod, totalValue: e.totalValue, account: { total: e.account.total, paid: e.account.paid, balance: e.account.balance, nextDue: e.account.nextDue } },
      settings: await settingsOf()
    })
  }))

  // ---------------------------------------------------------------- Cartera (cuentas por cobrar)
  app.get('/academico/cartera', auth(STAFF), hx(async (req, res) => {
    const q = supabase.from('edu_enrollments').select(ENROLL_SELECT).in('status', ['preinscrito', 'matriculado', 'aplazado', 'finalizado', 'retirado']).limit(5000)
    const site = scopeSite(req)
    const rows = (await must(q)).filter((e) => !site || Number(e.student?.site_id) === Number(site)).map(enrollDTO)
    const withDebt = rows.filter((e) => e.account.balance > 0)
    const list = (req.query.estado === 'en_mora' ? withDebt.filter((e) => e.account.state === 'en_mora') : req.query.estado === 'al_dia' ? withDebt.filter((e) => e.account.state === 'al_dia') : withDebt)
      .filter((e) => !Number(req.query.programa) || e.programId === Number(req.query.programa))
      .sort((a, b) => b.account.maxDaysLate - a.account.maxDaysLate || b.account.balance - a.account.balance)
      .map(({ account: a, ...e }) => ({ ...e, account: { total: a.total, paid: a.paid, balance: a.balance, overdue: a.overdue, overdueCount: a.overdueCount, maxDaysLate: a.maxDaysLate, nextDue: a.nextDue, state: a.state } }))
    const sum = (arr, f) => arr.reduce((x, e) => x + f(e), 0)
    const month = todayBogota().slice(0, 7)
    const paymentsMonth = rows.flatMap((e) => e.account.payments).filter((p) => !p.voided && p.paidAt.slice(0, 7) === month)
    res.send({
      totals: {
        billed: sum(rows, (e) => e.account.total), collected: sum(rows, (e) => e.account.paid), balance: sum(withDebt, (e) => e.account.balance),
        overdue: sum(withDebt, (e) => e.account.overdue), inArrears: withDebt.filter((e) => e.account.state === 'en_mora').length, debtors: withDebt.length,
        collectedMonth: sum(paymentsMonth, (p) => p.amount), paymentsMonth: paymentsMonth.length
      },
      rows: list
    })
  }))

  // ---------------------------------------------------------------- Descuentos y convenios (catálogos)
  // Descuentos con el mismo diseño de IPS: porcentaje o valor fijo, ícono y color.
  const DISCOUNT_ICONS = ['handshake', 'person', 'cake', 'star', 'briefcase', 'school', 'trophy', 'heart']
  const discountDTO = (d) => ({ id: d.id, name: d.name, type: d.type, value: Number(d.value), icon: d.icon, color: d.color, description: d.description, active: d.active })
  app.get('/academico/descuentos', auth(STAFF), hx(async (req, res) => res.send((await must(supabase.from('edu_discounts').select('*').order('name'))).map(discountDTO))))
  const discountRow = (b) => {
    const e = []
    const value = num(b.value, NaN)
    if (!clean(b.name)) e.push('El nombre del descuento es requerido')
    if (!['porcentaje', 'valor'].includes(b.type)) e.push('Tipo de descuento inválido')
    if (!(value > 0)) e.push('El valor debe ser mayor que cero')
    if (b.type === 'porcentaje' && value > 100) e.push('El porcentaje no puede superar 100')
    if (b.icon && !DISCOUNT_ICONS.includes(b.icon)) e.push('Ícono inválido')
    if (b.color && !/^#[0-9a-f]{6}$/i.test(b.color)) e.push('Color inválido')
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name).slice(0, 80), type: b.type, value, icon: b.icon || 'handshake', color: (b.color || '#14B8A6').toUpperCase(), description: clean(b.description)?.slice(0, 300) ?? null, active: b.active !== false, updated_at: new Date().toISOString() }
  }
  app.post('/academico/descuentos', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_discounts').insert(discountRow(req.body || {})).select('*').single()
    if (duplicate(error)) return fail(res, 'Ya existe un descuento con ese nombre', 409); if (error) throw error
    res.status(201).send(discountDTO(data))
  }))
  app.put('/academico/descuentos/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_discounts').update(discountRow(req.body || {})).eq('id', Number(req.params.id)).select('*').maybeSingle()
    if (duplicate(error)) return fail(res, 'Ya existe un descuento con ese nombre', 409); if (error) throw error
    if (!data) return fail(res, 'Descuento no encontrado', 404)
    res.send(discountDTO(data))
  }))
  app.delete('/academico/descuentos/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('discount_id', Number(req.params.id))
    if (count) return fail(res, `El descuento se aplicó en ${count} matrícula(s). Desactívalo en lugar de eliminarlo.`, 409)
    await must(supabase.from('edu_discounts').delete().eq('id', Number(req.params.id))); res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Planes de pago (número de cuotas por tipo de programa)
  const PLAN_KINDS = { todos: 'Todos los programas', ...KINDS }
  const planDTO = (p) => ({ id: p.id, name: p.name, programKind: p.program_kind, programKindLabel: PLAN_KINDS[p.program_kind], installments: p.installments, intervalMonths: p.interval_months, description: p.description, active: p.active, sortOrder: p.sort_order })
  app.get('/academico/planes-pago', auth(STAFF), hx(async (req, res) => res.send((await must(supabase.from('edu_payment_plans').select('*').order('sort_order').order('installments'))).map(planDTO))))
  const planRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre del plan es requerido')
    if (!PLAN_KINDS[b.programKind]) e.push('Tipo de programa inválido')
    const n = Math.round(num(b.installments, 0)); if (n < 1 || n > 36) e.push('Las cuotas deben estar entre 1 y 36')
    const m = Math.round(num(b.intervalMonths, 1)); if (m < 1 || m > 12) e.push('La periodicidad debe estar entre 1 y 12 meses')
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name).slice(0, 80), program_kind: b.programKind, installments: n, interval_months: m, description: clean(b.description)?.slice(0, 300) ?? null, active: b.active !== false, sort_order: Math.round(num(b.sortOrder, 0)) }
  }
  app.post('/academico/planes-pago', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_payment_plans').insert(planRow(req.body || {})).select('*').single()
    if (duplicate(error)) return fail(res, 'Ya existe un plan con ese nombre', 409); if (error) throw error
    res.status(201).send(planDTO(data))
  }))
  app.put('/academico/planes-pago/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_payment_plans').update(planRow(req.body || {})).eq('id', Number(req.params.id)).select('*').maybeSingle()
    if (duplicate(error)) return fail(res, 'Ya existe un plan con ese nombre', 409); if (error) throw error
    if (!data) return fail(res, 'Plan no encontrado', 404)
    res.send(planDTO(data))
  }))
  app.delete('/academico/planes-pago/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('payment_plan_id', Number(req.params.id))
    if (count) return fail(res, 'El plan ya se usó en matrículas. Desactívalo en lugar de eliminarlo.', 409)
    await must(supabase.from('edu_payment_plans').delete().eq('id', Number(req.params.id))); res.send({ ok: true })
  }))

  const AGREEMENT_KINDS = { empresa: 'Empresa', entidad_publica: 'Entidad pública', ips_practica: 'IPS de práctica', fundacion: 'Fundación / ONG', otro: 'Otro' }
  const agreementDTO = (a) => ({ id: a.id, name: a.name, nit: a.nit, kind: a.kind, kindLabel: AGREEMENT_KINDS[a.kind], contributionPct: Number(a.contribution_pct), contactName: a.contact_name, phone: a.phone, email: a.email, startsOn: a.starts_on, endsOn: a.ends_on, notes: a.notes, active: a.active, enrollments: (a.enrollments || []).filter((e) => ACTIVE_ENROLL.includes(e.status)).length })
  app.get('/academico/convenios', auth(STAFF), hx(async (req, res) => res.send((await must(supabase.from('edu_agreements').select('*, enrollments:edu_enrollments(status)').order('name'))).map(agreementDTO))))
  const agreementRow = (b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre del convenio es requerido')
    if (num(b.contributionPct) < 0 || num(b.contributionPct) > 100) e.push('El aporte debe estar entre 0 y 100 %')
    const ph = V.phoneError(b.phone); if (ph) e.push(ph)
    const em = V.emailError(b.email); if (em) e.push(em)
    if (clean(b.startsOn) && !date(b.startsOn)) e.push('Fecha de inicio inválida')
    if (clean(b.endsOn) && !date(b.endsOn)) e.push('Fecha de fin inválida')
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name).slice(0, 160), nit: clean(b.nit), kind: oneOf(AGREEMENT_KINDS, b.kind, 'empresa'), contribution_pct: num(b.contributionPct), contact_name: clean(b.contactName), phone: V.phone(b.phone), email: clean(b.email)?.toLowerCase() ?? null, starts_on: date(b.startsOn), ends_on: date(b.endsOn), notes: clean(b.notes)?.slice(0, 1000) ?? null, active: b.active !== false }
  }
  app.post('/academico/convenios', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_agreements').insert(agreementRow(req.body || {})).select('*').single()
    if (duplicate(error)) return fail(res, 'Ya existe un convenio con ese nombre', 409); if (error) throw error
    res.status(201).send(agreementDTO(data))
  }))
  app.put('/academico/convenios/:id', auth(ADMIN), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_agreements').update({ ...agreementRow(req.body || {}), updated_at: new Date().toISOString() }).eq('id', Number(req.params.id)).select('*').maybeSingle()
    if (duplicate(error)) return fail(res, 'Ya existe un convenio con ese nombre', 409); if (error) throw error
    if (!data) return fail(res, 'Convenio no encontrado', 404)
    res.send(agreementDTO(data))
  }))
  app.delete('/academico/convenios/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('agreement_id', Number(req.params.id))
    if (count) return fail(res, 'El convenio tiene matrículas. Desactívalo en lugar de eliminarlo.', 409)
    await must(supabase.from('edu_agreements').delete().eq('id', Number(req.params.id))); res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Configuración académica (reglamento y contrato)
  app.get('/academico/configuracion', auth([...STAFF, 'estudiante']), hx(async (req, res) => res.send(await settingsOf())))
  app.put('/academico/configuracion', auth(ADMIN), hx(async (req, res) => {
    const b = req.body || {}
    const cur = await settingsOf()
    const rulesText = clean(b.rulesText)?.slice(0, 60000) ?? null
    // Si cambia el texto del reglamento, sube la versión: las aceptaciones anteriores quedan con su versión.
    let version = clean(b.rulesVersion) || cur.rulesVersion
    if (rulesText !== cur.rulesText && version === cur.rulesVersion && cur.rulesText) { const [ma, mi] = version.split('.').map(Number); version = `${ma || 1}.${(mi || 0) + 1}` }
    const row = { rules_title: clean(b.rulesTitle)?.slice(0, 120) || 'Reglamento estudiantil', rules_text: rulesText, rules_version: version, contract_clauses: clean(b.contractClauses)?.slice(0, 20000) ?? null, refund_policy: clean(b.refundPolicy)?.slice(0, 5000) ?? null, updated_at: new Date().toISOString() }
    // Formato institucional del acta de asistencia, asistencia mínima y director de educación (firma las actas).
    if (b.attendanceFormat) Object.assign(row, { attendance_format_code: clean(b.attendanceFormat.code)?.slice(0, 30) ?? null, attendance_format_name: clean(b.attendanceFormat.name)?.slice(0, 120) || 'Registro de asistencia', attendance_format_version: clean(b.attendanceFormat.version)?.slice(0, 20) ?? null })
    if ('passingScore' in b) { const p = num(b.passingScore, 3); if (p < 0 || p > 5) return fail(res, 'La nota mínima aprobatoria debe estar entre 0 y 5', 400); row.passing_score = p }
    if ('minAttendancePct' in b) { const m = num(b.minAttendancePct, 80); if (m < 0 || m > 100) return fail(res, 'La asistencia mínima debe estar entre 0 y 100 %', 400); row.min_attendance_pct = m }
    if ('directorUserId' in b) {
      const id = Number(b.directorUserId) || null
      if (id) { const u = await must(supabase.from('users').select('id, role, active').eq('id', id).maybeSingle()); if (!u || !u.active || !['administrador', 'empleado', 'docente'].includes(u.role)) return fail(res, 'Director de educación inválido', 400) }
      row.director_user_id = id
    }
    const { data: exists } = await supabase.from('edu_settings').select('org_id').maybeSingle()
    if (exists) await must(supabase.from('edu_settings').update(row).eq('org_id', exists.org_id))
    else await must(supabase.from('edu_settings').insert(row))
    res.send(await settingsOf())
  }))

  // ---------------------------------------------------------------- Contrato de matrícula
  const fmtCop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0)
  const fmtDate = (iso) => (iso ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00`)) : '')
  // Texto del contrato con los datos de la matrícula. Plantilla de referencia (Decreto 1075 de 2015, Ley 1581 de 2012);
  // la institución agrega sus cláusulas y su política de devoluciones en Configuración académica.
  const renderContract = async (raw) => {
    const e = enrollDTO(raw); const st = raw.student; const cfg = await settingsOf()
    const programRow = await must(supabase.from('edu_programs').select('name, kind, cert_type, registration_number, occupation, period_label').eq('id', raw.program_id).single())
    const hours = (await loadProgram(raw.program_id)).totalHours
    const name = `${st.first_name} ${st.last_name}`.trim()
    const plan = e.account.plan.map((q) => `Cuota ${q.number}: ${fmtCop(q.amount)}, con vencimiento el ${fmtDate(q.dueDate)}.`)
    const sections = [
      { title: 'Objeto', paragraphs: [`LA INSTITUCIÓN se compromete a impartir a EL ESTUDIANTE el programa ${programRow.name}${programRow.registration_number ? `, con registro ${programRow.registration_number} ante la Secretaría de Educación` : ''}, con una intensidad de ${hours.toLocaleString('es-CO')} horas${e.period ? `, en el ${e.period.name.toLowerCase()} que aquí se matricula` : ''}${e.group ? `, en el grupo ${e.group.code}` : ''}. Al cumplir los requisitos académicos y administrativos, EL ESTUDIANTE recibirá el ${CERT_TYPES[programRow.cert_type].toLowerCase()}, que no equivale a un título de educación superior.`] },
      { title: 'Valor y forma de pago', paragraphs: [
        `El valor de la matrícula es de ${fmtCop(e.baseValue)}.${e.discountValue > 0 ? ` Se concede un descuento de ${fmtCop(e.discountValue)}${e.discountReason ? ` (${e.discountReason})` : ''}.` : ''}${e.agreementValue > 0 ? ` El convenio ${e.agreementName} aporta ${fmtCop(e.agreementValue)}.` : ''} El valor a cargo de EL ESTUDIANTE es de ${fmtCop(e.totalValue)}, pagadero así:`,
        ...plan,
        'El atraso en los pagos no suspende el contrato, pero LA INSTITUCIÓN podrá abstenerse de expedir certificados y constancias hasta que EL ESTUDIANTE esté a paz y salvo.'
      ] },
      { title: 'Obligaciones de LA INSTITUCIÓN', paragraphs: ['Desarrollar el plan de estudios aprobado con docentes idóneos; disponer de los ambientes de aprendizaje, los escenarios de práctica y los materiales previstos; evaluar las competencias de EL ESTUDIANTE e informarle sus resultados; expedir los certificados a que haya lugar; y reportar la información de matrícula al Sistema de Información de la Educación para el Trabajo y el Desarrollo Humano (SIET) del Ministerio de Educación Nacional.'] },
      { title: 'Obligaciones de EL ESTUDIANTE', paragraphs: ['Asistir a las actividades académicas y prácticas programadas y cumplir la asistencia mínima que fija el reglamento; pagar oportunamente los valores pactados; cumplir el reglamento estudiantil y las normas de los escenarios de práctica; y cuidar los bienes de LA INSTITUCIÓN.'] },
      { title: 'Retiro y devoluciones', paragraphs: [cfg.refundPolicy || 'EL ESTUDIANTE puede retirarse informando por escrito a LA INSTITUCIÓN. Las devoluciones, cuando procedan, se rigen por la política de devoluciones publicada por LA INSTITUCIÓN.'] },
      { title: 'Reglamento estudiantil', paragraphs: [`EL ESTUDIANTE declara que conoce y acepta el ${cfg.rulesTitle.toLowerCase()} (versión ${cfg.rulesVersion}), que hace parte integral de este contrato.`] },
      { title: 'Tratamiento de datos personales', paragraphs: ['EL ESTUDIANTE autoriza a LA INSTITUCIÓN a tratar sus datos personales para los fines académicos, administrativos, de certificación y de reporte a las autoridades educativas, conforme a la Ley 1581 de 2012 y su política de tratamiento de datos. Puede conocer, actualizar, rectificar y suprimir sus datos por los canales de atención de LA INSTITUCIÓN.'] },
      ...(cfg.contractClauses ? [{ title: 'Cláusulas adicionales', paragraphs: cfg.contractClauses.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean) }] : []),
      { title: 'Vigencia', paragraphs: [`Este contrato rige desde el ${fmtDate(e.enrolledAt)} hasta la terminación del ${e.period ? e.period.name.toLowerCase() : 'programa'} matriculado.`] }
    ]
    return {
      title: 'Contrato de matrícula', institution: cfg.institution, logoUrl: cfg.logoUrl,
      intro: `Entre ${cfg.institution || 'LA INSTITUCIÓN'}, institución de educación para el trabajo y el desarrollo humano, en adelante LA INSTITUCIÓN, y ${name}, identificado(a) con ${st.doc_type} ${st.doc_number}, en adelante EL ESTUDIANTE, se celebra el presente contrato de matrícula, que se rige por las cláusulas siguientes y por el Decreto 1075 de 2015.`,
      sections, rules: { title: cfg.rulesTitle, version: cfg.rulesVersion, text: cfg.rulesText }, student: { name, docType: st.doc_type, docNumber: st.doc_number }
    }
  }
  app.get('/academico/matriculas/:id/contrato', auth([...STAFF, 'estudiante']), hx(async (req, res) => {
    const raw = await loadEnrollment(req, req.params.id)
    const e = enrollDTO(raw)
    // Firmado: se muestra el texto que se firmó, no el actual.
    if (raw.contract_signed_at && raw.contract_snapshot) return res.send({ ...raw.contract_snapshot, signed: true, contract: e.contract, enrollmentId: e.id })
    res.send({ ...(await renderContract(raw)), signed: false, contract: e.contract, enrollmentId: e.id })
  }))
  app.post('/academico/matriculas/:id/contrato/firmar', auth([...STAFF, 'estudiante']), hx(async (req, res) => {
    const raw = await loadEnrollment(req, req.params.id)
    if (raw.contract_signed_at) return fail(res, 'El contrato ya está firmado', 409)
    const b = req.body || {}
    if (b.accept !== true) return fail(res, 'Debes declarar que leíste y aceptas el contrato', 400)
    if (b.acceptRules !== true) return fail(res, 'Debes aceptar el reglamento estudiantil', 400)
    const signerName = clean(b.signerName) || `${raw.student.first_name} ${raw.student.last_name}`.trim()
    const url = await uploadImage('signatures', `contrato-${raw.id}`, b.signature, ['image/png', 'image/jpeg'])
    if (!url) return fail(res, 'Dibuja la firma antes de firmar', 400)
    const snapshot = await renderContract(raw)
    const now = new Date().toISOString()
    await must(supabase.from('edu_enrollments').update({
      contract_signed_at: now, contract_signer_name: signerName.slice(0, 160), contract_signer_doc: clean(b.signerDoc) || raw.student.doc_number,
      contract_signature_url: url, contract_snapshot: snapshot, contract_ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 60) || null,
      contract_signed_by_user: req.user.id, rules_accepted_at: now, rules_version: snapshot.rules.version, updated_at: now
    }).eq('id', raw.id))
    res.send(enrollDTO(await loadEnrollment(req, raw.id)))
  }))

  // ---------------------------------------------------------------- Dashboard del director
  app.get('/academico/resumen', auth(STAFF), hx(async (req, res) => {
    const site = scopeSite(req)
    let gq = supabase.from('edu_groups').select('id, code, status, site_id, start_date, end_date, current_period, capacity, program:edu_programs(name, period_label), enrollments:edu_enrollments(status)')
    let sq = supabase.from('edu_students').select('id, status, site_id, gender, birth_date')
    if (site) { gq = gq.eq('site_id', site); sq = sq.eq('site_id', site) }
    const [programs, groups, students, enrollments] = await Promise.all([
      must(supabase.from('edu_programs').select('id, code, name, kind, active, registration_number, registration_expires')),
      must(gq), must(sq),
      must(supabase.from('edu_enrollments').select(ENROLL_SELECT).order('enrolled_at', { ascending: false }).limit(5000))
    ])
    const enr = enrollments.filter((e) => !site || Number(e.student?.site_id) === Number(site))
    // Finanzas: saldo, mora y recaudo del mes; contratos obligatorios sin firmar.
    const accs = enr.filter((e) => e.status !== 'preinscrito').map((e) => ({ e, a: account(e) }))
    const month = todayBogota().slice(0, 7)
    const finance = {
      balance: accs.reduce((x, r) => x + r.a.balance, 0), overdue: accs.reduce((x, r) => x + r.a.overdue, 0),
      inArrears: accs.filter((r) => r.a.state === 'en_mora').length,
      collectedMonth: accs.reduce((x, r) => x + r.a.payments.filter((p) => !p.voided && p.paidAt.slice(0, 7) === month).reduce((y, p) => y + p.amount, 0), 0)
    }
    const contractsPending = enr.filter((e) => e.contract_required && !e.contract_signed_at && ['matriculado', 'preinscrito', 'aplazado'].includes(e.status)).length
    const active = enr.filter((e) => e.status === 'matriculado')
    const activePrograms = programs.filter((p) => p.active)
    const regAlerts = activePrograms.filter((p) => p.kind === 'carrera_tecnica' || p.registration_expires)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, registrationNumber: p.registration_number, expires: p.registration_expires, state: p.registration_expires ? registrationState(p.registration_expires) : 'sin_registro', days: p.registration_expires ? daysUntil(p.registration_expires) : null }))
      .filter((p) => p.state !== 'vigente')
      .sort((a, b) => (a.days ?? -99999) - (b.days ?? -99999))
    const byProgram = activePrograms.map((p) => ({ id: p.id, name: p.name, code: p.code, kind: p.kind, enrolled: active.filter((e) => e.program_id === p.id).length })).filter((p) => p.enrolled).sort((a, b) => b.enrolled - a.enrolled)
    // Gráficas: los valores económicos solo los ve el administrador.
    const isAdmin = req.user.role === 'administrador'
    const months = []; { const [y, m] = month.split('-').map(Number); for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); months.push(d.toISOString().slice(0, 7)) } }
    const mLabel = (k) => new Intl.DateTimeFormat('es-CO', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${k}-15T12:00:00Z`)).replace(' de ', ' ').replace('.', '')
    const runningIds = groups.filter((g) => g.status === 'en_curso').map((g) => g.id)
    const cfgC = await settingsOf()
    const [gItems, monthSessions, certRows] = await Promise.all([
      runningIds.length ? must(supabase.from('edu_grade_items').select('*').in('group_id', runningIds)) : [],
      must(supabase.from('edu_sessions').select('status, modality, group:edu_groups(site_id)').gte('date', `${month}-01`).lt('date', (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) })())),
      must(supabase.from('edu_certificates').select('issued_at, student:edu_students(site_id)').eq('voided', false).gte('issued_at', `${months[0]}-01`))
    ])
    const gGrades = gItems.length ? await must(supabase.from('edu_grades').select('*').in('item_id', gItems.map((i) => i.id))) : []
    const byGroup = []
    for (const g of groups.filter((x) => x.status === 'en_curso')) {
      const st = await attendanceStats([g.id]); const vals = Object.values(st.byStudent).filter((v) => v.pct != null)
      const roster = await rosterOf(g.id); const its = gItems.filter((i) => i.group_id === g.id)
      let ok = 0; let graded = 0
      for (const sid of [...new Set(its.map((i) => i.subject_id))]) for (const s of roster) { const f = finalOf(its.filter((i) => i.subject_id === sid), gGrades, s.id, cfgC.passingScore); if (f.score != null) { graded++; if (f.state === 'aprobado') ok++ } }
      byGroup.push({ code: g.code, attendance: vals.length ? Math.round(vals.reduce((a, v) => a + v.pct, 0) / vals.length) : null, approval: graded ? Math.round((ok / graded) * 100) : null })
    }
    const age = (iso) => { if (!iso) return null; const t = todayBogota(); let a = Number(t.slice(0, 4)) - Number(iso.slice(0, 4)); if (t.slice(5) < iso.slice(5, 10)) a--; return a }
    const AGE = [['Menor de 18', 0, 17], ['18 a 24', 18, 24], ['25 a 34', 25, 34], ['35 a 44', 35, 44], ['45 o más', 45, 200]]
    const activeSt = students.filter((x) => x.status === 'activo')
    const ms = monthSessions.filter((x) => !site || Number(x.group?.site_id) === Number(site))
    const KINDS_L = { curso: 'Cursos', diplomado: 'Diplomados', carrera_tecnica: 'Carreras técnicas' }
    const charts = {
      enrollmentsByMonth: months.map((k) => ({ month: mLabel(k), matriculas: enr.filter((e) => e.status !== 'preinscrito' && String(e.enrolled_at).slice(0, 7) === k).length, certificados: certRows.filter((c) => (!site || Number(c.student?.site_id) === Number(site)) && String(c.issued_at).slice(0, 7) === k).length })),
      studentsByStatus: Object.entries(students.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a }, {})).map(([k, v]) => ({ name: { activo: 'Activos', graduado: 'Graduados', retirado: 'Retirados', inactivo: 'Inactivos', aplazado: 'Aplazados' }[k] || k, value: v })),
      byKind: Object.entries(KINDS_L).map(([k, name]) => ({ name, value: active.filter((e) => e.program?.kind === k).length })).filter((x) => x.value),
      byGroup,
      sessionsMonth: [{ name: 'Realizadas', value: ms.filter((x) => x.status === 'realizada').length }, { name: 'Programadas', value: ms.filter((x) => x.status === 'programada').length }, { name: 'Canceladas', value: ms.filter((x) => x.status === 'cancelada').length }],
      modality: [{ name: 'Presencial', value: ms.filter((x) => x.status !== 'cancelada' && x.modality === 'presencial').length }, { name: 'Virtual', value: ms.filter((x) => x.status !== 'cancelada' && x.modality === 'virtual').length }].filter((x) => x.value),
      gender: Object.entries(activeSt.reduce((a, x) => { const k = x.gender || 'Sin dato'; a[k] = (a[k] || 0) + 1; return a }, {})).map(([name, value]) => ({ name, value })),
      ages: [...AGE.map(([name, lo, hi]) => ({ name, value: activeSt.filter((x) => { const a = age(x.birth_date); return a != null && a >= lo && a <= hi }).length })), { name: 'Sin dato', value: activeSt.filter((x) => !x.birth_date).length }].filter((x) => x.value || x.name !== 'Sin dato'),
      minAttendance: cfgC.minAttendancePct,
      ...(isAdmin ? {
        collectionsByMonth: months.map((k) => ({ month: mLabel(k), recaudo: accs.reduce((x, r) => x + r.a.payments.filter((p) => !p.voided && String(p.paidAt).slice(0, 7) === k).reduce((y, p) => y + p.amount, 0), 0) })),
        aging: [['Al día', (a) => a.balance > 0 && !a.maxDaysLate], ['1 a 30 días', (a) => a.maxDaysLate >= 1 && a.maxDaysLate <= 30], ['31 a 60 días', (a) => a.maxDaysLate > 30 && a.maxDaysLate <= 60], ['61 a 90 días', (a) => a.maxDaysLate > 60 && a.maxDaysLate <= 90], ['Más de 90 días', (a) => a.maxDaysLate > 90]].map(([name, f]) => ({ name, value: Math.round(accs.filter((r) => f(r.a)).reduce((x, r) => x + r.a.balance, 0)) }))
      } : {})
    }
    res.send({ charts,
      students: { total: students.length, active: students.filter((s) => s.status === 'activo').length, graduated: students.filter((s) => s.status === 'graduado').length },
      programs: { active: activePrograms.length, technical: activePrograms.filter((p) => p.kind === 'carrera_tecnica').length, registrationAlerts: regAlerts.length },
      groups: { running: groups.filter((g) => g.status === 'en_curso').length, planned: groups.filter((g) => g.status === 'planeado').length },
      enrollments: { active: active.length, preinscritos: enr.filter((e) => e.status === 'preinscrito').length, value: isAdmin ? active.reduce((a, e) => a + Number(e.total_value), 0) : null },
      byProgram, finance: isAdmin ? finance : null, contractsPending, attendance: await (async () => { const st = await attendanceStats(groups.filter((g) => g.status === 'en_curso').map((g) => g.id)); const vals = Object.values(st.byStudent).filter((v) => v.pct != null); const cfgA = await settingsOf(); const { data: pend } = await supabase.from('edu_sessions').select('id', { count: 'exact' }).not('teacher_signed_at', 'is', null).is('director_signed_at', null); return { avgPct: vals.length ? Math.round(vals.reduce((x, v) => x + v.pct, 0) / vals.length * 10) / 10 : null, atRisk: vals.filter((v) => v.pct < cfgA.minAttendancePct).length, minPct: cfgA.minAttendancePct, actasPendientes: (pend || []).length } })(),
      registrationAlerts: regAlerts,
      runningGroups: groups.filter((g) => ['en_curso', 'planeado'].includes(g.status)).sort((a, b) => (a.status === b.status ? 0 : a.status === 'en_curso' ? -1 : 1)).slice(0, 12).map((g) => ({
        id: g.id, code: g.code, status: g.status, statusLabel: GROUP_STATUS[g.status], program: g.program?.name, periodLabel: g.program?.period_label, currentPeriod: g.current_period,
        startDate: g.start_date, endDate: g.end_date, capacity: g.capacity, enrolled: (g.enrollments || []).filter((e) => e.status === 'matriculado').length
      })),
      recent: enr.slice(0, 8).map((e) => ({ id: e.id, student: e.student ? `${e.student.first_name} ${e.student.last_name}` : '', program: e.program?.name, status: e.status, statusLabel: ENROLL_STATUS[e.status], enrolledAt: e.enrolled_at, totalValue: isAdmin ? Number(e.total_value) : null }))
    })
  }))

  // ---------------------------------------------------------------- Horarios y clases (fase 3)
  // Un horario (plantilla) genera las clases concretas entre su inicio y su fin en los días elegidos (1 = lunes … 7 = domingo).
  // Cada clase se reprograma, cambia de enlace o se cancela por separado; en la fase 4 lleva la asistencia.
  const PLATFORMS = { meet: 'Google Meet', teams: 'Microsoft Teams', zoom: 'Zoom', otro: 'Otra plataforma' }
  const WEEKDAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']
  const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
  const hhmm = (t) => String(t || '').slice(0, 5)
  const isoWeekday = (iso) => { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d }
  const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const URL_RE = /^https:\/\/[^\s]+$/i
  const tg = () => notifier?.()
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const fmtDay = (iso) => new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`))
  const SEP = '━━━━━━━━━━━━━━━'

  const SESSION_SELECT = '*, group:edu_groups(id, code, site_id, program_id, telegram_chat_id, program:edu_programs(id, name, code)), subject:edu_subjects(id, name, hours), teacher:users!edu_sessions_teacher_user_id_fkey(id, name, last_name), classroom:edu_classrooms(id, name, capacity)'
  const SCHEDULE_SELECT = '*, group:edu_groups(id, code, site_id, telegram_chat_id, program:edu_programs(id, name, code)), subject:edu_subjects(id, name), teacher:users!edu_schedules_teacher_user_id_fkey(id, name, last_name), classroom:edu_classrooms(id, name, capacity), sessions:edu_sessions(id, date, status)'
  const teacherName = (t) => (t ? `${t.name} ${t.last_name}`.trim() : null)
  const sessionDTO = (x) => ({
    id: x.id, scheduleId: x.schedule_id, groupId: x.group_id, group: x.group ? { id: x.group.id, code: x.group.code, siteId: x.group.site_id, program: x.group.program?.name ?? null, programCode: x.group.program?.code ?? null } : null,
    subjectId: x.subject_id, subject: x.subject?.name ?? null, teacherId: x.teacher_user_id, teacher: teacherName(x.teacher),
    date: x.date, startTime: hhmm(x.start_time), endTime: hhmm(x.end_time), modality: x.modality, platform: x.platform, platformLabel: PLATFORMS[x.platform] ?? null,
    meetingUrl: x.meeting_url, location: x.location, classroomId: x.classroom_id, classroom: x.classroom?.name ?? null, topic: x.topic, status: x.status, cancelReason: x.cancel_reason, rescheduledFrom: x.rescheduled_from, notifiedAt: x.notified_at
  })
  const scheduleDTO = (x) => {
    const today = todayBogota()
    const sessions = x.sessions || []
    return {
      id: x.id, groupId: x.group_id, group: x.group ? { id: x.group.id, code: x.group.code, program: x.group.program?.name ?? null } : null,
      subjectId: x.subject_id, subject: x.subject?.name ?? null, teacherId: x.teacher_user_id, teacher: teacherName(x.teacher),
      modality: x.modality, platform: x.platform, platformLabel: PLATFORMS[x.platform] ?? null, meetingUrl: x.meeting_url, location: x.location, classroomId: x.classroom_id, classroom: x.classroom?.name ?? null,
      weekdays: x.weekdays, weekdaysLabel: x.weekdays.map((d) => WEEKDAYS[d]).join(', '), startTime: hhmm(x.start_time), endTime: hhmm(x.end_time),
      startsOn: x.starts_on, endsOn: x.ends_on, notes: x.notes, active: x.active,
      sessions: { total: sessions.filter((s) => s.status !== 'cancelada').length, upcoming: sessions.filter((s) => s.status === 'programada' && s.date >= today).length, done: sessions.filter((s) => s.status === 'realizada').length, cancelled: sessions.filter((s) => s.status === 'cancelada').length }
    }
  }
  // Mensaje de Telegram de una clase (o de un horario nuevo).
  const sessionMsg = (title, x, extra = []) => {
    const where = x.modality === 'virtual'
      ? `💻 Virtual · ${esc(PLATFORMS[x.platform] || 'en línea')}${x.meeting_url ? `\n🔗 <a href="${esc(x.meeting_url)}">Entrar a la clase</a>` : ''}`
      : `🏫 Presencial${x.location ? ` · ${esc(x.location)}` : ''}`
    return [`<b>${title}</b>`, SEP, `🎓 ${esc(x.group?.program?.name || '')} · grupo <b>${esc(x.group?.code || '')}</b>`, x.subject?.name ? `📘 ${esc(x.subject.name)}` : null, `📅 ${esc(fmtDay(x.date))} · ${hhmm(x.start_time)}–${hhmm(x.end_time)}`, where, x.teacher ? `👩‍🏫 ${esc(teacherName(x.teacher))}` : null, ...extra].filter(Boolean).join('\n')
  }
  // Avisa en el grupo de Telegram del grupo académico y en la sección "Clases de educación" (sede del grupo).
  const announce = (group, html) => {
    const n = tg(); if (!n) return
    if (group?.telegram_chat_id) n.toChat(group.telegram_chat_id, html)
    n.notify('academico', html, group?.site_id)
  }

  const loadGroupForClass = async (req, groupId) => {
    const g = await must(supabase.from('edu_groups').select('id, code, site_id, program_id, telegram_chat_id, program:edu_programs(id, name)').eq('id', Number(groupId)).maybeSingle())
    if (!g) throw httpError(400, 'Selecciona el grupo')
    if (!canAccessSite(req, g.site_id)) throw httpError(403, 'Ese grupo es de otra sede')
    return g
  }
  const classFields = async (b, g, current = {}) => {
    const e = []
    const subjectId = 'subjectId' in b ? (Number(b.subjectId) || null) : current.subject_id ?? null
    if ('subjectId' in b && subjectId) {
      const sub = await must(supabase.from('edu_subjects').select('id, program_id').eq('id', subjectId).maybeSingle())
      if (!sub || sub.program_id !== g.program_id) e.push('La asignatura no pertenece al programa del grupo')
    }
    const teacherId = 'teacherId' in b ? (Number(b.teacherId) || null) : current.teacher_user_id ?? null
    if ('teacherId' in b && teacherId) {
      const t = await must(supabase.from('users').select('id, role, active').eq('id', teacherId).maybeSingle())
      if (!t || !t.active || !['docente', 'empleado', 'administrador'].includes(t.role)) e.push('Docente inválido')
    }
    const modality = 'modality' in b ? (['presencial', 'virtual'].includes(b.modality) ? b.modality : null) : current.modality
    if (!modality) e.push('Modalidad inválida')
    const platform = modality === 'virtual' ? ('platform' in b ? (PLATFORMS[b.platform] ? b.platform : null) : current.platform) : null
    const url = modality === 'virtual' ? ('meetingUrl' in b ? clean(b.meetingUrl) : current.meeting_url) : null
    if (modality === 'virtual' && !platform) e.push('Elige la plataforma de la clase virtual')
    if (url && !URL_RE.test(url)) e.push('El enlace de la clase debe empezar por https://')
    const start = 'startTime' in b ? clean(b.startTime) : hhmm(current.start_time)
    const end = 'endTime' in b ? clean(b.endTime) : hhmm(current.end_time)
    if (!TIME.test(start || '') || !TIME.test(end || '')) e.push('Hora inválida (HH:MM)')
    else if (end <= start) e.push('La hora de fin debe ser posterior a la de inicio')
    // Aula del catálogo (clases presenciales): activa y de la sede del grupo (o sin sede).
    const classroomId = modality === 'presencial' ? ('classroomId' in b ? (Number(b.classroomId) || null) : current.classroom_id ?? null) : null
    let room = null
    if (classroomId) {
      room = await must(supabase.from('edu_classrooms').select('id, name, site_id, active').eq('id', classroomId).maybeSingle())
      if (!room) e.push('Aula inválida')
      else if (!room.active && Number(current.classroom_id) !== room.id) e.push('El aula está inactiva')
      else if (room.site_id && g.site_id && Number(room.site_id) !== Number(g.site_id)) e.push('El aula es de otra sede')
    }
    // Si la institución ya tiene aulas configuradas, toda clase presencial debe tener aula (para controlar los cruces).
    if (modality === 'presencial' && !classroomId && 'classroomId' in b) {
      const { count } = await supabase.from('edu_classrooms').select('id', { count: 'exact', head: true }).eq('active', true)
      if (count) e.push('Elige el aula o salón de la clase presencial')
    }
    if (e.length) throw httpError(400, e.join('. '))
    const location = modality === 'presencial' ? (room ? room.name : ('location' in b ? clean(b.location)?.slice(0, 120) ?? null : current.location)) : null
    return { subject_id: subjectId, teacher_user_id: teacherId, modality, platform, meeting_url: url, classroom_id: room ? room.id : null, location, start_time: start, end_time: end }
  }
  // Cruces de horario (bloqueo, no advertencia): en una misma fecha y hora no puede haber dos clases
  // en la misma aula, con el mismo docente, del mismo grupo ni con estudiantes en común (matrículas activas).
  const STUDYING = ['preinscrito', 'matriculado', 'aplazado']
  const overlaps = (x, start, end) => hhmm(x.start_time) < end && hhmm(x.end_time) > start
  const findClash = async ({ dates, start, end, teacherId, classroomId, groupId, exceptSchedule = null, exceptIds = [] }) => {
    if (!dates.length) return null
    const { data: mine } = await supabase.from('edu_enrollments').select('student_id').eq('group_id', groupId).in('status', STUDYING)
    const studentIds = [...new Set((mine || []).map((e) => e.student_id))]
    const { data: others } = studentIds.length ? await supabase.from('edu_enrollments').select('group_id, student_id').in('student_id', studentIds).in('status', STUDYING).not('group_id', 'is', null) : { data: [] }
    const groupIds = [...new Set([groupId, ...(others || []).map((x) => x.group_id)])]
    const or = [`group_id.in.(${groupIds.join(',')})`]
    if (teacherId) or.push(`teacher_user_id.eq.${teacherId}`)
    if (classroomId) or.push(`classroom_id.eq.${classroomId}`)
    const found = []
    for (let i = 0; i < dates.length; i += 120) {
      const { data, error } = await supabase.from('edu_sessions').select('id, date, start_time, end_time, schedule_id, group_id, teacher_user_id, classroom_id, group:edu_groups(code), classroom:edu_classrooms(name)').in('date', dates.slice(i, i + 120)).neq('status', 'cancelada').or(or.join(','))
      if (error) throw error
      found.push(...(data || []))
    }
    const hits = found.filter((x) => !exceptIds.includes(x.id) && !(exceptSchedule && x.schedule_id === exceptSchedule) && overlaps(x, start, end)).sort((a, b) => (a.date < b.date ? -1 : 1))
    for (const x of hits) {
      const when = `el ${fmtDay(x.date)} de ${hhmm(x.start_time)} a ${hhmm(x.end_time)}`
      if (classroomId && Number(x.classroom_id) === Number(classroomId)) return `El aula ${x.classroom?.name || ''} ya está ocupada ${when} (grupo ${x.group?.code}).`
      if (teacherId && Number(x.teacher_user_id) === Number(teacherId)) return `El docente ya tiene clase ${when} (grupo ${x.group?.code}).`
      if (Number(x.group_id) === Number(groupId)) return `El grupo ya tiene otra clase ${when}.`
      const shared = (others || []).find((o) => o.group_id === x.group_id)
      if (shared) {
        const st = await must(supabase.from('edu_students').select('first_name, last_name').eq('id', shared.student_id).maybeSingle())
        return `${st ? `${st.first_name} ${st.last_name}`.trim() : 'Un estudiante del grupo'} también está en el grupo ${x.group?.code}, que tiene clase ${when}.`
      }
    }
    return null
  }

  // Aulas y salones (catálogo por sede)
  const ROOM_KINDS = { aula: 'Aula', laboratorio: 'Laboratorio', simulacion: 'Sala de simulación', auditorio: 'Auditorio', practica: 'Escenario de práctica', otro: 'Otro' }
  const roomDTO = (r) => ({ id: r.id, name: r.name, siteId: r.site_id, siteName: r.site?.name ?? null, kind: r.kind, kindLabel: ROOM_KINDS[r.kind], capacity: r.capacity, resources: r.resources, active: r.active, upcoming: (r.sessions || []).filter((x) => x.date >= todayBogota() && x.status === 'programada').length })
  app.get('/academico/aulas', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_classrooms').select('*, site:sites(name), sessions:edu_sessions(date, status)').order('name')
    const site = Number(req.query.sede) || (req.user.role === 'administrador' ? null : req.user.site_id)
    if (site) q = q.or(`site_id.eq.${site},site_id.is.null`)
    res.send((await must(q)).map(roomDTO))
  }))
  const roomRow = async (req, b) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre del aula es requerido')
    const cap = b.capacity === '' || b.capacity == null ? null : Math.round(num(b.capacity, 0))
    if (cap !== null && cap < 1) e.push('La capacidad debe ser mayor que cero')
    if (e.length) throw httpError(400, e.join('. '))
    return { name: clean(b.name).slice(0, 80), site_id: await targetSite(req, b.siteId), kind: oneOf(ROOM_KINDS, b.kind, 'aula'), capacity: cap, resources: clean(b.resources)?.slice(0, 300) ?? null, active: b.active !== false, updated_at: new Date().toISOString() }
  }
  app.post('/academico/aulas', auth(STAFF), hx(async (req, res) => {
    const { data, error } = await supabase.from('edu_classrooms').insert(await roomRow(req, req.body || {})).select('*, site:sites(name)').single()
    if (duplicate(error)) return fail(res, 'Ya existe un aula con ese nombre en la sede', 409); if (error) throw error
    res.status(201).send(roomDTO(data))
  }))
  app.put('/academico/aulas/:id', auth(STAFF), hx(async (req, res) => {
    const { data: cur } = await supabase.from('edu_classrooms').select('id, site_id').eq('id', Number(req.params.id)).maybeSingle()
    if (!cur) return fail(res, 'Aula no encontrada', 404)
    if (cur.site_id && !canAccessSite(req, cur.site_id)) return fail(res, 'Esa aula es de otra sede', 403)
    const row = await roomRow(req, req.body || {})
    const { data, error } = await supabase.from('edu_classrooms').update(row).eq('id', cur.id).select('*, site:sites(name)').single()
    if (duplicate(error)) return fail(res, 'Ya existe un aula con ese nombre en la sede', 409); if (error) throw error
    // El nombre del aula se copia en las clases futuras (aparece en los avisos y en el horario).
    await supabase.from('edu_sessions').update({ location: data.name }).eq('classroom_id', cur.id).gte('date', todayBogota()).eq('status', 'programada')
    res.send(roomDTO(data))
  }))
  app.delete('/academico/aulas/:id', auth(ADMIN), hx(async (req, res) => {
    const { count } = await supabase.from('edu_sessions').select('id', { count: 'exact', head: true }).eq('classroom_id', Number(req.params.id))
    if (count) return fail(res, 'El aula ya tiene clases. Desactívala en lugar de eliminarla.', 409)
    await must(supabase.from('edu_classrooms').delete().eq('id', Number(req.params.id)))
    res.send({ ok: true })
  }))

  app.get('/academico/docentes', auth(STAFF), hx(async (req, res) => {
    const rows = await must(supabase.from('users').select('id, name, last_name, role, site_id, active').in('role', ['docente', 'empleado', 'administrador']).eq('active', true).order('name'))
    res.send(rows.map((u) => ({ id: u.id, fullName: teacherName(u), role: u.role, siteId: u.site_id })).sort((a, b) => (a.role === 'docente' ? 0 : 1) - (b.role === 'docente' ? 0 : 1) || a.fullName.localeCompare(b.fullName)))
  }))
  app.get('/academico/telegram/grupos', auth(ADMIN), hx(async (req, res) => {
    const n = tg(); if (!n) return fail(res, 'Telegram no está disponible', 400)
    res.send({ groups: await n.findGroups() })
  }))
  app.post('/academico/grupos/:id/telegram/prueba', auth(ADMIN), hx(async (req, res) => {
    const g = await loadGroup(req.params.id)
    if (!g.telegram_chat_id) return fail(res, 'El grupo no tiene grupo de Telegram', 400)
    tg()?.toChat(g.telegram_chat_id, `✅ <b>Prueba de Integra · Educación</b>\nEste grupo de Telegram recibirá los avisos de clases del grupo <b>${esc(g.code)}</b> (${esc(g.program?.name || '')}).`)
    res.send({ ok: true })
  }))

  // Horarios
  app.get('/academico/horarios', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_schedules').select(SCHEDULE_SELECT).order('starts_on', { ascending: false })
    if (Number(req.query.grupo)) q = q.eq('group_id', Number(req.query.grupo))
    const site = scopeSite(req)
    res.send((await must(q)).filter((x) => !site || Number(x.group?.site_id) === Number(site)).map(scheduleDTO))
  }))
  const scheduleRow = async (req, b, current = {}) => {
    const g = await loadGroupForClass(req, b.groupId ?? current.group_id)
    const f = await classFields(b, g, current)
    const e = []
    const weekdays = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : current.weekdays || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort()
    if (!weekdays.length) e.push('Elige al menos un día de la semana')
    const startsOn = date(b.startsOn) || current.starts_on; const endsOn = date(b.endsOn) || current.ends_on
    if (!startsOn || !endsOn) e.push('Indica las fechas de inicio y fin del horario')
    else if (endsOn < startsOn) e.push('La fecha de fin es anterior a la de inicio')
    else if (daysUntil(endsOn) - daysUntil(startsOn) > 400) e.push('El horario no puede durar más de 400 días')
    if (e.length) throw httpError(400, e.join('. '))
    return { g, row: { group_id: g.id, ...f, weekdays, starts_on: startsOn, ends_on: endsOn, notes: clean(b.notes)?.slice(0, 500) ?? null, active: b.active !== false } }
  }
  const datesOf = (row, from) => {
    const out = []
    for (let d = row.starts_on > from ? row.starts_on : from; d <= row.ends_on && out.length < 400; d = addDays(d, 1)) if (row.weekdays.includes(isoWeekday(d))) out.push(d)
    return out
  }
  const generate = async (scheduleId, row, from) => {
    const dates = datesOf(row, from)
    if (!dates.length) return 0
    const base = { schedule_id: scheduleId, group_id: row.group_id, subject_id: row.subject_id, teacher_user_id: row.teacher_user_id, start_time: row.start_time, end_time: row.end_time, modality: row.modality, platform: row.platform, meeting_url: row.meeting_url, location: row.location, classroom_id: row.classroom_id }
    await must(supabase.from('edu_sessions').insert(dates.map((date) => ({ ...base, date }))))
    return dates.length
  }
  const scheduleClashes = (row, exceptSchedule, from) => findClash({ dates: datesOf(row, from || row.starts_on), start: row.start_time, end: row.end_time, teacherId: row.teacher_user_id, classroomId: row.classroom_id, groupId: row.group_id, exceptSchedule })
  const loadSchedule = async (req, id) => {
    const x = await must(supabase.from('edu_schedules').select(SCHEDULE_SELECT).eq('id', Number(id)).maybeSingle())
    if (!x) throw httpError(404, 'Horario no encontrado')
    if (!canAccessSite(req, x.group?.site_id)) throw httpError(403, 'Ese horario es de otra sede')
    return x
  }
  app.post('/academico/horarios', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const { g, row } = await scheduleRow(req, b)
    const clash = await scheduleClashes(row)
    if (clash) return fail(res, clash, 409)
    const x = await must(supabase.from('edu_schedules').insert({ ...row, created_by: req.user.id }).select('id').single())
    const count = await generate(x.id, row, row.starts_on)
    const full = await loadSchedule(req, x.id)
    if (b.notify !== false && count) {
      const first = await must(supabase.from('edu_sessions').select(SESSION_SELECT).eq('schedule_id', x.id).order('date').limit(1).single())
      announce(g, sessionMsg('📅 Nuevo horario de clases', first, [`🔁 Cada ${esc(full.weekdays.map((d) => WEEKDAYS[d]).join(', '))} hasta el ${esc(fmtDay(row.ends_on))}`, `🗓️ ${count} clases programadas`]))
    }
    res.status(201).send({ ...scheduleDTO(full), generated: count })
  }))
  // Editar un horario: actualiza la plantilla y rehace las clases futuras que siguen programadas (las pasadas, realizadas o canceladas no se tocan).
  app.put('/academico/horarios/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadSchedule(req, req.params.id)
    const b = req.body || {}
    const { g, row } = await scheduleRow(req, { ...b, groupId: cur.group_id }, cur)
    // Al editar, las clases futuras del mismo horario se rehacen: no cuentan como cruce.
    const clash = row.active ? await scheduleClashes(row, cur.id, todayBogota()) : null
    if (clash) return fail(res, clash, 409)
    await must(supabase.from('edu_schedules').update({ ...row, updated_at: new Date().toISOString() }).eq('id', cur.id))
    const today = todayBogota()
    await must(supabase.from('edu_sessions').delete().eq('schedule_id', cur.id).eq('status', 'programada').gte('date', today))
    const count = row.active ? await generate(cur.id, row, today) : 0
    if (b.notify !== false) announce(g, [`<b>✏️ Cambio de horario</b>`, SEP, `🎓 ${esc(g.program?.name || '')} · grupo <b>${esc(g.code)}</b>`, `🔁 Cada ${esc(row.weekdays.map((d) => WEEKDAYS[d]).join(', '))} · ${row.start_time}–${row.end_time}`, row.modality === 'virtual' ? `💻 Virtual · ${esc(PLATFORMS[row.platform] || '')}${row.meeting_url ? `\n🔗 <a href="${esc(row.meeting_url)}">Entrar a la clase</a>` : ''}` : `🏫 Presencial${row.location ? ` · ${esc(row.location)}` : ''}`, `🗓️ Desde hoy hasta el ${esc(fmtDay(row.ends_on))} (${count} clases)`].join('\n'))
    res.send({ ...scheduleDTO(await loadSchedule(req, cur.id)), generated: count })
  }))
  app.delete('/academico/horarios/:id', auth(STAFF), hx(async (req, res) => {
    const cur = await loadSchedule(req, req.params.id)
    // Las clases pasadas o realizadas se conservan (sin horario); las futuras programadas se eliminan.
    await must(supabase.from('edu_sessions').delete().eq('schedule_id', cur.id).eq('status', 'programada').gte('date', todayBogota()))
    await must(supabase.from('edu_schedules').delete().eq('id', cur.id))
    res.send({ ok: true })
  }))

  // Clases
  const loadSession = async (req, id) => {
    const x = await must(supabase.from('edu_sessions').select(SESSION_SELECT).eq('id', Number(id)).maybeSingle())
    if (!x) throw httpError(404, 'Clase no encontrada')
    if (req.user.role === 'docente') { if (Number(x.teacher_user_id) !== Number(req.user.id)) throw httpError(403, 'Esa clase no es tuya') } else if (!canAccessSite(req, x.group?.site_id)) throw httpError(403, 'Esa clase es de otra sede')
    return x
  }
  const sessionsQuery = (req) => {
    const from = date(req.query.desde) || todayBogota(); const to = date(req.query.hasta) || addDays(from, 6)
    let q = supabase.from('edu_sessions').select(SESSION_SELECT).gte('date', from).lte('date', to).order('date').order('start_time')
    if (Number(req.query.grupo)) q = q.eq('group_id', Number(req.query.grupo))
    if (Number(req.query.docente)) q = q.eq('teacher_user_id', Number(req.query.docente))
    if (!req.query.canceladas) q = q.neq('status', 'cancelada')
    return q
  }
  app.get('/academico/clases', auth(STAFF), hx(async (req, res) => {
    const site = scopeSite(req)
    res.send((await must(sessionsQuery(req))).filter((x) => !site || Number(x.group?.site_id) === Number(site)).map(sessionDTO))
  }))
  app.get('/academico/clases/:id', auth([...STAFF, 'docente']), hx(async (req, res) => res.send(sessionDTO(await loadSession(req, req.params.id)))))
  // Clase suelta (fuera del horario): recuperación, refuerzo, examen…
  app.post('/academico/clases', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const g = await loadGroupForClass(req, b.groupId)
    const f = await classFields(b, g)
    const day = date(b.date); if (!day) return fail(res, 'Indica la fecha de la clase', 400)
    const clash = await findClash({ dates: [day], start: f.start_time, end: f.end_time, teacherId: f.teacher_user_id, classroomId: f.classroom_id, groupId: g.id })
    if (clash) return fail(res, clash, 409)
    const x = await must(supabase.from('edu_sessions').insert({ ...f, group_id: g.id, date: day, topic: clean(b.topic)?.slice(0, 200) ?? null }).select('id').single())
    const full = await loadSession(req, x.id)
    if (b.notify !== false) { announce(full.group, sessionMsg('📅 Clase programada', full, full.topic ? [`📝 ${esc(full.topic)}`] : [])); await supabase.from('edu_sessions').update({ notified_at: new Date().toISOString() }).eq('id', x.id) }
    res.status(201).send(sessionDTO(full))
  }))
  // Editar una clase: el personal la reprograma (fecha y hora), cambia docente, modalidad, salón o enlace;
  // el docente solo cambia el enlace, el tema y la marca como realizada.
  app.put('/academico/clases/:id', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const cur = await loadSession(req, req.params.id)
    if (cur.status === 'cancelada') return fail(res, 'La clase está cancelada', 409)
    const b = req.body || {}
    const teacher = req.user.role === 'docente'
    const allowed = teacher ? Object.fromEntries(Object.entries(b).filter(([k]) => ['meetingUrl', 'platform', 'topic', 'status'].includes(k))) : b
    const f = await classFields(allowed, cur.group, cur)
    const day = teacher ? cur.date : (date(b.date) || cur.date)
    const status = ['programada', 'realizada'].includes(allowed.status) ? allowed.status : cur.status
    if (!teacher && status === 'programada' && (day !== cur.date || f.start_time !== hhmm(cur.start_time) || f.end_time !== hhmm(cur.end_time) || f.teacher_user_id !== cur.teacher_user_id || f.classroom_id !== cur.classroom_id)) {
      const clash = await findClash({ dates: [day], start: f.start_time, end: f.end_time, teacherId: f.teacher_user_id, classroomId: f.classroom_id, groupId: cur.group_id, exceptIds: [cur.id] })
      if (clash) return fail(res, clash, 409)
    }
    const moved = day !== cur.date || f.start_time !== hhmm(cur.start_time)
    const patch = { ...f, date: day, status, topic: 'topic' in allowed ? clean(allowed.topic)?.slice(0, 200) ?? null : cur.topic, updated_at: new Date().toISOString(), ...(moved && !cur.rescheduled_from ? { rescheduled_from: cur.date } : {}) }
    await must(supabase.from('edu_sessions').update(patch).eq('id', cur.id))
    const full = await loadSession(req, cur.id)
    const relevant = moved || f.meeting_url !== cur.meeting_url || f.modality !== cur.modality || f.location !== cur.location || f.teacher_user_id !== cur.teacher_user_id
    if (relevant && status === 'programada' && b.notify !== false) {
      announce(full.group, sessionMsg(moved ? '🔄 Clase reprogramada' : '✏️ Cambio en la clase', full, moved ? [`⏪ Antes: ${esc(fmtDay(cur.date))} · ${hhmm(cur.start_time)}`] : []))
      await supabase.from('edu_sessions').update({ notified_at: new Date().toISOString() }).eq('id', cur.id)
    }
    res.send(sessionDTO(full))
  }))
  app.post('/academico/clases/:id/cancelar', auth(STAFF), hx(async (req, res) => {
    const cur = await loadSession(req, req.params.id)
    if (cur.status !== 'programada') return fail(res, 'Solo se cancelan clases programadas', 409)
    const reason = clean(req.body?.reason)
    if (!reason) return fail(res, 'Indica el motivo de la cancelación', 400)
    await must(supabase.from('edu_sessions').update({ status: 'cancelada', cancel_reason: reason.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', cur.id))
    if (req.body?.notify !== false) announce(cur.group, sessionMsg('❌ Clase cancelada', cur, [`💬 ${esc(reason)}`]))
    res.send(sessionDTO(await loadSession(req, cur.id)))
  }))
  app.post('/academico/clases/:id/notificar', auth(STAFF), hx(async (req, res) => {
    const cur = await loadSession(req, req.params.id)
    if (cur.status !== 'programada') return fail(res, 'Solo se avisan clases programadas', 409)
    announce(cur.group, sessionMsg('🔔 Recordatorio de clase', cur, cur.topic ? [`📝 ${esc(cur.topic)}`] : []))
    await supabase.from('edu_sessions').update({ notified_at: new Date().toISOString() }).eq('id', cur.id)
    res.send({ ok: true })
  }))

  // Panel del docente: sus clases de hoy y de la semana, sus grupos e indicadores.
  app.get('/academico/docente/resumen', auth(['docente', ...STAFF]), hx(async (req, res) => {
    const me = req.user.role === 'docente' ? req.user.id : (Number(req.query.docente) || req.user.id)
    const today = todayBogota(); const week = addDays(today, 6); const monthStart = `${today.slice(0, 7)}-01`
    const [upcoming, month] = await Promise.all([
      must(supabase.from('edu_sessions').select(SESSION_SELECT).eq('teacher_user_id', me).gte('date', today).lte('date', week).neq('status', 'cancelada').order('date').order('start_time')),
      must(supabase.from('edu_sessions').select('id, status, start_time, end_time, group_id').eq('teacher_user_id', me).gte('date', monthStart).lte('date', today))
    ])
    const groupIds = [...new Set([...upcoming.map((x) => x.group_id), ...month.map((x) => x.group_id)])]
    const groups = groupIds.length ? await must(supabase.from('edu_groups').select('id, code, status, current_period, program:edu_programs(name, period_label), enrollments:edu_enrollments(status)').in('id', groupIds)) : []
    const att = await attendanceStats(groupIds)
    const cfgT = await settingsOf()
    const riskIds = Object.entries(att.byStudent).filter(([, v]) => v.pct != null && v.pct < cfgT.minAttendancePct).map(([k]) => Number(k))
    const riskStudents = riskIds.length ? await must(supabase.from('edu_students').select('id, first_name, last_name').in('id', riskIds)) : []
    const toClose = await must(supabase.from('edu_sessions').select('id, date, start_time, end_time, group:edu_groups(code), subject:edu_subjects(name)').eq('teacher_user_id', me).lte('date', today).neq('status', 'cancelada').is('teacher_signed_at', null).order('date', { ascending: false }).limit(20))
    const minutes = (x) => { const [a, b] = [hhmm(x.start_time), hhmm(x.end_time)].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))); return b - a }
    // Gráficas del panel: horas por semana (8 semanas), asistencia y aprobación por grupo, y estado de las entregas.
    const mon = (d) => { const w = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; return addDays(d, -w) }
    const weeks = []; for (let i = 7; i >= 0; i--) weeks.push(addDays(mon(today), -7 * i))
    const [past, gItems, mats] = await Promise.all([
      must(supabase.from('edu_sessions').select('date, status, start_time, end_time').eq('teacher_user_id', me).gte('date', weeks[0]).lte('date', addDays(weeks[7], 6))),
      groupIds.length ? must(supabase.from('edu_grade_items').select('*').in('group_id', groupIds)) : [],
      groupIds.length ? must(supabase.from('edu_materials').select('id, group_id').in('group_id', groupIds).eq('kind', 'taller').eq('published', true)) : []
    ])
    const [gGrades, subs] = await Promise.all([
      gItems.length ? must(supabase.from('edu_grades').select('*').in('item_id', gItems.map((i) => i.id))) : [],
      mats.length ? must(supabase.from('edu_submissions').select('material_id, status').in('material_id', mats.map((m) => m.id))) : []
    ])
    const byGroup = []
    let expected = 0
    for (const g of groups) {
      const st = await attendanceStats([g.id]); const vals = Object.values(st.byStudent).filter((v) => v.pct != null)
      const roster = await rosterOf(g.id); const its = gItems.filter((i) => i.group_id === g.id)
      expected += roster.length * mats.filter((m) => m.group_id === g.id).length
      let ok = 0; let graded = 0
      for (const sid of [...new Set(its.map((i) => i.subject_id))]) for (const st2 of roster) { const f = finalOf(its.filter((i) => i.subject_id === sid), gGrades, st2.id, cfgT.passingScore); if (f.score != null) { graded++; if (f.state === 'aprobado') ok++ } }
      byGroup.push({ code: g.code, attendance: vals.length ? Math.round(vals.reduce((x, v) => x + v.pct, 0) / vals.length) : null, approval: graded ? Math.round((ok / graded) * 100) : null })
    }
    const charts = {
      hoursByWeek: weeks.map((w) => { const xs = past.filter((x) => x.date >= w && x.date <= addDays(w, 6) && x.status !== 'cancelada'); return { week: new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${w}T12:00:00Z`)).replace(' de ', ' ').replace('.', ''), dictadas: Math.round(xs.filter((x) => x.status === 'realizada').reduce((a, x) => a + minutes(x), 0) / 6) / 10, programadas: Math.round(xs.filter((x) => x.status === 'programada').reduce((a, x) => a + minutes(x), 0) / 6) / 10 } }),
      byGroup, minAttendance: cfgT.minAttendancePct,
      submissions: [{ name: 'Por calificar', value: subs.filter((x) => x.status === 'entregado').length }, { name: 'Calificadas', value: subs.filter((x) => x.status === 'revisado').length }, { name: 'Devueltas', value: subs.filter((x) => x.status === 'devuelto').length }, { name: 'Sin entregar', value: Math.max(0, expected - subs.length) }]
    }
    res.send({ charts,
      today: upcoming.filter((x) => x.date === today).map(sessionDTO),
      week: upcoming.filter((x) => x.date !== today).map(sessionDTO),
      groups: groups.map((g) => ({ id: g.id, code: g.code, status: g.status, program: g.program?.name, period: g.program ? `${g.program.period_label} ${g.current_period}` : null, students: (g.enrollments || []).filter((e) => e.status === 'matriculado').length })),
      atRisk: riskStudents.map((x) => ({ studentId: x.id, fullName: `${x.first_name} ${x.last_name}`.trim(), pct: att.byStudent[x.id].pct })).sort((p, q) => p.pct - q.pct), minPct: cfgT.minAttendancePct,
      actasPorCerrar: toClose.map((x) => ({ id: x.id, date: x.date, startTime: hhmm(x.start_time), endTime: hhmm(x.end_time), group: x.group?.code, subject: x.subject?.name ?? null })),
      stats: { classesMonth: month.filter((x) => x.status !== 'cancelada').length, hoursMonth: Math.round(month.filter((x) => x.status === 'realizada').reduce((a, x) => a + minutes(x), 0) / 6) / 10, pendingToClose: month.filter((x) => x.status === 'programada' && x.date < today).length, groups: groups.length }
    })
  }))

  // Horario del estudiante: clases de los grupos de sus matrículas activas.
  // Horario propio (estudiante: sus grupos; docente: sus clases). ?desde=&hasta= (máx. 120 días); por defecto, los próximos 30 días.
  app.get('/academico/mis-clases', auth(['estudiante', 'docente']), hx(async (req, res) => {
    const from = date(req.query.desde) || todayBogota()
    let to = date(req.query.hasta) || addDays(from, 30)
    if (to < from) return fail(res, 'Rango de fechas inválido', 400)
    if (to > addDays(from, 120)) to = addDays(from, 120)
    let q = supabase.from('edu_sessions').select(SESSION_SELECT).gte('date', from).lte('date', to).order('date').order('start_time').limit(600)
    if (req.user.role === 'docente') q = q.eq('teacher_user_id', req.user.id)
    else {
      const s = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
      if (!s) return res.send([])
      const enr = await must(supabase.from('edu_enrollments').select('group_id').eq('student_id', s.id).in('status', ['matriculado', 'aplazado']).not('group_id', 'is', null))
      const groups = [...new Set(enr.map((e) => e.group_id))]
      if (!groups.length) return res.send([])
      q = q.in('group_id', groups)
    }
    res.send((await must(q)).map(sessionDTO))
  }))
  // Entregas del docente: talleres publicados de sus grupos con cuántas entregas faltan por calificar.
  app.get('/academico/docente/entregas', auth(['docente', ...STAFF]), hx(async (req, res) => {
    const ses = await must(supabase.from('edu_sessions').select('group_id').eq('teacher_user_id', req.user.id))
    const groupIds = [...new Set(ses.map((x) => x.group_id))]
    if (!groupIds.length) return res.send([])
    const mats = await must(supabase.from('edu_materials').select('id, title, due_at, group_id, subject:edu_subjects(name), group:edu_groups(code, program:edu_programs(name))').in('group_id', groupIds).eq('kind', 'taller').eq('published', true).order('due_at', { ascending: false }))
    const subs = mats.length ? await must(supabase.from('edu_submissions').select('material_id, status, late').in('material_id', mats.map((m) => m.id))) : []
    res.send(mats.map((m) => { const ss = subs.filter((x) => x.material_id === m.id); return { id: m.id, title: m.title, dueAt: m.due_at, groupId: m.group_id, group: m.group?.code, program: m.group?.program?.name, subject: m.subject?.name || null, total: ss.length, pending: ss.filter((x) => x.status === 'entregado').length, late: ss.filter((x) => x.late).length } }))
  }))

  // ---------------------------------------------------------------- Asistencia con firmas (fase 4)
  // El docente pasa lista (presente, tarde, excusa, ausente); cada estudiante que asistió firma (en el aula o desde su portal);
  // el docente cierra el acta con su firma y el director de educación la firma. El acta se imprime con el formato institucional.
  const ATT_STATUS = { presente: 'Presente', tarde: 'Llegó tarde', excusa: 'Excusa', ausente: 'Ausente' }
  const attended = (st) => st === 'presente' || st === 'tarde'
  const SIG_TYPES = ['image/png', 'image/jpeg']
  const isDirector = async (req) => req.user.role === 'administrador' || Number((await settingsOf()).directorUserId) === Number(req.user.id) ||
    (deps.directors ? (await deps.directors().directorFor('educacion'))?.userId === req.user.id : false)
  // Firma de quien cierra o firma el acta: la de "Mi firma digital" o una dibujada en el momento.
  const signatureFor = async (req, drawn, prefix) => {
    if (drawn) { const url = await uploadImage('signatures', prefix, drawn, SIG_TYPES); if (!url) throw httpError(400, 'Firma inválida'); return url }
    const { data } = await supabase.from('users').select('signature_url').eq('id', req.user.id).maybeSingle()
    if (!data?.signature_url) throw httpError(400, 'No tienes firma digital: créala en Mi firma digital o dibújala aquí.')
    return data.signature_url
  }
  const rosterOf = async (groupId) => {
    const rows = await must(supabase.from('edu_enrollments').select('id, status, student:edu_students(id, first_name, last_name, doc_type, doc_number, user_id)').eq('group_id', groupId).in('status', ['matriculado', 'aplazado', 'finalizado']))
    const seen = new Map()
    for (const r of rows) if (r.student && !seen.has(r.student.id)) seen.set(r.student.id, { enrollmentId: r.id, ...r.student })
    return [...seen.values()].sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`))
  }
  const actaState = (x) => (x.director_signed_at ? 'firmada' : x.teacher_signed_at ? 'pendiente_director' : x.attendance_taken_at ? 'sin_cerrar' : 'sin_asistencia')
  const ACTA_LABEL = { firmada: 'Acta firmada', pendiente_director: 'Pendiente de firma del director', sin_cerrar: 'Asistencia sin cerrar', sin_asistencia: 'Sin asistencia' }
  const userNames = async (ids) => {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length) return {}
    const { data } = await supabase.from('users').select('id, name, last_name').in('id', list)
    return Object.fromEntries((data || []).map((u) => [u.id, teacherName(u)]))
  }
  const attendanceView = async (req, x) => {
    const [roster, records, cfg] = await Promise.all([rosterOf(x.group_id), must(supabase.from('edu_attendance').select('*').eq('session_id', x.id)), settingsOf()])
    const byStudent = Object.fromEntries(records.map((r) => [r.student_id, r]))
    // También aparecen los que tienen registro aunque ya no estén en el grupo.
    const extra = records.filter((r) => !roster.some((s) => s.id === r.student_id)).map((r) => r.student_id)
    const extraStudents = extra.length ? await must(supabase.from('edu_students').select('id, first_name, last_name, doc_type, doc_number').in('id', extra)) : []
    const names = await userNames([x.teacher_signed_by, x.director_user_id])
    const list = [...roster, ...extraStudents].map((s) => {
      const r = byStudent[s.id]
      return { studentId: s.id, enrollmentId: s.enrollmentId ?? r?.enrollment_id ?? null, fullName: `${s.first_name} ${s.last_name}`.trim(), docType: s.doc_type, docNumber: s.doc_number, status: r?.status ?? null, statusLabel: ATT_STATUS[r?.status] ?? null, arrivedAt: r?.arrived_at ? hhmm(r.arrived_at) : null, note: r?.note ?? null, signedAt: r?.student_signed_at ?? null, signatureUrl: r?.student_signature_url ?? null, signedFrom: r?.signed_from ?? null }
    })
    const count = (st) => list.filter((r) => r.status === st).length
    const teacherOwn = req.user.role === 'docente' || Number(x.teacher_user_id) === Number(req.user.id)
    return {
      session: sessionDTO(x), state: actaState(x), stateLabel: ACTA_LABEL[actaState(x)],
      format: { ...cfg.attendanceFormat, institution: cfg.institution, logoUrl: cfg.logoUrl },
      roster: list,
      summary: { total: list.length, presente: count('presente'), tarde: count('tarde'), excusa: count('excusa'), ausente: count('ausente'), sinMarcar: list.filter((r) => !r.status).length, firmas: list.filter((r) => r.signedAt).length, debenFirmar: list.filter((r) => attended(r.status)).length },
      teacher: { signedAt: x.teacher_signed_at, signatureUrl: x.teacher_signature_url, name: names[x.teacher_signed_by] || teacherName(x.teacher) },
      director: { signedAt: x.director_signed_at, signatureUrl: x.director_signature_url, name: names[x.director_user_id] || null },
      can: { edit: !x.teacher_signed_at && x.status !== 'cancelada' && x.date <= todayBogota(), close: !x.teacher_signed_at && Boolean(x.attendance_taken_at) && (teacherOwn || STAFF.includes(req.user.role)), directorSign: Boolean(x.teacher_signed_at) && !x.director_signed_at && await isDirector(req), reopen: req.user.role === 'administrador' && Boolean(x.teacher_signed_at) }
    }
  }
  app.get('/academico/clases/:id/asistencia', auth([...STAFF, 'docente']), hx(async (req, res) => res.send(await attendanceView(req, await loadSession(req, req.params.id)))))
  app.put('/academico/clases/:id/asistencia', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const x = await loadSession(req, req.params.id)
    if (x.status === 'cancelada') return fail(res, 'La clase está cancelada', 409)
    if (x.teacher_signed_at) return fail(res, 'El acta ya está cerrada', 409)
    if (x.date > todayBogota()) return fail(res, 'Aún no se puede tomar asistencia de una clase futura', 400)
    const roster = await rosterOf(x.group_id)
    const records = Array.isArray(req.body?.records) ? req.body.records : []
    const rows = []
    for (const r of records) {
      const st = roster.find((s) => s.id === Number(r.studentId))
      if (!st) continue
      if (!ATT_STATUS[r.status]) continue
      const at = clean(r.arrivedAt)
      rows.push({ session_id: x.id, student_id: st.id, enrollment_id: st.enrollmentId, status: r.status, arrived_at: at && TIME.test(at) ? at : null, note: clean(r.note)?.slice(0, 200) ?? null, updated_by: req.user.id, updated_at: new Date().toISOString() })
    }
    if (!rows.length) return fail(res, 'Marca la asistencia de al menos un estudiante', 400)
    await must(supabase.from('edu_attendance').upsert(rows, { onConflict: 'session_id,student_id' }))
    // Si alguien pasa de asistir a ausente/excusa, su firma deja de valer.
    const noSign = rows.filter((r) => !attended(r.status)).map((r) => r.student_id)
    if (noSign.length) await supabase.from('edu_attendance').update({ student_signed_at: null, student_signature_url: null, signed_from: null }).eq('session_id', x.id).in('student_id', noSign)
    await must(supabase.from('edu_sessions').update({ attendance_taken_at: new Date().toISOString(), attendance_taken_by: req.user.id }).eq('id', x.id))
    res.send(await attendanceView(req, await loadSession(req, x.id)))
  }))
  // Firma del estudiante en el aula (en el dispositivo del docente).
  app.post('/academico/clases/:id/asistencia/:studentId/firma', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const x = await loadSession(req, req.params.id)
    if (x.director_signed_at) return fail(res, 'El acta ya está firmada por el director', 409)
    const { data: r } = await supabase.from('edu_attendance').select('id, status, student_signed_at').eq('session_id', x.id).eq('student_id', Number(req.params.studentId)).maybeSingle()
    if (!r || !attended(r.status)) return fail(res, 'Solo firman los estudiantes que asistieron', 400)
    if (r.student_signed_at) return fail(res, 'El estudiante ya firmó', 409)
    const url = await uploadImage('signatures', `asistencia-${x.id}-${req.params.studentId}`, req.body?.signature, SIG_TYPES)
    if (!url) return fail(res, 'Dibuja la firma del estudiante', 400)
    await must(supabase.from('edu_attendance').update({ student_signed_at: new Date().toISOString(), student_signature_url: url, signed_from: 'presencial' }).eq('id', r.id))
    res.send(await attendanceView(req, await loadSession(req, x.id)))
  }))
  // Cierre del acta: firma del docente; la clase queda realizada y se avisa a la sección del director.
  app.post('/academico/clases/:id/asistencia/cerrar', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const x = await loadSession(req, req.params.id)
    if (x.teacher_signed_at) return fail(res, 'El acta ya está cerrada', 409)
    if (!x.attendance_taken_at) return fail(res, 'Primero toma la asistencia', 400)
    const { count } = await supabase.from('edu_attendance').select('id', { count: 'exact', head: true }).eq('session_id', x.id)
    const roster = await rosterOf(x.group_id)
    if ((count || 0) < roster.length) { const k = roster.length - (count || 0); return fail(res, `${k === 1 ? 'Falta 1 estudiante' : `Faltan ${k} estudiantes`} por marcar`, 400) }
    const url = await signatureFor(req, req.body?.signature, `acta-docente-${x.id}`)
    const now = new Date().toISOString()
    await must(supabase.from('edu_sessions').update({ teacher_signed_at: now, teacher_signed_by: req.user.id, teacher_signature_url: url, status: 'realizada', updated_at: now }).eq('id', x.id))
    const full = await loadSession(req, x.id)
    const v = await attendanceView(req, full)
    tg()?.notify('academico', [`<b>📝 Acta de asistencia por firmar</b>`, SEP, `🎓 ${esc(full.group?.program?.name || '')} · grupo <b>${esc(full.group?.code || '')}</b>`, full.subject?.name ? `📘 ${esc(full.subject.name)}` : null, `📅 ${esc(fmtDay(full.date))} · ${hhmm(full.start_time)}–${hhmm(full.end_time)}`, `✅ ${v.summary.presente + v.summary.tarde} asistieron · ❌ ${v.summary.ausente} ausentes · 📄 ${v.summary.excusa} con excusa`, `✍️ Firmó: ${esc(v.teacher.name || '')}`].filter(Boolean).join('\n'), full.group?.site_id, `/educacion/clases/${full.id}/asistencia`)
    res.send(v)
  }))
  app.post('/academico/clases/:id/asistencia/firmar-director', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const x = await loadSession(req, req.params.id)
    if (!(await isDirector(req))) return fail(res, 'Solo el director de educación (o el administrador) firma el acta', 403)
    if (!x.teacher_signed_at) return fail(res, 'El docente aún no ha cerrado el acta', 409)
    if (x.director_signed_at) return fail(res, 'El acta ya está firmada por el director', 409)
    const url = await signatureFor(req, req.body?.signature, `acta-director-${x.id}`)
    await must(supabase.from('edu_sessions').update({ director_signed_at: new Date().toISOString(), director_user_id: req.user.id, director_signature_url: url }).eq('id', x.id))
    res.send(await attendanceView(req, await loadSession(req, x.id)))
  }))
  app.post('/academico/clases/:id/asistencia/reabrir', auth(ADMIN), hx(async (req, res) => {
    const x = await loadSession(req, req.params.id)
    if (!x.teacher_signed_at) return fail(res, 'El acta no está cerrada', 409)
    if (!clean(req.body?.reason)) return fail(res, 'Indica el motivo para reabrir el acta', 400)
    await must(supabase.from('edu_sessions').update({ teacher_signed_at: null, teacher_signed_by: null, teacher_signature_url: null, director_signed_at: null, director_user_id: null, director_signature_url: null }).eq('id', x.id))
    res.send(await attendanceView(req, await loadSession(req, x.id)))
  }))
  // Actas: el director ve las pendientes de su firma; el personal, las que no se han cerrado.
  app.get('/academico/actas', auth(STAFF), hx(async (req, res) => {
    const to = date(req.query.hasta) || todayBogota(); const from = date(req.query.desde) || addDays(to, -60)
    let q = supabase.from('edu_sessions').select(`${SESSION_SELECT}, attendance:edu_attendance(status, student_signed_at)`).gte('date', from).lte('date', to).neq('status', 'cancelada').order('date', { ascending: false }).order('start_time', { ascending: false }).limit(500)
    if (Number(req.query.grupo)) q = q.eq('group_id', Number(req.query.grupo))
    const site = scopeSite(req)
    const rows = (await must(q)).filter((x) => !site || Number(x.group?.site_id) === Number(site)).map((x) => ({ ...sessionDTO(x), acta: actaState(x), actaLabel: ACTA_LABEL[actaState(x)], attended: (x.attendance || []).filter((a) => attended(a.status)).length, absent: (x.attendance || []).filter((a) => a.status === 'ausente').length, signatures: (x.attendance || []).filter((a) => a.student_signed_at).length, marked: (x.attendance || []).length }))
    const estado = req.query.estado
    res.send({ isDirector: await isDirector(req), rows: estado ? rows.filter((r) => r.acta === estado) : rows, counts: Object.fromEntries(Object.keys(ACTA_LABEL).map((k) => [k, rows.filter((r) => r.acta === k).length])) })
  }))
  // Porcentaje de asistencia por estudiante en un conjunto de grupos (clases con asistencia tomada).
  const attendanceStats = async (groupIds) => {
    if (!groupIds.length) return { byStudent: {}, sessions: 0 }
    const sessions = await must(supabase.from('edu_sessions').select('id, group_id').in('group_id', groupIds).not('attendance_taken_at', 'is', null).neq('status', 'cancelada'))
    if (!sessions.length) return { byStudent: {}, sessions: 0 }
    const recs = await must(supabase.from('edu_attendance').select('session_id, student_id, status').in('session_id', sessions.map((x) => x.id)))
    const byStudent = {}
    for (const r of recs) { const k = r.student_id; byStudent[k] = byStudent[k] || { total: 0, attended: 0, excusa: 0, ausente: 0 }; byStudent[k].total++; if (attended(r.status)) byStudent[k].attended++; if (r.status === 'excusa') byStudent[k].excusa++; if (r.status === 'ausente') byStudent[k].ausente++ }
    for (const v of Object.values(byStudent)) v.pct = v.total ? Math.round((v.attended / v.total) * 1000) / 10 : null
    return { byStudent, sessions: sessions.length }
  }
  app.get('/academico/grupos/:id/asistencia', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadGroup(req.params.id)
    if (req.user.role === 'docente') { const { count } = await supabase.from('edu_sessions').select('id', { count: 'exact', head: true }).eq('group_id', g.id).eq('teacher_user_id', req.user.id); if (!count) return fail(res, 'Ese grupo no es tuyo', 403) } else if (!canAccessSite(req, g.site_id)) return fail(res, 'Ese grupo es de otra sede', 403)
    const [roster, stats, cfg] = await Promise.all([rosterOf(g.id), attendanceStats([g.id]), settingsOf()])
    res.send({ group: { id: g.id, code: g.code, program: g.program?.name }, sessions: stats.sessions, minPct: cfg.minAttendancePct, students: roster.map((s) => ({ studentId: s.id, fullName: `${s.first_name} ${s.last_name}`.trim(), docNumber: s.doc_number, ...(stats.byStudent[s.id] || { total: 0, attended: 0, excusa: 0, ausente: 0, pct: null }), atRisk: stats.byStudent[s.id]?.pct != null && stats.byStudent[s.id].pct < cfg.minAttendancePct })) })
  }))
  // Portal del estudiante: su asistencia y las firmas pendientes (puede firmar desde el portal mientras el director no firme el acta).
  app.get('/academico/mi-asistencia', auth(['estudiante']), hx(async (req, res) => {
    const s = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
    if (!s) return res.send({ groups: [], pending: [] })
    const recs = await must(supabase.from('edu_attendance').select('*, session:edu_sessions(id, date, start_time, end_time, director_signed_at, group:edu_groups(id, code, program:edu_programs(name)), subject:edu_subjects(name))').eq('student_id', s.id).order('id', { ascending: false }).limit(300))
    const cfg = await settingsOf()
    const groups = {}
    for (const r of recs) { const g = r.session?.group; if (!g) continue; const k = g.id; groups[k] = groups[k] || { groupId: k, code: g.code, program: g.program?.name, total: 0, attended: 0, excusa: 0, ausente: 0 }; groups[k].total++; if (attended(r.status)) groups[k].attended++; if (r.status === 'excusa') groups[k].excusa++; if (r.status === 'ausente') groups[k].ausente++ }
    for (const g of Object.values(groups)) { g.pct = g.total ? Math.round((g.attended / g.total) * 1000) / 10 : null; g.atRisk = g.pct != null && g.pct < cfg.minAttendancePct }
    res.send({
      minPct: cfg.minAttendancePct, groups: Object.values(groups),
      pending: recs.filter((r) => attended(r.status) && !r.student_signed_at && !r.session?.director_signed_at).map((r) => ({ sessionId: r.session_id, date: r.session.date, startTime: hhmm(r.session.start_time), endTime: hhmm(r.session.end_time), subject: r.session.subject?.name ?? null, group: r.session.group?.code, status: r.status })),
      recent: recs.slice(0, 20).map((r) => ({ sessionId: r.session_id, date: r.session?.date, subject: r.session?.subject?.name ?? null, group: r.session?.group?.code, status: r.status, statusLabel: ATT_STATUS[r.status], signedAt: r.student_signed_at }))
    })
  }))
  app.post('/academico/mi-asistencia/:sessionId/firmar', auth(['estudiante']), hx(async (req, res) => {
    const s = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
    if (!s) return fail(res, 'No tienes ficha de estudiante', 403)
    const r = await must(supabase.from('edu_attendance').select('id, status, student_signed_at, session:edu_sessions(director_signed_at)').eq('session_id', Number(req.params.sessionId)).eq('student_id', s.id).maybeSingle())
    if (!r || !attended(r.status)) return fail(res, 'No tienes asistencia registrada en esa clase', 400)
    if (r.student_signed_at) return fail(res, 'Ya firmaste esta asistencia', 409)
    if (r.session?.director_signed_at) return fail(res, 'El acta ya está cerrada y firmada', 409)
    const url = await uploadImage('signatures', `asistencia-${req.params.sessionId}-${s.id}`, req.body?.signature, SIG_TYPES)
    if (!url) return fail(res, 'Dibuja tu firma', 400)
    await must(supabase.from('edu_attendance').update({ student_signed_at: new Date().toISOString(), student_signature_url: url, signed_from: 'portal' }).eq('id', r.id))
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Aula del curso (fase 5)
  // Material del grupo (guías, talleres, documentos, enlaces, videos), entregas de los estudiantes a los talleres
  // y planilla de notas por asignatura (evaluaciones con peso; escala 0,0 – 5,0; aprueba con la nota mínima configurada).
  const MATERIAL_KINDS = { guia: 'Guía', taller: 'Taller', documento: 'Documento', enlace: 'Enlace', video: 'Video' }
  const GRADE_KINDS = { taller: 'Taller', parcial: 'Parcial', practica: 'Práctica', quiz: 'Quiz', final: 'Examen final', otro: 'Otro' }
  const FILE_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/zip': 'zip', 'video/mp4': 'mp4' }
  const MAX_FILE = 15 * 1024 * 1024
  const uploadFile = async (file, folder) => {
    const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(file?.data || '')
    if (!m || !FILE_TYPES[m[1]]) throw httpError(400, 'Tipo de archivo no permitido. Carga PDF, imágenes, Word, Excel, PowerPoint, ZIP o MP4.')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > MAX_FILE) throw httpError(400, 'El archivo supera 15 MB')
    const path = `educacion/${folder}/${crypto.randomBytes(10).toString('hex')}.${FILE_TYPES[m[1]]}`
    const { error } = await supabase.storage.from('estandares').upload(path, buffer, { contentType: m[1], upsert: false })
    if (error) throw error
    const name = (clean(file.name) || `archivo.${FILE_TYPES[m[1]]}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160)
    return { file_url: supabase.storage.from('estandares').getPublicUrl(path).data.publicUrl, file_path: path, file_name: name, file_type: m[1], file_size: buffer.length }
  }
  const removeFile = async (path) => { if (path) await supabase.storage.from('estandares').remove([path]).catch(() => {}) }
  // ¿Quién gestiona el aula de un grupo? El personal de la sede, o el docente que dicta clases al grupo.
  const loadClassGroup = async (req, groupId) => {
    const g = await must(supabase.from('edu_groups').select('id, code, site_id, program_id, current_period, status, program:edu_programs(id, name, period_label)').eq('id', Number(groupId)).maybeSingle())
    if (!g) throw httpError(404, 'Grupo no encontrado')
    if (req.user.role === 'docente') {
      const [{ count: a }, { count: b }] = await Promise.all([
        supabase.from('edu_sessions').select('id', { count: 'exact', head: true }).eq('group_id', g.id).eq('teacher_user_id', req.user.id),
        supabase.from('edu_schedules').select('id', { count: 'exact', head: true }).eq('group_id', g.id).eq('teacher_user_id', req.user.id)
      ])
      if (!a && !b) throw httpError(403, 'No dictas clases en ese grupo')
    } else if (!canAccessSite(req, g.site_id)) throw httpError(403, 'Ese grupo es de otra sede')
    return g
  }
  const materialDTO = (m) => ({
    id: m.id, groupId: m.group_id, subjectId: m.subject_id, subject: m.subject?.name ?? null, kind: m.kind, kindLabel: MATERIAL_KINDS[m.kind], title: m.title, description: m.description,
    file: m.file_url ? { url: m.file_url, name: m.file_name, type: m.file_type, size: m.file_size } : null, linkUrl: m.link_url, dueAt: m.due_at, allowLate: m.allow_late, published: m.published, createdAt: m.created_at,
    submissions: m.submissions ? { total: m.submissions.length, graded: m.submissions.filter((x) => x.score != null).length, pending: m.submissions.filter((x) => x.status === 'entregado').length } : undefined
  })
  const submissionDTO = (x) => ({ id: x.id, materialId: x.material_id, studentId: x.student_id, file: x.file_url ? { url: x.file_url, name: x.file_name, type: x.file_type, size: x.file_size } : null, linkUrl: x.link_url, comment: x.comment, submittedAt: x.submitted_at, late: x.late, status: x.status, score: x.score == null ? null : Number(x.score), feedback: x.feedback, gradedAt: x.graded_at })
  const subjectsOf = async (programId) => must(supabase.from('edu_subjects').select('id, name, hours, period:edu_program_periods(number, name)').eq('program_id', programId).order('sort_order'))
  // Nota definitiva por asignatura: promedio ponderado de las evaluaciones calificadas (sobre los pesos calificados).
  const finalOf = (items, grades, studentId, passing) => {
    let w = 0; let sum = 0; let totalW = 0
    for (const it of items) { totalW += Number(it.weight); const g = grades.find((x) => x.item_id === it.id && x.student_id === studentId); if (g) { w += Number(it.weight); sum += Number(g.score) * Number(it.weight) } }
    const score = w ? Math.round((sum / w) * 10) / 10 : null
    return { score, weightGraded: w, weightTotal: totalW, complete: totalW > 0 && Math.abs(w - totalW) < 0.01 && Math.abs(totalW - 100) < 0.01, state: score == null ? 'sin_notas' : score >= passing ? 'aprobado' : 'reprobado' }
  }

  app.get('/academico/grupos/:id/aula', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadClassGroup(req, req.params.id)
    const [materials, subjects, items, cfg] = await Promise.all([
      must(supabase.from('edu_materials').select('*, subject:edu_subjects(name), submissions:edu_submissions(id, score, status)').eq('group_id', g.id).order('created_at', { ascending: false })),
      subjectsOf(g.program_id),
      must(supabase.from('edu_grade_items').select('*').eq('group_id', g.id).order('sort_order').order('id')),
      settingsOf()
    ])
    res.send({
      group: { id: g.id, code: g.code, program: g.program?.name, period: `${g.program?.period_label || 'Periodo'} ${g.current_period}` },
      subjects: subjects.map((x) => ({ id: x.id, name: x.name, hours: x.hours, period: x.period?.name, periodNumber: x.period?.number })),
      materials: materials.map(materialDTO), passingScore: cfg.passingScore,
      gradeItems: items.map((i) => ({ id: i.id, subjectId: i.subject_id, name: i.name, kind: i.kind, kindLabel: GRADE_KINDS[i.kind], weight: Number(i.weight), materialId: i.material_id }))
    })
  }))
  const materialRow = async (b, g, current = {}) => {
    const e = []
    if (!clean(b.title)) e.push('El título es requerido')
    const kind = MATERIAL_KINDS[b.kind] ? b.kind : null; if (!kind) e.push('Tipo de material inválido')
    const subjectId = Number(b.subjectId) || null
    if (subjectId) { const sub = await must(supabase.from('edu_subjects').select('program_id').eq('id', subjectId).maybeSingle()); if (!sub || sub.program_id !== g.program_id) e.push('La asignatura no pertenece al programa del grupo') }
    const link = clean(b.linkUrl)
    if (link && !URL_RE.test(link)) e.push('El enlace debe empezar por https://')
    if (['enlace', 'video'].includes(kind) && !link && !b.file && !current.file_url) e.push('Escribe el enlace o carga el archivo')
    if (['guia', 'documento'].includes(kind) && !b.file && !current.file_url && !link) e.push('Carga el archivo')
    let dueAt = null
    if (kind === 'taller' && clean(b.dueAt)) { const d = new Date(b.dueAt); if (Number.isNaN(d.getTime())) e.push('Fecha de entrega inválida'); else dueAt = d.toISOString() }
    if (e.length) throw httpError(400, e.join('. '))
    return { group_id: g.id, subject_id: subjectId, kind, title: clean(b.title).slice(0, 160), description: clean(b.description)?.slice(0, 4000) ?? null, link_url: link, due_at: dueAt, allow_late: b.allowLate !== false, published: b.published !== false }
  }
  app.post('/academico/grupos/:id/materiales', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadClassGroup(req, req.params.id)
    const b = req.body || {}
    const row = await materialRow(b, g)
    const file = b.file ? await uploadFile(b.file, `material/${g.id}`) : {}
    const { data, error } = await supabase.from('edu_materials').insert({ ...row, ...file, created_by: req.user.id }).select('*, subject:edu_subjects(name)').single()
    if (error) { await removeFile(file.file_path); throw error }
    // Aviso al grupo de Telegram cuando se publica material o un taller.
    const { data: gg } = await supabase.from('edu_groups').select('telegram_chat_id').eq('id', g.id).maybeSingle()
    if (data.published && gg?.telegram_chat_id) tg()?.toChat(gg.telegram_chat_id, [`<b>${data.kind === 'taller' ? '📝 Nuevo taller' : '📚 Nuevo material'}</b>`, SEP, `🎓 ${esc(g.program?.name || '')} · grupo <b>${esc(g.code)}</b>`, data.subject?.name ? `📘 ${esc(data.subject.name)}` : null, `📄 ${esc(data.title)}`, data.due_at ? `⏰ Entrega: ${esc(new Date(data.due_at).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' }))}` : null, '👉 Revísalo en tu portal de estudiante.'].filter(Boolean).join('\n'), 'academico', '/educacion/mi-aula')
    res.status(201).send(materialDTO(data))
  }))
  const loadMaterial = async (req, id) => {
    const m = await must(supabase.from('edu_materials').select('*, subject:edu_subjects(name)').eq('id', Number(id)).maybeSingle())
    if (!m) throw httpError(404, 'Material no encontrado')
    return m
  }
  app.put('/academico/materiales/:id', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const m = await loadMaterial(req, req.params.id)
    const g = await loadClassGroup(req, m.group_id)
    const b = req.body || {}
    const row = await materialRow(b, g, m)
    const file = b.file ? await uploadFile(b.file, `material/${g.id}`) : {}
    const { data, error } = await supabase.from('edu_materials').update({ ...row, ...file, updated_at: new Date().toISOString() }).eq('id', m.id).select('*, subject:edu_subjects(name)').single()
    if (error) { await removeFile(file.file_path); throw error }
    if (file.file_path) await removeFile(m.file_path)
    res.send(materialDTO(data))
  }))
  app.delete('/academico/materiales/:id', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const m = await loadMaterial(req, req.params.id)
    await loadClassGroup(req, m.group_id)
    const subs = await must(supabase.from('edu_submissions').select('id, file_path').eq('material_id', m.id))
    if (subs.length) return fail(res, `El taller ya tiene ${subs.length} entrega(s). Despublícalo en lugar de eliminarlo.`, 409)
    await must(supabase.from('edu_materials').delete().eq('id', m.id))
    await removeFile(m.file_path)
    res.send({ ok: true })
  }))
  // Entregas de un taller: todos los estudiantes del grupo con su entrega (o sin ella).
  app.get('/academico/materiales/:id/entregas', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const m = await loadMaterial(req, req.params.id)
    await loadClassGroup(req, m.group_id)
    const [roster, subs] = await Promise.all([rosterOf(m.group_id), must(supabase.from('edu_submissions').select('*').eq('material_id', m.id))])
    res.send({ material: materialDTO(m), rows: roster.map((s) => ({ studentId: s.id, fullName: `${s.first_name} ${s.last_name}`.trim(), docNumber: s.doc_number, submission: subs.find((x) => x.student_id === s.id) ? submissionDTO(subs.find((x) => x.student_id === s.id)) : null })) })
  }))
  // Calificar una entrega: nota, retroalimentación y estado. Si una evaluación está ligada al taller, la nota pasa a la planilla.
  app.put('/academico/entregas/:id/calificar', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const sub = await must(supabase.from('edu_submissions').select('*, material:edu_materials(id, group_id)').eq('id', Number(req.params.id)).maybeSingle())
    if (!sub) return fail(res, 'Entrega no encontrada', 404)
    await loadClassGroup(req, sub.material.group_id)
    const b = req.body || {}
    const score = b.score === '' || b.score == null ? null : Math.round(num(b.score, -1) * 10) / 10
    if (score !== null && (score < 0 || score > 5)) return fail(res, 'La nota debe estar entre 0,0 y 5,0', 400)
    const status = b.status === 'devuelto' ? 'devuelto' : 'revisado'
    await must(supabase.from('edu_submissions').update({ score, feedback: clean(b.feedback)?.slice(0, 2000) ?? null, status, graded_by: req.user.id, graded_at: new Date().toISOString() }).eq('id', sub.id))
    if (score !== null) {
      const items = await must(supabase.from('edu_grade_items').select('id').eq('material_id', sub.material_id))
      if (items.length) await must(supabase.from('edu_grades').upsert(items.map((i) => ({ item_id: i.id, student_id: sub.student_id, score, updated_by: req.user.id, updated_at: new Date().toISOString() })), { onConflict: 'item_id,student_id' }))
    }
    res.send(submissionDTO(await must(supabase.from('edu_submissions').select('*').eq('id', sub.id).single())))
  }))

  // Evaluaciones y planilla de notas
  const itemRow = async (b, g) => {
    const e = []
    if (!clean(b.name)) e.push('El nombre de la evaluación es requerido')
    const subjectId = Number(b.subjectId)
    const sub = subjectId ? await must(supabase.from('edu_subjects').select('program_id').eq('id', subjectId).maybeSingle()) : null
    if (!sub || sub.program_id !== g.program_id) e.push('Elige la asignatura del programa')
    const weight = num(b.weight, 0); if (!(weight > 0 && weight <= 100)) e.push('El peso debe estar entre 1 y 100 %')
    const materialId = Number(b.materialId) || null
    if (materialId) { const m = await must(supabase.from('edu_materials').select('group_id, kind').eq('id', materialId).maybeSingle()); if (!m || m.group_id !== g.id || m.kind !== 'taller') e.push('El taller ligado debe ser de este grupo') }
    if (e.length) throw httpError(400, e.join('. '))
    return { group_id: g.id, subject_id: subjectId, name: clean(b.name).slice(0, 80), kind: GRADE_KINDS[b.kind] ? b.kind : 'otro', weight, material_id: materialId, sort_order: Math.round(num(b.sortOrder, 0)) }
  }
  const checkWeights = async (groupId, subjectId, weight, exceptId) => {
    let q = supabase.from('edu_grade_items').select('id, weight').eq('group_id', groupId).eq('subject_id', subjectId)
    const rows = await must(q)
    const total = rows.filter((r) => r.id !== exceptId).reduce((a, r) => a + Number(r.weight), 0) + weight
    if (total > 100.001) throw httpError(400, `Los pesos de la asignatura sumarían ${Math.round(total * 10) / 10} %: no pueden pasar del 100 %`)
  }
  app.post('/academico/grupos/:id/evaluaciones', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadClassGroup(req, req.params.id)
    const row = await itemRow(req.body || {}, g)
    await checkWeights(g.id, row.subject_id, row.weight)
    const data = await must(supabase.from('edu_grade_items').insert(row).select('*').single())
    // Si se liga a un taller ya calificado, las notas de las entregas pasan a la planilla.
    if (data.material_id) {
      const subs = await must(supabase.from('edu_submissions').select('student_id, score').eq('material_id', data.material_id).not('score', 'is', null))
      if (subs.length) await must(supabase.from('edu_grades').upsert(subs.map((x) => ({ item_id: data.id, student_id: x.student_id, score: x.score, updated_by: req.user.id })), { onConflict: 'item_id,student_id' }))
    }
    res.status(201).send({ id: data.id })
  }))
  app.put('/academico/evaluaciones/:id', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const cur = await must(supabase.from('edu_grade_items').select('*').eq('id', Number(req.params.id)).maybeSingle())
    if (!cur) return fail(res, 'Evaluación no encontrada', 404)
    const g = await loadClassGroup(req, cur.group_id)
    const row = await itemRow({ ...req.body, subjectId: req.body?.subjectId ?? cur.subject_id }, g)
    await checkWeights(g.id, row.subject_id, row.weight, cur.id)
    await must(supabase.from('edu_grade_items').update(row).eq('id', cur.id))
    res.send({ ok: true })
  }))
  app.delete('/academico/evaluaciones/:id', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const cur = await must(supabase.from('edu_grade_items').select('*').eq('id', Number(req.params.id)).maybeSingle())
    if (!cur) return fail(res, 'Evaluación no encontrada', 404)
    await loadClassGroup(req, cur.group_id)
    await must(supabase.from('edu_grade_items').delete().eq('id', cur.id))
    res.send({ ok: true })
  }))
  // Planilla de una asignatura: estudiantes × evaluaciones, con la definitiva y si aprueba.
  app.get('/academico/grupos/:id/notas', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadClassGroup(req, req.params.id)
    const subjectId = Number(req.query.asignatura)
    if (!subjectId) return fail(res, 'Elige la asignatura', 400)
    const [roster, items, cfg] = await Promise.all([rosterOf(g.id), must(supabase.from('edu_grade_items').select('*').eq('group_id', g.id).eq('subject_id', subjectId).order('sort_order').order('id')), settingsOf()])
    const grades = items.length ? await must(supabase.from('edu_grades').select('*').in('item_id', items.map((i) => i.id))) : []
    res.send({
      passingScore: cfg.passingScore, weightTotal: items.reduce((a, i) => a + Number(i.weight), 0),
      items: items.map((i) => ({ id: i.id, name: i.name, kind: i.kind, kindLabel: GRADE_KINDS[i.kind], weight: Number(i.weight), materialId: i.material_id })),
      students: roster.map((s) => ({ studentId: s.id, fullName: `${s.first_name} ${s.last_name}`.trim(), docNumber: s.doc_number, grades: Object.fromEntries(grades.filter((x) => x.student_id === s.id).map((x) => [x.item_id, Number(x.score)])), final: finalOf(items, grades, s.id, cfg.passingScore) }))
    })
  }))
  app.put('/academico/grupos/:id/notas', auth([...STAFF, 'docente']), hx(async (req, res) => {
    const g = await loadClassGroup(req, req.params.id)
    const rows = Array.isArray(req.body?.grades) ? req.body.grades : []
    const roster = await rosterOf(g.id)
    const items = await must(supabase.from('edu_grade_items').select('id').eq('group_id', g.id))
    const ok = []; const del = []
    for (const r of rows) {
      if (!items.some((i) => i.id === Number(r.itemId)) || !roster.some((s) => s.id === Number(r.studentId))) continue
      if (r.score === '' || r.score == null) { del.push(r); continue }
      const score = Math.round(Number(String(r.score).replace(',', '.')) * 10) / 10
      if (!(score >= 0 && score <= 5)) return fail(res, 'Las notas deben estar entre 0,0 y 5,0', 400)
      ok.push({ item_id: Number(r.itemId), student_id: Number(r.studentId), score, updated_by: req.user.id, updated_at: new Date().toISOString() })
    }
    if (ok.length) await must(supabase.from('edu_grades').upsert(ok, { onConflict: 'item_id,student_id' }))
    for (const d of del) await supabase.from('edu_grades').delete().eq('item_id', Number(d.itemId)).eq('student_id', Number(d.studentId))
    res.send({ saved: ok.length, cleared: del.length })
  }))

  // Mi aula (portal del estudiante): material publicado de sus grupos, sus entregas y sus notas.
  app.get('/academico/mi-aula', auth(['estudiante']), hx(async (req, res) => {
    const s = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
    if (!s) return res.send({ groups: [] })
    const enr = await must(supabase.from('edu_enrollments').select('group_id, program_id, group:edu_groups(id, code, program:edu_programs(name))').eq('student_id', s.id).in('status', ['matriculado', 'aplazado', 'finalizado']).not('group_id', 'is', null))
    const cfg = await settingsOf()
    const out = []
    for (const gid of [...new Set(enr.map((e) => e.group_id))]) {
      const e = enr.find((x) => x.group_id === gid)
      const [materials, items, subs] = await Promise.all([
        must(supabase.from('edu_materials').select('*, subject:edu_subjects(name)').eq('group_id', gid).eq('published', true).order('created_at', { ascending: false })),
        must(supabase.from('edu_grade_items').select('*, subject:edu_subjects(name)').eq('group_id', gid).order('sort_order').order('id')),
        must(supabase.from('edu_submissions').select('*').eq('student_id', s.id))
      ])
      const grades = items.length ? await must(supabase.from('edu_grades').select('*').eq('student_id', s.id).in('item_id', items.map((i) => i.id))) : []
      const bySubject = {}
      for (const it of items) (bySubject[it.subject_id] = bySubject[it.subject_id] || { subjectId: it.subject_id, subject: it.subject?.name, items: [] }).items.push(it)
      out.push({
        groupId: gid, code: e.group?.code, program: e.group?.program?.name,
        materials: materials.map((m) => ({ ...materialDTO(m), mySubmission: subs.find((x) => x.material_id === m.id) ? submissionDTO(subs.find((x) => x.material_id === m.id)) : null })),
        grades: Object.values(bySubject).map((b) => ({ subjectId: b.subjectId, subject: b.subject, items: b.items.map((i) => ({ id: i.id, name: i.name, kindLabel: GRADE_KINDS[i.kind], weight: Number(i.weight), score: grades.find((x) => x.item_id === i.id) ? Number(grades.find((x) => x.item_id === i.id).score) : null })), final: finalOf(b.items, grades, s.id, cfg.passingScore) }))
      })
    }
    res.send({ passingScore: cfg.passingScore, groups: out })
  }))
  // Entregar (o reemplazar) un taller desde el portal. No se reemplaza una entrega ya revisada, salvo que se la devuelvan.
  app.post('/academico/materiales/:id/entregar', auth(['estudiante']), hx(async (req, res) => {
    const s = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
    if (!s) return fail(res, 'No tienes ficha de estudiante', 403)
    const m = await loadMaterial(req, req.params.id)
    if (m.kind !== 'taller' || !m.published) return fail(res, 'Solo se entregan talleres publicados', 400)
    const { count } = await supabase.from('edu_enrollments').select('id', { count: 'exact', head: true }).eq('student_id', s.id).eq('group_id', m.group_id).in('status', ['matriculado', 'aplazado'])
    if (!count) return fail(res, 'No estás matriculado en ese grupo', 403)
    const late = Boolean(m.due_at && new Date() > new Date(m.due_at))
    if (late && !m.allow_late) return fail(res, 'La fecha de entrega ya pasó', 409)
    const b = req.body || {}
    const link = clean(b.linkUrl)
    if (link && !URL_RE.test(link)) return fail(res, 'El enlace debe empezar por https://', 400)
    if (!b.file && !link) return fail(res, 'Carga el archivo o pega el enlace de tu trabajo', 400)
    const prev = await must(supabase.from('edu_submissions').select('*').eq('material_id', m.id).eq('student_id', s.id).maybeSingle())
    if (prev && prev.status === 'revisado') return fail(res, 'Tu entrega ya fue calificada', 409)
    const file = b.file ? await uploadFile(b.file, `entregas/${m.id}`) : {}
    const row = { material_id: m.id, student_id: s.id, ...(b.file ? file : { file_url: null, file_path: null, file_name: null, file_type: null, file_size: null }), link_url: link, comment: clean(b.comment)?.slice(0, 1000) ?? null, submitted_at: new Date().toISOString(), late, status: 'entregado', score: null, feedback: prev?.feedback ?? null }
    const { error } = await supabase.from('edu_submissions').upsert(row, { onConflict: 'material_id,student_id' })
    if (error) { await removeFile(file.file_path); throw error }
    if (prev?.file_path && prev.file_path !== file.file_path) await removeFile(prev.file_path)
    res.send({ ok: true, late })
  }))

  // ---------------------------------------------------------------- Certificados (fase 6)
  // Requisitos de grado por estudiante y programa: plan de estudios aprobado (todas las asignaturas con definitiva ≥ nota mínima),
  // asistencia ≥ mínimo, paz y salvo y contrato firmado (si era obligatorio). El administrador puede emitir con excepción justificada.
  const randomCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(10); return Array.from(b, (x) => A[x % A.length]).join('') }
  const requirementsOf = async (studentId, programId, cfg) => {
    const program = await loadProgram(programId)
    const enr = await must(supabase.from('edu_enrollments').select(ENROLL_SELECT).eq('student_id', studentId).eq('program_id', programId).neq('status', 'retirado'))
    const groupIds = [...new Set(enr.map((e) => e.group_id).filter(Boolean))]
    const subjects = program.periods.flatMap((p) => p.subjects.map((x) => ({ ...x, period: p.name })))
    // Notas por asignatura (en cualquiera de los grupos del estudiante en el programa)
    const items = groupIds.length ? await must(supabase.from('edu_grade_items').select('*').in('group_id', groupIds)) : []
    const grades = items.length ? await must(supabase.from('edu_grades').select('*').eq('student_id', studentId).in('item_id', items.map((i) => i.id))) : []
    const bySubject = subjects.map((sub) => { const its = items.filter((i) => i.subject_id === sub.id); const f = finalOf(its, grades, studentId, cfg.passingScore); return { subjectId: sub.id, name: sub.name, period: sub.period, hours: sub.hours, score: f.score, approved: f.state === 'aprobado' } })
    const pendingSubjects = bySubject.filter((x) => !x.approved)
    // Asistencia
    const att = await attendanceStats(groupIds)
    const mine = att.byStudent[studentId]
    // Cartera y contrato
    const accounts = enr.map((e) => account(e))
    const balance = accounts.reduce((a, x) => a + x.balance, 0)
    const unsigned = enr.filter((e) => e.contract_required && !e.contract_signed_at && e.status !== 'preinscrito')
    const reqs = [
      { key: 'notas', label: 'Plan de estudios aprobado', ok: subjects.length > 0 && pendingSubjects.length === 0, detail: pendingSubjects.length ? `${pendingSubjects.length} de ${subjects.length} asignaturas sin aprobar` : `${subjects.length} asignaturas aprobadas` },
      { key: 'asistencia', label: `Asistencia mínima (${cfg.minAttendancePct} %)`, ok: mine?.pct != null && mine.pct >= cfg.minAttendancePct, detail: mine?.pct != null ? `${mine.pct} %` : 'Sin registros de asistencia' },
      { key: 'paz_y_salvo', label: 'Paz y salvo', ok: balance <= 0, detail: balance > 0 ? `Saldo pendiente de ${Math.round(balance).toLocaleString('es-CO')}` : 'Sin saldo' },
      { key: 'contrato', label: 'Contrato de matrícula firmado', ok: unsigned.length === 0, detail: unsigned.length ? 'Falta firmar el contrato' : 'Firmado o no requerido' }
    ]
    return { program, enrollments: enr, reqs, eligible: reqs.every((r) => r.ok), subjects: bySubject, attendancePct: mine?.pct ?? null }
  }
  const certDTO = (c) => ({ id: c.id, number: c.number, numberLabel: `CERT-${String(c.number).padStart(6, '0')}`, studentId: c.student_id, programId: c.program_id, certType: c.cert_type, title: c.title, hours: c.hours, issuedAt: c.issued_at, verificationCode: c.verification_code, voided: c.voided, voidReason: c.void_reason, snapshot: c.snapshot, signerSignatureUrl: c.signer_signature_url, createdAt: c.created_at })
  app.get('/academico/certificados/candidatos', auth(STAFF), hx(async (req, res) => {
    const programId = Number(req.query.programa)
    if (!programId) return fail(res, 'Elige el programa', 400)
    const cfg = await settingsOf()
    const enr = await must(supabase.from('edu_enrollments').select('student_id, student:edu_students(id, first_name, last_name, doc_type, doc_number, site_id, status)').eq('program_id', programId).neq('status', 'retirado'))
    const site = scopeSite(req)
    const students = [...new Map(enr.filter((e) => e.student && (!site || Number(e.student.site_id) === Number(site))).map((e) => [e.student.id, e.student])).values()]
    const certs = await must(supabase.from('edu_certificates').select('*').eq('program_id', programId).eq('voided', false))
    const rows = []
    for (const st of students) {
      const r = await requirementsOf(st.id, programId, cfg)
      const c = certs.find((x) => x.student_id === st.id)
      rows.push({ studentId: st.id, fullName: `${st.first_name} ${st.last_name}`.trim(), docType: st.doc_type, docNumber: st.doc_number, requirements: r.reqs, eligible: r.eligible, certificate: c ? certDTO(c) : null })
    }
    res.send(rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.fullName.localeCompare(b.fullName)))
  }))
  app.get('/academico/certificados', auth(STAFF), hx(async (req, res) => {
    let q = supabase.from('edu_certificates').select('*').order('number', { ascending: false }).limit(500)
    if (Number(req.query.programa)) q = q.eq('program_id', Number(req.query.programa))
    res.send((await must(q)).map(certDTO))
  }))
  app.post('/academico/certificados', auth(STAFF), hx(async (req, res) => {
    const b = req.body || {}
    const s = await loadStudent(req, b.studentId)
    const cfg = await settingsOf()
    const r = await requirementsOf(s.id, Number(b.programId), cfg)
    if (!r.enrollments.length) return fail(res, 'El estudiante no tiene matrículas en ese programa', 400)
    let exception = null
    if (!r.eligible) {
      if (req.user.role !== 'administrador' || b.force !== true) return fail(res, `No cumple los requisitos: ${r.reqs.filter((x) => !x.ok).map((x) => x.label.toLowerCase()).join(', ')}`, 409)
      if (!clean(b.reason)) return fail(res, 'Indica la justificación para emitir sin cumplir todos los requisitos', 400)
      exception = { reason: clean(b.reason).slice(0, 300), missing: r.reqs.filter((x) => !x.ok).map((x) => x.label), by: req.user.id }
    }
    const { data: org } = await supabase.from('plt_organizations').select('name, nit, city').eq('id', tenant.currentOrg()).maybeSingle()
    const signerId = cfg.directorUserId || req.user.id
    const { data: signer } = await supabase.from('users').select('id, name, last_name, signature_url').eq('id', signerId).maybeSingle()
    const p = r.program
    const snapshot = {
      institution: cfg.institution || org?.name, nit: org?.nit ?? null, city: org?.city ?? null, logoUrl: cfg.logoUrl,
      student: { name: `${s.first_name} ${s.last_name}`.trim(), docType: s.doc_type, docNumber: s.doc_number },
      program: { name: p.name, code: p.code, kind: p.kindLabel, occupation: p.occupation, registrationNumber: p.registrationNumber, modality: p.modality },
      certTitle: CERT_TYPES[p.certType], hours: p.totalHours, subjects: r.subjects.map((x) => ({ name: x.name, period: x.period, hours: x.hours, score: x.score })),
      attendancePct: r.attendancePct, signer: signer ? { name: teacherName(signer), role: 'Director(a) de educación' } : null, exception
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: last } = await supabase.from('edu_certificates').select('number').order('number', { ascending: false }).limit(1).maybeSingle()
      const { data, error } = await supabase.from('edu_certificates').insert({ number: (last?.number || 0) + 1, student_id: s.id, program_id: p.id, cert_type: p.certType, title: CERT_TYPES[p.certType], hours: p.totalHours, issued_at: date(b.issuedAt) || todayBogota(), verification_code: randomCode(), snapshot, signer_user_id: signer?.id ?? null, signer_signature_url: signer?.signature_url ?? null, created_by: req.user.id }).select('*').single()
      if (error?.code === '23505' && /active_unique/.test(error.message || '')) return fail(res, 'El estudiante ya tiene un certificado vigente de este programa', 409)
      if (error?.code === '23505') continue
      if (error) throw error
      // El estudiante queda como graduado y sus matrículas activas del programa, finalizadas.
      if (p.certType !== 'asistencia' || p.kind === 'carrera_tecnica') await supabase.from('edu_students').update({ status: 'graduado' }).eq('id', s.id)
      await supabase.from('edu_enrollments').update({ status: 'finalizado' }).eq('student_id', s.id).eq('program_id', p.id).in('status', ['matriculado', 'aplazado'])
      return res.status(201).send(certDTO(data))
    }
    fail(res, 'No se pudo asignar el consecutivo. Intenta de nuevo.', 409)
  }))
  const loadCert = async (req, id) => {
    const c = await must(supabase.from('edu_certificates').select('*').eq('id', Number(id)).maybeSingle())
    if (!c) throw httpError(404, 'Certificado no encontrado')
    if (req.user.role === 'estudiante') { const { data: st } = await supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle(); if (!st || st.id !== c.student_id) throw httpError(403, 'Ese certificado no es tuyo') }
    return c
  }
  // IIPS-028 · Plantillas de certificado: la del programa, o la predeterminada; sin plantilla se usa el diseño de fábrica.
  const TPL_FIELDS = (t) => t && ({ id: t.id, name: t.name, isDefault: t.is_default, orientation: t.orientation, titleText: t.title_text, introText: t.intro_text, bodyText: t.body_text, closingText: t.closing_text, footerText: t.footer_text, primaryColor: t.primary_color, borderStyle: t.border_style, backgroundUrl: t.background_url, showLogo: t.show_logo, signers: t.signers || [], active: t.active, updatedAt: t.updated_at })
  const templateFor = async (programId) => {
    const p = programId ? await must(supabase.from('edu_programs').select('certificate_template_id').eq('id', programId).maybeSingle()) : null
    if (p?.certificate_template_id) { const t = await must(supabase.from('edu_certificate_templates').select('*').eq('id', p.certificate_template_id).eq('active', true).maybeSingle()); if (t) return t }
    return must(supabase.from('edu_certificate_templates').select('*').eq('is_default', true).eq('active', true).limit(1).maybeSingle())
  }
  app.get('/academico/certificados/:id', auth([...STAFF, 'estudiante']), hx(async (req, res) => {
    const c = await loadCert(req, req.params.id)
    const t = await templateFor(c.program_id).catch(() => null)
    // Firmas de la plantilla que toman la firma digital de un usuario.
    const signers = []
    for (const sg of t?.signers || []) {
      let sig = null
      if (Number(sg.userId)) { const u = await must(supabase.from('users').select('signature_url, name, last_name').eq('id', Number(sg.userId)).maybeSingle()); sig = u?.signature_url || null; if (!sg.name && u) sg.name = `${u.name} ${u.last_name}`.trim() }
      signers.push({ label: sg.label || '', name: sg.name || '', signatureUrl: sg.useIssuer ? c.signer_signature_url : sig })
    }
    res.send({ ...certDTO(c), template: t ? { ...TPL_FIELDS(t), signers } : null })
  }))
  app.get('/academico/plantillas-certificado', auth(STAFF), hx(async (req, res) => res.send((await must(supabase.from('edu_certificate_templates').select('*').order('is_default', { ascending: false }).order('name'))).map(TPL_FIELDS))))
  const tplRow = (b) => {
    if (!clean(b.name)) throw httpError(400, 'Escribe el nombre de la plantilla')
    if (!clean(b.bodyText)) throw httpError(400, 'Escribe el texto del certificado')
    if (b.primaryColor && !/^#[0-9A-Fa-f]{6}$/.test(b.primaryColor)) throw httpError(400, 'Color inválido')
    const signers = (Array.isArray(b.signers) ? b.signers : []).slice(0, 4).map((x) => ({ label: clean(x.label)?.slice(0, 80) || '', name: clean(x.name)?.slice(0, 120) || '', userId: Number(x.userId) || null, useIssuer: Boolean(x.useIssuer) }))
    return {
      name: clean(b.name).slice(0, 120), orientation: b.orientation === 'portrait' ? 'portrait' : 'landscape', title_text: clean(b.titleText)?.slice(0, 160) ?? null,
      intro_text: clean(b.introText)?.slice(0, 200) ?? 'Otorgado a', body_text: clean(b.bodyText).slice(0, 3000), closing_text: clean(b.closingText)?.slice(0, 500) ?? 'Dado en {{ciudad}}, el {{fecha}}.',
      footer_text: clean(b.footerText)?.slice(0, 500) ?? null, primary_color: b.primaryColor || '#1F2A44', border_style: ['doble', 'simple', 'ninguno'].includes(b.borderStyle) ? b.borderStyle : 'doble',
      show_logo: b.showLogo !== false, signers, active: b.active !== false, updated_at: new Date().toISOString()
    }
  }
  const setDefault = async (id) => { await supabase.from('edu_certificate_templates').update({ is_default: false }).neq('id', id); await supabase.from('edu_certificate_templates').update({ is_default: true }).eq('id', id) }
  app.post('/academico/plantillas-certificado', auth(ADMIN), hx(async (req, res) => {
    const row = tplRow(req.body || {})
    const t = await must(supabase.from('edu_certificate_templates').insert(row).select('*').single())
    if (req.body?.isDefault) await setDefault(t.id)
    res.status(201).send(TPL_FIELDS({ ...t, is_default: Boolean(req.body?.isDefault) }))
  }))
  app.put('/academico/plantillas-certificado/:id', auth(ADMIN), hx(async (req, res) => {
    const id = Number(req.params.id)
    const t = await must(supabase.from('edu_certificate_templates').update(tplRow(req.body || {})).eq('id', id).select('*').single())
    if (req.body?.isDefault) await setDefault(id)
    res.send(TPL_FIELDS({ ...t, is_default: Boolean(req.body?.isDefault) || t.is_default }))
  }))
  app.post('/academico/plantillas-certificado/:id/fondo', auth(ADMIN), hx(async (req, res) => {
    const url = req.body?.image ? await deps.uploadImage('branding', `cert-fondo-${req.params.id}`, req.body.image, ['image/png', 'image/jpeg', 'image/webp']) : null
    if (req.body?.image && !url) return fail(res, 'Imagen inválida (PNG, JPG o WEBP de máximo 2 MB)', 400)
    const t = await must(supabase.from('edu_certificate_templates').update({ background_url: url, updated_at: new Date().toISOString() }).eq('id', Number(req.params.id)).select('*').single())
    res.send(TPL_FIELDS(t))
  }))
  app.delete('/academico/plantillas-certificado/:id', auth(ADMIN), hx(async (req, res) => {
    await must(supabase.from('edu_certificate_templates').delete().eq('id', Number(req.params.id)))
    res.send({ ok: true })
  }))
  // Plantilla de cada programa.
  app.put('/academico/programas/:id/plantilla-certificado', auth(ADMIN), hx(async (req, res) => {
    await must(supabase.from('edu_programs').update({ certificate_template_id: Number(req.body?.templateId) || null }).eq('id', Number(req.params.id)))
    res.send({ ok: true })
  }))
  app.post('/academico/certificados/:id/anular', auth(ADMIN), hx(async (req, res) => {
    const c = await loadCert(req, req.params.id)
    if (c.voided) return fail(res, 'El certificado ya está anulado', 409)
    if (!clean(req.body?.reason)) return fail(res, 'Indica el motivo de la anulación', 400)
    await must(supabase.from('edu_certificates').update({ voided: true, void_reason: clean(req.body.reason).slice(0, 300), voided_at: new Date().toISOString() }).eq('id', c.id))
    res.send(certDTO(await loadCert(req, c.id)))
  }))
  app.get('/academico/mis-certificados', auth(['estudiante']), hx(async (req, res) => {
    const st = await must(supabase.from('edu_students').select('id').eq('user_id', req.user.id).maybeSingle())
    if (!st) return res.send([])
    res.send((await must(supabase.from('edu_certificates').select('*').eq('student_id', st.id).order('number', { ascending: false }))).map(certDTO))
  }))
  // Verificación pública (sin sesión): cualquiera con el código comprueba que el certificado existe y está vigente.
  app.get('/publico/certificados/:code', hx(async (req, res) => {
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)
    const { data: c } = await supabase.from('edu_certificates').select('number, title, hours, issued_at, voided, snapshot').eq('verification_code', code).maybeSingle()
    if (!c) return fail(res, 'No existe un certificado con ese código', 404)
    const doc = String(c.snapshot?.student?.docNumber || '')
    res.send({ valid: !c.voided, number: `CERT-${String(c.number).padStart(6, '0')}`, title: c.title, hours: c.hours, issuedAt: c.issued_at, institution: c.snapshot?.institution, program: c.snapshot?.program?.name, student: c.snapshot?.student?.name, document: doc ? `${c.snapshot.student.docType} ••••${doc.slice(-4)}` : null })
  }))

  // ---------------------------------------------------------------- Reportes (PDF) y SIET
  // Cada reporte devuelve título, columnas y filas; el frontend lo imprime o guarda en PDF con el logo de la institución.
  const reportBase = async (title, subtitle, columns, rows, totals) => ({ title, subtitle, columns, rows, totals, generatedAt: new Date().toISOString(), institution: (await settingsOf()).institution })
  const pct = (v) => (v == null ? '—' : `${v} %`)
  app.get('/academico/reportes/:tipo', auth(STAFF), hx(async (req, res) => {
    const tipo = req.params.tipo
    const site = scopeSite(req)
    const groupId = Number(req.query.grupo) || null; const programId = Number(req.query.programa) || null
    if (tipo === 'matriculados') {
      let q = supabase.from('edu_enrollments').select(ENROLL_SELECT).in('status', ['preinscrito', 'matriculado', 'aplazado']).order('enrolled_at')
      if (groupId) q = q.eq('group_id', groupId); if (programId) q = q.eq('program_id', programId)
      if (clean(req.query.periodo)) q = q.eq('academic_period', clean(req.query.periodo))
      const rows = (await must(q)).filter((e) => !site || Number(e.student?.site_id) === Number(site)).map(enrollDTO)
      return res.send(await reportBase('Estudiantes matriculados', [programId && rows[0]?.program?.name, clean(req.query.periodo) && `Periodo ${req.query.periodo}`].filter(Boolean).join(' · '),
        ['Documento', 'Estudiante', 'Programa', 'Grupo', 'Periodo', 'Fecha', 'Estado', 'Valor'],
        rows.map((e) => [`${e.student?.docType} ${e.student?.docNumber}`, e.student?.fullName, e.program?.name, e.group?.code || '—', [e.period?.name, e.academicPeriod].filter(Boolean).join(' · ') || '—', e.enrolledAt, e.statusLabel, Math.round(e.totalValue).toLocaleString('es-CO')]),
        [`${rows.length} estudiantes`, `Valor total ${Math.round(rows.reduce((a, e) => a + e.totalValue, 0)).toLocaleString('es-CO')}`]))
    }
    if (tipo === 'asistencia') {
      if (!groupId) return fail(res, 'Elige el grupo', 400)
      const g = await loadClassGroup(req, groupId); const cfg = await settingsOf()
      const [roster, st] = await Promise.all([rosterOf(g.id), attendanceStats([g.id])])
      return res.send(await reportBase(`Consolidado de asistencia · ${g.code}`, `${g.program?.name} · ${st.sessions} clases con asistencia · mínimo ${cfg.minAttendancePct} %`,
        ['Documento', 'Estudiante', 'Clases', 'Asistió', 'Excusas', 'Ausencias', '%', 'Estado'],
        roster.map((s) => { const v = st.byStudent[s.id] || {}; return [`${s.doc_type} ${s.doc_number}`, `${s.first_name} ${s.last_name}`, v.total || 0, v.attended || 0, v.excusa || 0, v.ausente || 0, pct(v.pct), v.pct == null ? 'Sin datos' : v.pct >= cfg.minAttendancePct ? 'Cumple' : 'En riesgo'] }),
        [`${roster.length} estudiantes`]))
    }
    if (tipo === 'notas') {
      if (!groupId) return fail(res, 'Elige el grupo', 400)
      const g = await loadClassGroup(req, groupId); const cfg = await settingsOf()
      const [roster, items] = await Promise.all([rosterOf(g.id), must(supabase.from('edu_grade_items').select('*, subject:edu_subjects(name)').eq('group_id', g.id).order('subject_id').order('sort_order'))])
      const grades = items.length ? await must(supabase.from('edu_grades').select('*').in('item_id', items.map((i) => i.id))) : []
      const subjects = [...new Map(items.map((i) => [i.subject_id, i.subject?.name])).entries()]
      return res.send(await reportBase(`Consolidado de notas · ${g.code}`, `${g.program?.name} · aprueba con ${String(cfg.passingScore).replace('.', ',')}`,
        ['Estudiante', ...subjects.map(([, n]) => n), 'Promedio'],
        roster.map((s) => { const finals = subjects.map(([sid]) => finalOf(items.filter((i) => i.subject_id === sid), grades, s.id, cfg.passingScore).score); const vals = finals.filter((v) => v != null); return [`${s.first_name} ${s.last_name}`, ...finals.map((v) => (v == null ? '—' : String(v).replace('.', ','))), vals.length ? String(Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10).replace('.', ',') : '—'] }),
        [`${roster.length} estudiantes · ${subjects.length} asignaturas`]))
    }
    if (tipo === 'cartera') {
      const rows = (await must(supabase.from('edu_enrollments').select(ENROLL_SELECT).in('status', ['preinscrito', 'matriculado', 'aplazado', 'finalizado', 'retirado']).limit(5000))).filter((e) => !site || Number(e.student?.site_id) === Number(site)).map(enrollDTO).filter((e) => e.account.balance > 0 && (!programId || e.programId === programId))
      return res.send(await reportBase('Cartera por cobrar', `Corte ${todayBogota()}`,
        ['Estudiante', 'Documento', 'Programa', 'Valor', 'Pagado', 'Saldo', 'Vencido', 'Días de mora'],
        rows.sort((a, b) => b.account.maxDaysLate - a.account.maxDaysLate).map((e) => [e.student?.fullName, `${e.student?.docType} ${e.student?.docNumber}`, e.program?.name, Math.round(e.account.total).toLocaleString('es-CO'), Math.round(e.account.paid).toLocaleString('es-CO'), Math.round(e.account.balance).toLocaleString('es-CO'), Math.round(e.account.overdue).toLocaleString('es-CO'), e.account.maxDaysLate || 0]),
        [`Saldo total ${Math.round(rows.reduce((a, e) => a + e.account.balance, 0)).toLocaleString('es-CO')}`, `Vencido ${Math.round(rows.reduce((a, e) => a + e.account.overdue, 0)).toLocaleString('es-CO')}`]))
    }
    if (tipo === 'horas') {
      const from = date(req.query.desde) || `${todayBogota().slice(0, 7)}-01`; const to = date(req.query.hasta) || todayBogota()
      const sessions = await must(supabase.from('edu_sessions').select(SESSION_SELECT).gte('date', from).lte('date', to).eq('status', 'realizada'))
      const byTeacher = {}
      for (const x of sessions.filter((y) => !site || Number(y.group?.site_id) === Number(site))) {
        const k = x.teacher_user_id || 0; const mins = (Number(hhmm(x.end_time).slice(0, 2)) * 60 + Number(hhmm(x.end_time).slice(3))) - (Number(hhmm(x.start_time).slice(0, 2)) * 60 + Number(hhmm(x.start_time).slice(3)))
        byTeacher[k] = byTeacher[k] || { name: teacherName(x.teacher) || 'Sin docente', classes: 0, minutes: 0, groups: new Set() }
        byTeacher[k].classes++; byTeacher[k].minutes += mins; byTeacher[k].groups.add(x.group?.code)
      }
      const list = Object.values(byTeacher).sort((a, b) => b.minutes - a.minutes)
      return res.send(await reportBase('Horas dictadas por docente', `Del ${from} al ${to} · clases realizadas`, ['Docente', 'Grupos', 'Clases', 'Horas'], list.map((t) => [t.name, [...t.groups].join(', '), t.classes, String(Math.round(t.minutes / 6) / 10).replace('.', ',')]), [`${list.reduce((a, t) => a + t.classes, 0)} clases · ${String(Math.round(list.reduce((a, t) => a + t.minutes, 0) / 6) / 10).replace('.', ',')} horas`]))
    }
    if (tipo === 'siet') {
      // Base para el reporte de matrícula al SIET (MEN): una fila por estudiante y programa. Revisar contra la plantilla vigente del SIET.
      const periodo = clean(req.query.periodo)
      let q = supabase.from('edu_enrollments').select('*, program:edu_programs(code, name, kind, registration_number, modality, cert_type), group:edu_groups(code, shift, site:sites(name, municipality)), student:edu_students(*)').in('status', ['matriculado', 'aplazado', 'finalizado'])
      if (periodo) q = q.eq('academic_period', periodo)
      const rows = (await must(q)).filter((e) => !site || Number(e.student?.site_id) === Number(site))
      const certs = await must(supabase.from('edu_certificates').select('student_id, program_id, number, issued_at').eq('voided', false))
      return res.send(await reportBase('Reporte de matrícula para el SIET', periodo ? `Periodo ${periodo}` : 'Todos los periodos',
        ['Tipo documento', 'Número documento', 'Primer nombre y segundo nombre', 'Apellidos', 'Sexo', 'Fecha nacimiento', 'Municipio', 'Nivel educativo', 'Código programa', 'Programa', 'Registro del programa', 'Modalidad', 'Jornada', 'Sede', 'Periodo', 'Fecha matrícula', 'Estado', 'Certificado', 'Fecha certificado'],
        rows.map((e) => { const c = certs.find((x) => x.student_id === e.student_id && x.program_id === e.program_id); return [e.student?.doc_type, e.student?.doc_number, e.student?.first_name, e.student?.last_name, e.student?.gender || '', e.student?.birth_date || '', e.student?.municipality || '', e.student?.education_level || '', e.program?.code, e.program?.name, e.program?.registration_number || '', e.program?.modality, e.group ? SHIFTS[e.group.shift] : '', e.group?.site?.name || '', e.academic_period || '', e.enrolled_at, ENROLL_STATUS[e.status], c ? `CERT-${String(c.number).padStart(6, '0')}` : '', c?.issued_at || ''] }),
        [`${rows.length} registros`]))
    }
    fail(res, 'Reporte no disponible', 404)
  }))

  // ---------------------------------------------------------------- Portal del estudiante
  app.get('/academico/mi-programa', auth(['estudiante', 'administrador']), hx(async (req, res) => {
    const s = await must(supabase.from('edu_students').select(STUDENT_SELECT).eq('user_id', req.user.id).maybeSingle())
    if (!s) return res.send({ student: null, enrollments: [] })
    const enr = await must(supabase.from('edu_enrollments').select(ENROLL_SELECT).eq('student_id', s.id).order('enrolled_at', { ascending: false }))
    const programs = {}
    for (const id of [...new Set(enr.map((e) => e.program_id))]) programs[id] = await loadProgram(id)
    res.send({
      student: studentDTO(s),
      enrollments: enr.map((e) => ({ ...enrollDTO(e), pensum: programs[e.program_id] ? { totalHours: programs[e.program_id].totalHours, certLabel: programs[e.program_id].certLabel, periods: programs[e.program_id].periods.map(({ price, ...p }) => p) } : null }))
    })
  }))

  // IIPS-022 · Avisos del docente: clases dictadas sin cerrar la asistencia y entregas por revisar.
  // IIPS-023 · Actas de asistencia que esperan la firma del director de educación.
  alerts.register({
    key: 'edu_actas', route: '/educacion/actas', roles: ['administrador', 'empleado'],
    run: async (req) => {
      if (!(await isDirector(req))) return []
      const rows = await must(supabase.from('edu_sessions').select('id, date, group:edu_groups(code), subject:edu_subjects(name)').not('teacher_signed_at', 'is', null).is('director_signed_at', null).order('date').limit(60))
      return rows.map((x) => ({ id: x.id, level: 'warn', title: `Acta ${x.subject?.name || ''} · ${x.group?.code || ''}`, message: `Pendiente de tu firma (${x.date.split('-').reverse().join('/')})`, link: `/educacion/clases/${x.id}/acta`, date: x.date }))
    }
  })
  alerts.register({
    key: 'docente_clases', module: 'edu_docente', roles: ['docente'], route: '/educacion/docente',
    run: async (req) => {
      const rows = await must(supabase.from('edu_sessions').select('id, date, start_time, group:edu_groups(code), subject:edu_subjects(name)').eq('teacher_user_id', req.user.id).lte('date', todayBogota()).neq('status', 'cancelada').is('teacher_signed_at', null).order('date').limit(30))
      return rows.map((x) => ({ id: x.id, level: 'warn', title: `${x.subject?.name || 'Clase'} · ${x.group?.code || ''}`, message: `Asistencia sin cerrar (${x.date.split('-').reverse().join('/')})`, link: `/educacion/clases/${x.id}/asistencia`, date: x.date }))
    }
  })
  alerts.register({
    key: 'docente_entregas', module: 'edu_docente', roles: ['docente'], route: '/educacion/docente/entregas',
    run: async (req) => {
      const ses = await must(supabase.from('edu_sessions').select('group_id').eq('teacher_user_id', req.user.id))
      const groupIds = [...new Set(ses.map((x) => x.group_id))]
      if (!groupIds.length) return []
      const mats = await must(supabase.from('edu_materials').select('id, title').in('group_id', groupIds).eq('kind', 'taller').eq('published', true))
      if (!mats.length) return []
      const subs = await must(supabase.from('edu_submissions').select('id, material_id').in('material_id', mats.map((m) => m.id)).eq('status', 'entregado'))
      return subs.map((x) => ({ id: x.id, level: 'info', title: mats.find((m) => m.id === x.material_id)?.title || 'Taller', message: 'Entrega por revisar' }))
    }
  })
}

module.exports.TABLES = ['edu_programs', 'edu_program_periods', 'edu_subjects', 'edu_groups', 'edu_students', 'edu_enrollments', 'edu_settings', 'edu_discounts', 'edu_agreements', 'edu_installments', 'edu_payments', 'edu_payment_plans', 'edu_schedules', 'edu_sessions', 'edu_attendance', 'edu_classrooms', 'edu_materials', 'edu_submissions', 'edu_grade_items', 'edu_grades', 'edu_certificates']
