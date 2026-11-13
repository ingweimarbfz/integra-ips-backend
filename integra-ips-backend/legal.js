// =====================================================================
// Documentos legales de Integra IPS (normativa colombiana):
//  · Contrato de prestación del servicio (dinámico según el plan contratado)
//  · Acuerdo de transmisión y tratamiento de datos personales (Ley 1581 de 2012)
//  · Términos y condiciones de uso (los acepta cada usuario)
// El contrato y el acuerdo de datos los firma el representante legal del cliente
// antes de usar el sistema; el texto firmado se guarda como evidencia.
// Nota: son plantillas de referencia; se recomienda revisión por un abogado.
// =====================================================================
const BRAND = 'Integra IPS'
const VERSIONS = { contrato: '1.0', datos: '1.0', terminos: '1.0' }
const CODES = { contrato: 'IIPS-LEG-001', datos: 'IIPS-LEG-002', terminos: 'IIPS-LEG-003' }
const EFFECTIVE = '2026-11-11'
const TITLES = {
  contrato: 'Contrato de prestación de servicios de software como servicio (SaaS)',
  datos: 'Acuerdo de transmisión y tratamiento de datos personales',
  terminos: 'Términos y condiciones de uso'
}

const cop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0)
const fdate = (iso) => (iso ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00`)) : 'la fecha de firma')
const annual = (p) => Math.round((Number(p.price_month) * 12 * (1 - Number(p.annual_discount) / 100)) / 100) * 100
const v = (x, fb = '[por definir]') => (x == null || x === '' ? fb : x)
const SUPPORT = {
  esencial: ['Correo electrónico', '2 días hábiles', '5 días hábiles'],
  profesional: ['Correo electrónico y chat', '1 día hábil', '3 días hábiles'],
  integral: ['Correo, chat y llamada; soporte prioritario', '4 horas hábiles', '2 días hábiles'],
  humanitario: ['Correo, chat y llamada; soporte prioritario', '4 horas hábiles', '2 días hábiles']
}

// ---------------------------------------------------------------- Contrato (dinámico)
const contrato = ({ org, plan, provider, features }) => {
  const cycleAnual = org.billing_cycle === 'anual'
  const value = plan ? (cycleAnual ? annual(plan) : Number(plan.price_month)) : 0
  const sup = SUPPORT[plan?.code] || [plan?.support || 'Correo electrónico', '1 día hábil', '3 días hábiles']
  const included = features.filter((f) => (plan?.features || []).includes(f.key) || (org.extra_features || []).includes(f.key))
  return {
    intro: `Entre ${v(provider.legal_name)}, identificado con NIT ${v(provider.nit)}, representado legalmente por ${v(provider.legal_rep)}, con domicilio en ${v(provider.city)}, en adelante EL PROVEEDOR, y ${org.name}${org.nit ? `, identificada con NIT ${org.nit}` : ''}, con domicilio en ${v(org.city)}, representada por quien firma este documento, en adelante EL CLIENTE, se celebra el presente contrato de prestación de servicios, que se rige por las cláusulas siguientes y, en lo no previsto, por el Código de Comercio y el Código Civil colombianos.`,
    sections: [
      { title: 'Objeto', paragraphs: [`EL PROVEEDOR concede a EL CLIENTE el derecho de uso, no exclusivo e intransferible, de la plataforma ${BRAND} en modalidad de software como servicio (SaaS), a través de internet, durante la vigencia del contrato y de acuerdo con el plan contratado. El servicio no incluye la venta del software ni la cesión de derechos de propiedad intelectual.`] },
      {
        title: 'Plan contratado y funcionalidades',
        paragraphs: [`EL CLIENTE contrata el plan ${v(plan?.name)}${plan?.audience === 'esal' ? ' (plan exclusivo para entidades sin ánimo de lucro; EL CLIENTE declara tener esa naturaleza jurídica y se obliga a acreditarla con su certificado de existencia y representación)' : ''}, con los siguientes límites: ${plan?.max_sites ? `${plan.max_sites} sede(s)` : 'sedes ilimitadas'}, ${plan?.max_users ? `${plan.max_users} usuarios` : 'usuarios ilimitados'}${plan?.storage_gb ? ` y ${plan.storage_gb} GB de almacenamiento de archivos` : ''}. Incluye las siguientes funcionalidades:`],
        items: included.map((f) => f.label)
      },
      {
        title: 'Valor y forma de pago',
        paragraphs: [
          `El valor del servicio es de ${cop(value)} ${cycleAnual ? 'por año, pagadero por anticipado' : 'por mes, pagadero por mes anticipado'}${cycleAnual && plan ? `, que incluye un descuento del ${String(plan.annual_discount).replace('.', ',')} % frente al pago mensual` : ''}. El valor ${provider.nit ? 'se factura electrónicamente conforme a la normativa de la DIAN' : 'se factura de acuerdo con la normativa tributaria aplicable'} y podrá incluir los impuestos que correspondan.`,
          'EL CLIENTE podrá pagar por transferencia o consignación bancaria, en efectivo con recibo de caja, o por los medios electrónicos que EL PROVEEDOR habilite. El servicio se activa o renueva cuando EL PROVEEDOR verifica el pago.',
          'Los precios podrán ajustarse una vez al año, informándolo a EL CLIENTE con al menos treinta (30) días de anticipación a la renovación.'
        ]
      },
      { title: 'Vigencia y renovación', paragraphs: [`El contrato inicia el ${fdate(org.start_date)} y tiene una vigencia de ${cycleAnual ? 'un (1) año' : 'un (1) mes'}${org.renewal_date ? `, con renovación el ${fdate(org.renewal_date)}` : ''}. Se renueva automáticamente por periodos iguales si ninguna de las partes manifiesta por escrito su intención de no renovarlo con al menos quince (15) días de anticipación al vencimiento.`] },
      {
        title: 'Soporte',
        paragraphs: [`Canal de soporte del plan: ${sup[0]}. Horario: ${v(provider.support_hours)}. Contacto: ${v(provider.email, 'el correo que EL PROVEEDOR informe')}${provider.phone ? `, teléfono ${provider.phone}` : ''}.`],
        items: [
          `Tiempo de primera respuesta: ${sup[1]}.`,
          `Tiempo objetivo de solución de fallas que impiden usar el sistema: ${sup[2]}.`,
          'El soporte cubre el uso del sistema, la corrección de fallas y la orientación a los administradores. No incluye desarrollos a la medida, migración masiva de datos ni capacitaciones presenciales, que se cotizan por separado.'
        ]
      },
      {
        title: 'Disponibilidad del servicio',
        paragraphs: ['EL PROVEEDOR procurará una disponibilidad mensual del 99,5 % del sistema, medida fuera de las ventanas de mantenimiento programado, que se informarán con al menos cuarenta y ocho (48) horas de anticipación y se realizarán preferiblemente en horario nocturno o fines de semana.', 'No se consideran indisponibilidad las fallas causadas por la conexión a internet de EL CLIENTE, por fuerza mayor o caso fortuito, ni las interrupciones de los proveedores de infraestructura en la nube ajenas al control razonable de EL PROVEEDOR. EL PROVEEDOR realiza copias de seguridad automáticas de la base de datos.']
      },
      {
        title: 'Obligaciones de EL PROVEEDOR',
        items: ['Prestar el servicio conforme al plan contratado.', 'Mantener medidas de seguridad técnicas y administrativas razonables sobre la información.', 'Tratar los datos personales únicamente según el Acuerdo de transmisión y tratamiento de datos personales, que hace parte integral de este contrato.', 'Informar los cambios relevantes del servicio y las ventanas de mantenimiento.', 'Guardar confidencialidad sobre la información de EL CLIENTE.']
      },
      {
        title: 'Obligaciones de EL CLIENTE',
        items: ['Pagar oportunamente el valor del servicio.', 'Usar el sistema conforme a la ley, a este contrato y a los Términos y condiciones de uso.', 'Contar con la autorización de los titulares para el tratamiento de los datos personales que registre, como responsable del tratamiento.', 'Administrar los usuarios, roles y contraseñas de su personal y retirar oportunamente el acceso de quienes se desvinculen.', 'Verificar la veracidad de la información que registra y de los documentos que carga.']
      },
      { title: 'Suspensión por falta de pago', paragraphs: ['Si EL CLIENTE no paga dentro de los diez (10) días calendario siguientes al vencimiento, EL PROVEEDOR podrá suspender el acceso, previo aviso por correo electrónico. La suspensión no elimina la información, que permanece conservada y se habilita de nuevo al normalizar el pago.'] },
      {
        title: 'Terminación y destino de los datos',
        paragraphs: ['Cualquiera de las partes podrá terminar el contrato al vencimiento del periodo, con el aviso previsto en la cláusula de vigencia, o en cualquier momento por incumplimiento grave de la otra parte. El pago anual no es reembolsable una vez iniciado el periodo, salvo incumplimiento de EL PROVEEDOR.', 'A la terminación, por cualquier causa:'],
        items: [
          'EL CLIENTE tendrá treinta (30) días calendario para solicitar y descargar una copia de su información en formatos estándar (CSV o Excel para los registros y los archivos originales que haya cargado).',
          'Durante ese plazo el acceso será de solo consulta y exportación.',
          'Vencido el plazo, EL PROVEEDOR eliminará de forma segura la información de EL CLIENTE de sus sistemas y de las copias de seguridad dentro de los sesenta (60) días siguientes, y expedirá una certificación de eliminación si EL CLIENTE la solicita.',
          'La conservación de las historias clínicas y demás registros asistenciales por el tiempo que exige la ley (Resolución 1995 de 1999 y Resolución 839 de 2017) es responsabilidad de EL CLIENTE, por lo que debe exportarlos antes de la eliminación.'
        ]
      },
      { title: 'Propiedad intelectual', paragraphs: [`${BRAND}, su código, diseño, marca y documentación son de propiedad de EL PROVEEDOR. La información registrada por EL CLIENTE, incluidos sus documentos, logos y datos, es de propiedad de EL CLIENTE.`] },
      { title: 'Confidencialidad', paragraphs: ['Las partes mantendrán en reserva la información confidencial de la otra parte durante la vigencia del contrato y por cinco (5) años más, salvo requerimiento de autoridad competente. La reserva de la historia clínica se rige por la Ley 23 de 1981 y la Resolución 1995 de 1999.'] },
      { title: 'Limitación de responsabilidad', paragraphs: ['La responsabilidad total de EL PROVEEDOR por daños derivados del contrato se limita al valor pagado por EL CLIENTE en los doce (12) meses anteriores al hecho, salvo dolo o culpa grave. EL PROVEEDOR no responde por decisiones clínicas, administrativas o de habilitación que EL CLIENTE adopte con base en la información registrada.'] },
      { title: 'Firma electrónica', paragraphs: ['Las partes aceptan que este contrato se firme por medios electrónicos dentro de la plataforma, con la misma validez y fuerza obligatoria que la firma manuscrita, de conformidad con la Ley 527 de 1999 y el Decreto 2364 de 2012 (compilado en el Decreto 1074 de 2015). La plataforma conserva el texto firmado, la fecha y hora, el usuario y la dirección IP como evidencia.'] },
      { title: 'Ley aplicable y controversias', paragraphs: [`El contrato se rige por las leyes de la República de Colombia. Las controversias se resolverán primero mediante arreglo directo dentro de los treinta (30) días siguientes a la notificación de la diferencia y, en su defecto, ante los jueces competentes de ${v(provider.city)}.`] }
    ]
  }
}

// ---------------------------------------------------------------- Acuerdo de datos personales
const datos = ({ org, provider }) => ({
  intro: `Este acuerdo hace parte integral del contrato de prestación de servicios de ${BRAND} celebrado entre ${org.name}${org.nit ? ` (NIT ${org.nit})` : ''}, que actúa como RESPONSABLE del tratamiento de los datos personales, y ${v(provider.legal_name)}${provider.nit ? ` (NIT ${provider.nit})` : ''}, que actúa como ENCARGADO del tratamiento, en los términos de la Ley 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) y demás normas que las modifiquen o complementen. Por tratarse de una transmisión de datos, este documento constituye el contrato de transmisión previsto en el artículo 2.2.2.25.5.2 del Decreto 1074 de 2015.`,
  sections: [
    { title: 'Datos objeto del tratamiento', items: ['Datos de pacientes y usuarios de los servicios de salud: identificación, contacto, datos de atención, resultados y registros asistenciales. Incluyen datos sensibles relativos a la salud (artículo 5 de la Ley 1581 de 2012) y, cuando aplique, datos de niñas, niños y adolescentes.', 'Datos del talento humano: identificación, contacto, formación, soportes, contratos, seguridad social y firma digital.', 'Datos de voluntarios, conductores y demás personas que participan en las actividades del RESPONSABLE, cuando el plan los incluya.', 'Datos de los usuarios del sistema: nombre, usuario, correo, rol y registros de actividad.'] },
    { title: 'Finalidad', paragraphs: ['El ENCARGADO tratará los datos únicamente para prestar el servicio contratado: almacenarlos, procesarlos, mostrarlos a los usuarios autorizados del RESPONSABLE, generar reportes y formatos, hacer copias de seguridad y brindar soporte. No los usará para fines propios, comerciales o publicitarios, ni los venderá o cederá a terceros.'] },
    { title: 'Obligaciones del RESPONSABLE', items: ['Obtener y conservar la autorización previa, expresa e informada de los titulares, en especial la autorización explícita para datos sensibles de salud, salvo las excepciones legales.', 'Contar con su política de tratamiento de datos e informarla a los titulares.', 'Atender las consultas y reclamos de los titulares, con el apoyo del ENCARGADO cuando se requiera.', 'Registrar sus bases de datos en el Registro Nacional de Bases de Datos (RNBD) cuando esté obligado.', 'Garantizar la reserva de la historia clínica y que solo su personal autorizado acceda a ella.'] },
    { title: 'Obligaciones del ENCARGADO (artículo 18 de la Ley 1581 de 2012)', items: ['Tratar los datos solo conforme a las instrucciones del RESPONSABLE y a este acuerdo.', 'Garantizar a los titulares, a través del RESPONSABLE, el ejercicio de sus derechos de conocer, actualizar, rectificar y suprimir sus datos.', 'Conservar la información con medidas de seguridad que impidan su adulteración, pérdida, consulta, uso o acceso no autorizado: cifrado en tránsito (HTTPS), control de acceso por usuario, rol, módulo y sede, contraseñas cifradas, copias de seguridad y registro de firmas.', 'Guardar confidencialidad y exigirla a su personal y a los subencargados.', 'Informar al RESPONSABLE cualquier violación de seguridad que afecte los datos dentro de las setenta y dos (72) horas siguientes a su conocimiento, para que este evalúe el reporte a la Superintendencia de Industria y Comercio.', 'Abstenerse de circular información que esté siendo controvertida por el titular.'] },
    { title: 'Subencargados y transferencia internacional', paragraphs: [`Para prestar el servicio el ENCARGADO utiliza los siguientes proveedores de infraestructura en la nube: ${v(provider.hosting)}. Algunos de ellos almacenan o procesan la información fuera de Colombia, en países que cuentan con niveles adecuados de protección o bajo cláusulas contractuales que garantizan la seguridad de los datos. El RESPONSABLE autoriza esta transmisión internacional, y el ENCARGADO le informará cualquier cambio de subencargado con al menos treinta (30) días de anticipación.`] },
    { title: 'Historia clínica y registros asistenciales', paragraphs: ['La historia clínica es un documento privado sometido a reserva (Ley 23 de 1981, Resolución 1995 de 1999 y Ley 2015 de 2020). El ENCARGADO no accederá a su contenido salvo cuando sea estrictamente necesario para atender una solicitud de soporte del RESPONSABLE, caso en el cual dejará constancia. La conservación por los tiempos legales corresponde al RESPONSABLE.'] },
    { title: 'Devolución y supresión', paragraphs: ['Al terminar el contrato, el ENCARGADO pondrá los datos a disposición del RESPONSABLE para su descarga durante treinta (30) días y luego los suprimirá de forma segura, incluidas las copias de seguridad, dentro de los sesenta (60) días siguientes, salvo que una norma exija conservarlos. Expedirá certificación de supresión si se le solicita.'] },
    { title: 'Auditoría', paragraphs: ['El RESPONSABLE podrá solicitar, una vez al año y con aviso de quince (15) días, información sobre las medidas de seguridad aplicadas. El ENCARGADO la entregará por escrito sin comprometer la seguridad de otros clientes.'] },
    { title: 'Contacto y vigencia', paragraphs: [`Las solicitudes relacionadas con datos personales se dirigen al correo ${v(provider.privacy_email || provider.email, 'que informe el ENCARGADO')}. Este acuerdo tiene la misma vigencia del contrato principal y sus obligaciones de confidencialidad y supresión continúan después de su terminación.`] }
  ]
})

// ---------------------------------------------------------------- Términos y condiciones (cada usuario)
const terminos = ({ org, provider }) => ({
  intro: `Estos términos regulan el uso de ${BRAND} por parte de los usuarios a quienes ${org?.name || 'la institución cliente'} crea una cuenta. Al marcar "Acepto" el usuario declara haberlos leído y aceptado.`,
  sections: [
    { title: 'Cuenta y acceso', items: ['La cuenta es personal e intransferible. No compartas tu usuario ni tu contraseña.', 'Eres responsable de las acciones realizadas con tu cuenta. Si sospechas un uso no autorizado, avisa de inmediato al administrador de tu institución.', 'Solo puedes acceder a los módulos y sedes que el administrador te habilite.'] },
    { title: 'Uso adecuado', items: ['Usa el sistema únicamente para las funciones propias de tu cargo en la institución.', 'Registra información veraz, completa y oportuna.', 'No intentes acceder a información de otras sedes, módulos o instituciones sin autorización, ni vulnerar la seguridad del sistema.', 'No cargues archivos con virus, contenido ilegal o información ajena a la gestión institucional.'] },
    { title: 'Datos personales y reserva', paragraphs: [`La información que consultas incluye datos personales y, en muchos casos, datos sensibles de salud. Debes tratarla con reserva, solo para los fines autorizados y conforme a la Ley 1581 de 2012 y a la política de tratamiento de datos de ${org?.name || 'tu institución'}. Tus propios datos como usuario (nombre, identificación, correo, firma y registros de actividad) se tratan para gestionar tu acceso, firmar documentos y garantizar la trazabilidad.`] },
    { title: 'Firma digital', paragraphs: ['La firma que registras en "Mi firma digital" se estampa en los documentos que firmes dentro del sistema, junto con tu nombre, identificación, fecha y hora. Al firmar declaras que revisaste el documento y que su contenido es correcto. Esta firma electrónica tiene validez conforme a la Ley 527 de 1999.'] },
    { title: 'Disponibilidad y cambios', paragraphs: [`El servicio se presta por internet y puede tener interrupciones por mantenimiento o causas externas. ${BRAND} puede mejorar o modificar funcionalidades; los cambios relevantes de estos términos se informarán y deberán aceptarse de nuevo.`] },
    { title: 'Propiedad intelectual', paragraphs: [`El software, el diseño y la marca ${BRAND} son de su titular. La información registrada pertenece a la institución.`] },
    { title: 'Incumplimiento', paragraphs: ['El incumplimiento de estos términos puede dar lugar a la suspensión de la cuenta por parte del administrador de la institución, sin perjuicio de las acciones disciplinarias o legales que correspondan.'] },
    { title: 'Ley aplicable y contacto', paragraphs: [`Estos términos se rigen por la ley colombiana. Dudas sobre el sistema: ${v(provider.email, 'el administrador de tu institución')}.`] }
  ]
})
const RENDER = { contrato, datos, terminos }

const tenant = require('./tenant')
module.exports = (app, deps) => {
  const { supabase, auth, h, fail, clean, ADMIN, platform } = deps
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  const hx = (fn) => h(async (req, res) => { try { await fn(req, res) } catch (e) { if (e.status) return fail(res, e.message, e.status); throw e } })
  const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim()

  const loadProvider = async () => (await supabase.from('plt_provider').select('*').eq('id', 1).single()).data || {}
  const loadOrg = async (id) => {
    const q = supabase.from('plt_organizations').select('*, plan:plt_plans(*)')
    const org = id || tenant.currentOrg()
    const { data } = org ? await q.eq('id', org).maybeSingle() : await q.eq('is_current', true).maybeSingle()
    return data
  }
  const loadFeatures = async () => (await supabase.from('plt_features').select('*').order('sort_order')).data || []
  const render = async (kind, org) => {
    if (!RENDER[kind]) throw httpError(404, 'Documento no encontrado')
    const [provider, features] = await Promise.all([loadProvider(), loadFeatures()])
    const body = RENDER[kind]({ org: org || {}, plan: org?.plan, provider, features })
    return {
      kind, code: CODES[kind], version: VERSIONS[kind], title: TITLES[kind], effectiveDate: EFFECTIVE, brand: BRAND,
      organization: org ? { id: org.id, name: org.name, nit: org.nit, city: org.city, planName: org.plan?.name ?? null, billingCycle: org.billing_cycle } : null,
      provider: { legalName: provider.legal_name, nit: provider.nit, legalRep: provider.legal_rep, legalRepId: provider.legal_rep_id, city: provider.city, email: provider.email },
      ...body
    }
  }
  const sigDTO = (s) => ({ id: s.id, party: s.party, signerName: s.signer_name, signerId: s.signer_id, signerRole: s.signer_role, signatureUrl: s.signature_url, signedAt: s.signed_at, ip: s.ip, version: s.version })
  const signaturesOf = async (orgId, kind) => {
    const { data } = await supabase.from('plt_legal_signatures').select('*').eq('organization_id', orgId).eq('kind', kind).eq('version', VERSIONS[kind])
    return (data || []).map(sigDTO)
  }

  // Estado legal de la instalación (en caché): el cliente debe firmar contrato y acuerdo de datos vigentes.
  // Estado por organización (en caché 30 s).
  const states = new Map()
  const refresh = async () => {
    const org = await loadOrg()
    const key = org?.id || 0
    if (!org) { const st = { pending: false, loadedAt: Date.now() }; states.set(key, st); return st }
    const { data } = await supabase.from('plt_legal_signatures').select('kind, version').eq('organization_id', org.id).eq('party', 'cliente')
    const ok = (k) => (data || []).some((s) => s.kind === k && s.version === VERSIONS[k])
    const st = { pending: !(ok('contrato') && ok('datos')), loadedAt: Date.now() }
    states.set(key, st)
    return st
  }
  const current = async () => { const st = states.get(tenant.currentOrg() || 0); return !st || Date.now() - st.loadedAt > 30000 ? refresh() : st }

  // ---------------------------------------------------------------- Sistema (usuarios de la instalación)
  app.get('/legal/estado', auth(), hx(async (req, res) => {
    const st = await refresh()
    const org = await loadOrg()
    const { data: t } = await supabase.from('plt_terms_acceptances').select('accepted_at').eq('user_id', req.user.id).eq('version', VERSIONS.terminos).maybeSingle()
    const docs = org ? await Promise.all(['contrato', 'datos'].map(async (k) => ({ kind: k, title: TITLES[k], code: CODES[k], version: VERSIONS[k], signatures: await signaturesOf(org.id, k) }))) : []
    res.send({ activationPending: st.pending, organization: org ? { name: org.name, planName: org.plan?.name ?? null } : null, documents: docs, terms: { version: VERSIONS.terminos, acceptedAt: t?.accepted_at ?? null } })
  }))
  app.get('/legal/documento/:kind', auth(), hx(async (req, res) => {
    const org = await loadOrg()
    const doc = await render(req.params.kind, org)
    const signatures = org && req.params.kind !== 'terminos' ? await signaturesOf(org.id, req.params.kind) : []
    res.send({ ...doc, signatures })
  }))
  // Firma del cliente: solo el administrador de la instalación (actúa como representante legal o su delegado).
  app.post('/legal/firmar/:kind', auth(ADMIN), hx(async (req, res) => {
    const kind = req.params.kind
    if (!['contrato', 'datos'].includes(kind)) return fail(res, 'Documento inválido', 400)
    const org = await loadOrg()
    if (!org) return fail(res, 'No hay una organización asociada a esta instalación', 400)
    if (!req.user.signature_url) return fail(res, 'Primero crea tu firma en Mi firma digital.', 400)
    const b = req.body || {}
    if (!clean(b.signerName) || !clean(b.signerId) || !clean(b.signerRole)) return fail(res, 'Indica nombre, documento y cargo de quien firma', 400)
    if (b.accept !== true) return fail(res, 'Debes declarar que leíste y aceptas el documento', 400)
    const snapshot = await render(kind, org)
    const { error } = await supabase.from('plt_legal_signatures').insert({
      organization_id: org.id, kind, version: VERSIONS[kind], party: 'cliente', user_id: req.user.id, signer_name: clean(b.signerName), signer_id: clean(b.signerId),
      signer_role: clean(b.signerRole), signature_url: req.user.signature_url, snapshot, ip: ipOf(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    })
    if (error) { if (error.code === '23505') return fail(res, 'Este documento ya está firmado', 409); throw error }
    const st = await refresh(); platform?.refresh?.()
    res.status(201).send({ ok: true, activationPending: st.pending })
  }))
  app.post('/legal/terminos/aceptar', auth(), hx(async (req, res) => {
    if (req.body?.accept !== true) return fail(res, 'Debes aceptar los términos y condiciones', 400)
    const { error } = await supabase.from('plt_terms_acceptances').insert({ user_id: req.user.id, version: VERSIONS.terminos, ip: ipOf(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 300) })
    if (error && error.code !== '23505') throw error
    res.send({ ok: true })
  }))

  // ---------------------------------------------------------------- Plataforma (proveedor)
  const pauth = deps.pauth
  app.get('/plataforma/proveedor', pauth, hx(async (req, res) => res.send(await loadProvider())))
  app.put('/plataforma/proveedor', pauth, hx(async (req, res) => {
    const b = req.body || {}
    if (!clean(b.legal_name)) return fail(res, 'La razón social es requerida', 400)
    const row = Object.fromEntries(['legal_name', 'nit', 'legal_rep', 'legal_rep_id', 'city', 'address', 'email', 'phone', 'support_hours', 'privacy_email', 'hosting'].map((k) => [k, clean(b[k])]))
    const { error } = await supabase.from('plt_provider').update({ ...row, updated_at: new Date().toISOString() }).eq('id', 1)
    if (error) throw error
    res.send(await loadProvider())
  }))
  app.get('/plataforma/organizaciones/:id/legal', pauth, hx(async (req, res) => {
    const org = await loadOrg(Number(req.params.id))
    if (!org) return fail(res, 'Organización no encontrada', 404)
    res.send(await Promise.all(['contrato', 'datos'].map(async (k) => ({ kind: k, title: TITLES[k], code: CODES[k], version: VERSIONS[k], signatures: await signaturesOf(org.id, k) }))))
  }))
  app.get('/plataforma/organizaciones/:id/legal/:kind', pauth, hx(async (req, res) => {
    const org = await loadOrg(Number(req.params.id))
    if (!org) return fail(res, 'Organización no encontrada', 404)
    // Si el cliente ya firmó, se muestra el texto exactamente como lo firmó.
    const { data: signed } = await supabase.from('plt_legal_signatures').select('snapshot').eq('organization_id', org.id).eq('kind', req.params.kind).eq('party', 'cliente').eq('version', VERSIONS[req.params.kind] || '').maybeSingle()
    const doc = signed?.snapshot || await render(req.params.kind, org)
    res.send({ ...doc, signatures: req.params.kind === 'terminos' ? [] : await signaturesOf(org.id, req.params.kind) })
  }))
  app.post('/plataforma/organizaciones/:id/legal/:kind/firmar', pauth, hx(async (req, res) => {
    const kind = req.params.kind
    if (!['contrato', 'datos'].includes(kind)) return fail(res, 'Documento inválido', 400)
    const org = await loadOrg(Number(req.params.id))
    if (!org) return fail(res, 'Organización no encontrada', 404)
    const { data: u } = await supabase.from('users').select('id, name, last_name, identification, signature_url').eq('id', req.puser.id).single()
    if (!u.signature_url) return fail(res, 'Tu usuario no tiene firma digital. Créala en el sistema (Mi firma digital).', 400)
    const provider = await loadProvider()
    const { error } = await supabase.from('plt_legal_signatures').insert({
      organization_id: org.id, kind, version: VERSIONS[kind], party: 'proveedor', user_id: u.id, signer_name: provider.legal_rep || `${u.name} ${u.last_name}`,
      signer_id: provider.legal_rep_id || u.identification, signer_role: `Representante legal · ${provider.legal_name || BRAND}`, signature_url: u.signature_url,
      snapshot: await render(kind, org), ip: ipOf(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    })
    if (error) { if (error.code === '23505') return fail(res, 'Ya está firmado por el proveedor', 409); throw error }
    res.status(201).send({ ok: true })
  }))
  // Público: términos y condiciones (para mostrarlos en la página de precios).
  app.get('/legal/publico/terminos', hx(async (req, res) => res.send(await render('terminos', null))))

  return { current, refresh }
}
module.exports.VERSIONS = VERSIONS
