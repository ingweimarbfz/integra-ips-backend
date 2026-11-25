// IIPS-036 · Datos de prueba de talento humano (org 1): personas de IPS y de otras dependencias con distintos
// cargos, contratos y antigüedad, para revisar el cálculo de vacaciones y las solicitudes.
// Uso: node supabase/seeds/th_vacaciones_prueba.js   (idempotente: no repite documentos ya existentes)
require('dotenv').config({ quiet: true })
const { createClient } = require('@supabase/supabase-js')
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const ORG = 1
const ok = (r) => { if (r.error) throw new Error(r.error.message); return r.data }

const PEOPLE = [
  // [nombres, apellidos, documento, cargo, dependencia (null = IPS), sede, usuario, contratos [tipo, inicio, fin], vacaciones tomadas [inicio, fin, días, tipo]]
  ['Ana María', 'Gutiérrez Pérez', '1065123401', 'Coordinador(a) administrativo(a)', 'Administrativo', 1, 4, [['indefinido', '2021-05-03', null]], [['2022-07-05', '2022-07-25', 15], ['2023-12-18', '2024-01-10', 15], ['2025-01-13', '2025-01-31', 15], ['2025-12-15', '2025-12-23', 7.5, 'compensadas']]],
  ['Weimar', 'Barraza', '1065899569', 'Gerente', 'Administrativo', 1, 1, [['indefinido', '2025-02-01', null]], []],
  ['Luis Carlos', 'Mendoza Ríos', '1065123402', 'Contador(a)', 'Contabilidad', 1, 5, [['termino_fijo', '2025-06-01', '2026-05-31'], ['termino_fijo', '2026-06-01', '2027-05-31']], [['2026-04-06', '2026-04-13', 6]]],
  ['Jorge Iván', 'Castro Molina', '1065123404', 'Instructor(a)', 'Educación', 1, 7, [['obra_labor', '2026-03-01', '2027-02-28']], []],
  ['Paola Andrea', 'Fuentes Daza', '1065123405', 'Auxiliar de servicios generales', 'Servicios generales', 1, 8, [['medio_tiempo', '2024-10-01', null]], [['2025-12-22', '2026-01-06', 10]]],
  ['Hernán Darío', 'Mejía Quintero', '1065800302', 'Conductor de ambulancia', 'Conductores', 1, 12, [['tiempo_completo', '2026-09-01', null]], []],
  ['Kevin Steven', 'Daza Romero', '1065950101', 'Aprendiz SENA', 'Administrativo', 1, null, [['aprendizaje', '2026-07-01', '2027-06-30']], []],
  ['Laura Ximena', 'Pinto Arias', '1065950102', 'Asesor(a) jurídico(a)', 'Administrativo', 1, null, [['prestacion_servicios', '2026-02-01', '2026-12-31']], []],
  ['Mauricio José', 'Araújo Celedón', '1065950103', 'Operador de radio', 'Socorro y operaciones', 1, null, [['temporal', '2026-05-01', '2026-12-31']], []]
]
// Vacaciones ya disfrutadas por personal existente de la IPS (para que el saldo no se dispare).
const IPS_TAKEN = { '1065700106': [['2021-07-06', '2021-07-26', 15], ['2022-07-05', '2022-07-25', 15], ['2023-07-04', '2023-07-24', 15], ['2024-07-02', '2024-07-22', 15], ['2025-07-01', '2025-07-21', 15]], '1065123403': [['2024-06-04', '2024-06-24', 15], ['2025-06-03', '2025-06-13', 9]] }

;(async () => {
  const deps = ok(await s.from('th_dependencies').select('id, name').eq('org_id', ORG))
  let positions = ok(await s.from('th_positions').select('id, name').eq('org_id', ORG))
  for (const name of [...new Set(PEOPLE.map((p) => p[3]))]) {
    if (!positions.find((p) => p.name === name)) positions.push(ok(await s.from('th_positions').insert({ org_id: ORG, name, active: true }).select('id, name').single()))
  }
  const existing = ok(await s.from('th_staff').select('id, document').eq('org_id', ORG))
  for (const [first, last, doc, pos, dep, site, user, contracts, taken] of PEOPLE) {
    if (existing.find((e) => e.document === doc)) { console.log('ya existe', first, last); continue }
    const st = ok(await s.from('th_staff').insert({ org_id: ORG, first_name: first, last_name: last, document_type: 'CC', document: doc, position_id: positions.find((p) => p.name === pos).id, dependency_id: dep ? deps.find((d) => d.name === dep).id : null, site_id: site, user_id: user, hire_date: contracts[0][1], status: 'activo', active: true, city: 'Valledupar' }).select('id').single())
    let n = 1
    for (const [type, start, end] of contracts) ok(await s.from('th_contracts').insert({ org_id: ORG, staff_id: st.id, contract_type: type, number: `CT-PR-${doc.slice(-3)}-${n++}`, start_date: start, end_date: end, weekly_hours: type === 'medio_tiempo' ? 24 : 46, position_name: pos }))
    for (const [a, b, d, kind] of taken) ok(await s.from('th_vacations').insert({ org_id: ORG, staff_id: st.id, start_date: a, end_date: b, business_days: d, kind: kind || 'disfrute', notes: 'Dato de prueba' }))
    console.log('creado', first, last)
  }
  for (const [doc, taken] of Object.entries(IPS_TAKEN)) {
    const st = existing.find((e) => e.document === doc); if (!st) continue
    const has = ok(await s.from('th_vacations').select('id').eq('staff_id', st.id))
    if (has.length) continue
    for (const [a, b, d] of taken) ok(await s.from('th_vacations').insert({ org_id: ORG, staff_id: st.id, start_date: a, end_date: b, business_days: d, kind: 'disfrute', notes: 'Dato de prueba' }))
    console.log('vacaciones IPS', doc)
  }
  // Solicitudes de ejemplo (requiere la migración 20261125).
  const req = await s.from('th_vacation_requests').select('id').eq('org_id', ORG).limit(1)
  if (req.error) return console.log('Sin tabla de solicitudes todavía:', req.error.message)
  if (req.data.length) return console.log('Ya hay solicitudes')
  const staff = ok(await s.from('th_staff').select('id, document').eq('org_id', ORG))
  const id = (doc) => staff.find((x) => x.document === doc)?.id
  const rows = [
    { staff_id: id('1065123403'), start_date: '2026-12-14', end_date: '2026-12-28', business_days: 10, notes: 'Fin de año con la familia', requested_by: 6 },
    { staff_id: id('1065123402'), start_date: '2027-01-12', end_date: '2027-01-25', business_days: 10, notes: 'Viaje', requested_by: 5 },
    { staff_id: id('1065123405'), start_date: '2026-12-21', end_date: '2026-12-29', business_days: 5, requested_by: 8 }
  ].filter((r) => r.staff_id).map((r) => ({ ...r, org_id: ORG }))
  ok(await s.from('th_vacation_requests').insert(rows))
  console.log('solicitudes', rows.length)
})().catch((e) => { console.error(e.message); process.exit(1) })
