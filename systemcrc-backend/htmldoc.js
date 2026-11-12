// =====================================================================
// Documentos en línea (HTML): el usuario escribe y da formato al texto en la app
// (fuentes, tamaños, colores, listas, tablas…) en lugar de cargar un archivo.
// El HTML se limpia en el servidor: solo etiquetas y estilos de formato, sin scripts ni eventos.
// =====================================================================
const sanitizeHtml = require('sanitize-html')

const MAX_HTML = 2 * 1024 * 1024
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i]
const LEN = [/^[\d.]+(px|pt|em|rem|%)$/i, /^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/i]
const OPTIONS = {
  allowedTags: ['p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark', 'small',
    'font', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'],
  allowedAttributes: {
    '*': ['style', 'align'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    font: ['color', 'face', 'size'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start', 'type']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedStyles: {
    '*': {
      color: COLOR, 'background-color': COLOR,
      'font-family': [/^[\w\s"',-]+$/], 'font-size': LEN, 'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/], 'font-style': [/^(normal|italic)$/],
      'text-decoration': [/^[a-z\s-]+$/i], 'text-decoration-line': [/^[a-z\s-]+$/i], 'text-align': [/^(left|right|center|justify|start|end)$/],
      'line-height': [/^[\d.]+(px|em|rem|%)?$/], 'margin-left': LEN, 'padding-left': LEN, 'width': LEN, 'border': [/^[\w\s#().,%-]+$/], 'border-collapse': [/^(collapse|separate)$/],
      'vertical-align': [/^(top|middle|bottom|baseline)$/]
    }
  },
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) }
}

const sanitize = (html) => sanitizeHtml(String(html || ''), OPTIONS).trim()
// Texto plano del documento (para validar que no esté vacío y para la búsqueda).
const plainText = (html) => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

// Campos de archivo de un documento en línea: se guarda como HTML en la base de datos (sin archivo en el almacenamiento).
const htmlFields = (name, raw, httpError) => {
  const html = sanitize(raw)
  if (!plainText(html) && !/<img\b/i.test(html)) throw httpError(400, 'Escribe el contenido del documento')
  const size = Buffer.byteLength(html)
  if (size > MAX_HTML) throw httpError(400, 'El documento es muy grande (máximo 2 MB, revisa las imágenes pegadas)')
  return { content_html: html, file_type: 'text/html', file_name: `${String(name || 'documento').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150)}.html`, file_size: size, file_url: null, file_path: null }
}

module.exports = { sanitize, plainText, htmlFields }
