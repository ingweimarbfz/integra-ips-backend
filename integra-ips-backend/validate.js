// Validaciones comunes de datos (las mismas reglas que usa el frontend en src/utils/validate.js).
// Teléfonos: en Colombia celulares (3xx) y fijos (60x) tienen 10 dígitos.
const digits = (v) => String(v ?? '').replace(/\D/g, '')
const str = (v) => String(v ?? '').trim()

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
const PHONE_RE = /^\d{10}$/
// Documentos que solo llevan números; los demás (pasaporte, cédula de extranjería, PPT…) pueden llevar letras.
const NUMERIC_DOCS = ['CC', 'TI', 'RC', 'NUIP', 'CN', 'NIT', 'Cédula de ciudadanía', 'Tarjeta de identidad', 'Registro civil']
const PLATE_RE = /^[A-Z]{3}\d{2}[A-Z\d]$/ // ABC123 (carro) o ABC12D (moto)

// Devuelve el valor normalizado o null si viene vacío; lanza el mensaje de error si es inválido.
const phone = (v) => { const d = digits(v); return d ? d : null }
const phoneError = (v, label = 'El teléfono') => (digits(v) && !PHONE_RE.test(digits(v)) ? `${label} debe tener 10 dígitos` : null)
const emailError = (v, label = 'El correo') => (str(v) && !EMAIL_RE.test(str(v)) ? `${label} no es válido` : null)
const docNumber = (v) => str(v).replace(/[\s.-]/g, '').toUpperCase() || null
const docError = (v, type, label = 'El número de documento') => {
  const d = docNumber(v); if (!d) return null
  if (NUMERIC_DOCS.includes(type)) return /^\d{4,11}$/.test(d) ? null : `${label} debe tener solo números (entre 4 y 11)`
  return /^[A-Z0-9]{4,16}$/.test(d) ? null : `${label} debe tener solo letras y números (entre 4 y 16)`
}
const nit = (v) => { const s = str(v).replace(/[\s.]/g, ''); return s || null }
const nitError = (v, label = 'El NIT') => (nit(v) && !/^\d{6,10}(-\d)?$/.test(nit(v)) ? `${label} debe tener entre 6 y 10 dígitos y, si quieres, el dígito de verificación (900123456-7)` : null)
const plate = (v) => str(v).toUpperCase().replace(/[\s-]/g, '') || null
const plateError = (v) => (plate(v) && !PLATE_RE.test(plate(v)) ? 'La placa debe tener el formato ABC123 (o ABC12D para motos)' : null)


// IIPS-021 · Fecha y hora manual de realización (eventos, servicios y traslados).
// Sin valor se usa la hora del sistema. Con valor ("YYYY-MM-DDTHH:mm", hora de Colombia, o ISO con zona) debe ser
// pasada (5 min de tolerancia), no más de MANUAL_MAX_DAYS atrás y, si se da, posterior a "after".
const MANUAL_MAX_DAYS = 30
const manualTime = (value, { after, label = 'La fecha y hora' } = {}) => {
  if (value === undefined || value === null || value === '') return { iso: new Date().toISOString(), manual: false }
  const str = String(value).trim()
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(str) ? str : `${str.length === 16 ? `${str}:00` : str}-05:00`
  const d = new Date(withZone)
  if (Number.isNaN(d.getTime())) return { error: `${label} no es válida` }
  const now = Date.now()
  if (d.getTime() > now + 5 * 60000) return { error: `${label} no puede ser futura` }
  if (d.getTime() < now - MANUAL_MAX_DAYS * 86400000) return { error: `${label} no puede ser de hace más de ${MANUAL_MAX_DAYS} días` }
  if (after && d.getTime() < new Date(after).getTime()) return { error: `${label} no puede ser anterior al inicio` }
  return { iso: d.toISOString(), manual: true }
}

module.exports = { manualTime, MANUAL_MAX_DAYS, digits, EMAIL_RE, PHONE_RE, phone, phoneError, emailError, docNumber, docError, nit, nitError, plate, plateError }
