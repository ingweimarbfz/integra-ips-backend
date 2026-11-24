// Calendario de Colombia: festivos (Ley 51 de 1983 "Ley Emiliani" y fiestas según la Pascua) y días hábiles.
const iso = (d) => d.toISOString().slice(0, 10)
const addD = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }
const nextMonday = (d) => { const w = d.getUTCDay(); return w === 1 ? d : addD(d, (8 - w) % 7) }
const easter = (y) => { const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451); const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1; return new Date(Date.UTC(y, month - 1, day)) }
const cache = new Map()
const holidays = (y) => {
  if (cache.has(y)) return cache.get(y)
  const D = (m, d) => new Date(Date.UTC(y, m - 1, d)); const E = easter(y)
  const set = new Set([D(1, 1), D(5, 1), D(7, 20), D(8, 7), D(12, 8), D(12, 25), addD(E, -3), addD(E, -2),
    ...[D(1, 6), D(3, 19), D(6, 29), D(8, 15), D(10, 12), D(11, 1), D(11, 11), addD(E, 39), addD(E, 60), addD(E, 68)].map(nextMonday)].map(iso))
  cache.set(y, set); return set
}
const isBusiness = (d) => { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(iso(d)) }
// Fecha que resulta de sumar n días hábiles a una fecha (el día de inicio no cuenta, como en los términos legales).
const addBusinessDays = (startIso, n) => { let d = new Date(`${startIso.slice(0, 10)}T00:00:00Z`); let c = 0; while (c < n) { d = addD(d, 1); if (isBusiness(d)) c += 1 } return iso(d) }
// Días hábiles entre dos fechas (sin contar la inicial).
const businessDaysBetween = (aIso, bIso) => { let a = new Date(`${aIso.slice(0, 10)}T00:00:00Z`); const b = new Date(`${bIso.slice(0, 10)}T00:00:00Z`); let n = 0; const sign = b >= a ? 1 : -1; while ((sign > 0 && a < b) || (sign < 0 && a > b)) { a = addD(a, sign); if (isBusiness(a)) n += sign } return n }
module.exports = { holidays, isBusiness, addBusinessDays, businessDaysBetween }
