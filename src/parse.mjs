// Convierte las tablas de cada proveedor en leads con una forma común.
// Soporta dos casos:
//  1) Tabla con encabezado en las primeras filas (export de Meta: id, created_time, form_id, email…).
//  2) Tabla sin encabezado útil, como el repositorio de Grupo Nods, donde cada fila trae los valores
//     con prefijos de Meta (l:, f:, c:, p:) y el encabezado aparece desfasado a la derecha. Ahí se
//     reconoce cada dato por su forma.
import { normalizar, limpiarEmail, sinPrefijo, parseFecha, RE_EMAIL } from './util.mjs';

const ALIAS = {
  id: ['id', 'lead id', 'leadgen id', 'id del lead'],
  fecha: ['created time', 'fecha', 'fecha de creacion', 'created', 'fecha del lead'],
  formId: ['form id', 'id del formulario'],
  formNombre: ['form name', 'formulario', 'nombre del formulario'],
  campana: ['campaign name', 'campana', 'nombre de la campana'],
  anuncio: ['ad name', 'anuncio'],
  plataforma: ['platform', 'plataforma'],
  email: ['email', 'correo electronico', 'correo', 'e mail', 'mail'],
  nombreCompleto: ['full name', 'name', 'nombre completo'],
  nombre: ['first name', 'nombre', 'nombres'],
  apellido: ['last name', 'apellido', 'apellidos'],
  programa: ['programa', 'program', 'posgrado', 'programa de interes', 'posgrado de interes'],
};
const PLATAFORMAS = new Set(['fb', 'ig', 'an', 'msg', 'th', 'facebook', 'instagram']);
const RE_FECHA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const RE_ESTATUS = /^(created|complete|completed|creado)$/i;

function mapaEncabezado(fila) {
  const norm = fila.map(normalizar);
  const m = {};
  for (const [campo, alias] of Object.entries(ALIAS)) {
    const i = norm.findIndex(c => alias.includes(c));
    if (i >= 0) m[campo] = i;
  }
  return m;
}

function buscarEncabezado(filas) {
  for (let r = 0; r < Math.min(filas.length, 10); r++) {
    const m = mapaEncabezado(filas[r] || []);
    const inicio = Math.min(...Object.values(m));
    if (m.email !== undefined && (m.fecha !== undefined || m.id !== undefined) && inicio <= 2) return { fila: r, mapa: m };
  }
  return null;
}

const pareceNombre = s => !!s && !/[_@:]/.test(s) && !/^\d/.test(s) && s.length <= 60;

function filaHeuristica(celdas) {
  let fin = celdas.findIndex(c => RE_ESTATUS.test(String(c).trim()));
  if (fin < 0) fin = celdas.length;
  // Si antes del estatus aparece un encabezado pegado ("id", "created_time"), se corta ahí.
  for (let i = 1; i < fin; i++) if (normalizar(celdas[i]) === 'id' && normalizar(celdas[i + 1]) === 'created time') { fin = i; break; }
  const d = celdas.slice(0, fin).map(c => String(c ?? '').trim());
  const idx = re => d.findIndex(c => re.test(c));
  const o = {};
  const iLead = idx(/^l:\d+$/i);
  o.id = iLead >= 0 ? sinPrefijo(d[iLead]) : (/^\d{12,20}$/.test(d[0]) ? d[0] : '');
  const iFecha = idx(RE_FECHA); o.fecha = iFecha >= 0 ? d[iFecha] : '';
  const iForm = idx(/^f:\d+$/i); if (iForm >= 0) { o.formId = sinPrefijo(d[iForm]); o.formNombre = d[iForm + 1] || ''; }
  const iCamp = idx(/^c:\d+$/i); if (iCamp >= 0) o.campana = d[iCamp + 1] || '';
  const iAd = idx(/^ag:\d+$/i); if (iAd >= 0) o.anuncio = d[iAd + 1] || '';
  const desde = Math.max(iForm, 0);
  const iPlat = d.findIndex((c, i) => i > desde && PLATAFORMAS.has(c.toLowerCase()));
  if (iPlat >= 0) o.plataforma = d[iPlat].toLowerCase();
  const iMail = d.findIndex(c => RE_EMAIL.test(c.toLowerCase()));
  if (iMail >= 0) {
    o.email = d[iMail];
    const a = d[iMail - 2], b = d[iMail - 1];
    o.nombreCompleto = [pareceNombre(a) ? a : '', pareceNombre(b) ? b : ''].filter(Boolean).join(' ');
  }
  const iTel = idx(/^p:\+?\d/);
  const desdeProg = Math.max(iTel, iMail);
  if (desdeProg >= 0) {
    for (let i = d.length - 1; i > desdeProg; i--) if (d[i]) { o.programa = d[i]; break; }
  }
  return o;
}

function filaConEncabezado(celdas, m) {
  const v = k => (m[k] !== undefined ? String(celdas[m[k]] ?? '').trim() : '');
  return {
    id: sinPrefijo(v('id')), fecha: v('fecha'), formId: sinPrefijo(v('formId')), formNombre: v('formNombre'),
    campana: v('campana'), anuncio: v('anuncio'), plataforma: v('plataforma').toLowerCase(), email: v('email'),
    nombreCompleto: v('nombreCompleto') || [v('nombre'), v('apellido')].filter(Boolean).join(' '),
    programa: v('programa'),
  };
}

// Devuelve { leads, descartadas } para una tabla.
export function tablaALeads(filas, { pestana = '', zonaSinOffset = '-06:00' } = {}) {
  const enc = buscarEncabezado(filas);
  const leads = []; let descartadas = 0;
  const inicio = enc ? enc.fila + 1 : 0;
  for (let r = inicio; r < filas.length; r++) {
    const celdas = filas[r] || [];
    if (!celdas.some(c => String(c ?? '').trim())) continue;
    const o = enc ? filaConEncabezado(celdas, enc.mapa) : filaHeuristica(celdas);
    const email = limpiarEmail(o.email);
    const t = parseFecha(o.fecha, zonaSinOffset);
    if (!email || !Number.isFinite(t)) { descartadas++; continue; }
    leads.push({
      id: o.id || '', t, email, nombre: (o.nombreCompleto || '').replace(/\s+/g, ' ').trim(),
      formId: o.formId || '', formNombre: o.formNombre || '', campana: o.campana || '',
      plataforma: o.plataforma || '', programaFuente: o.programa || '', pestana,
    });
  }
  return { leads, descartadas, conEncabezado: !!enc };
}

export function deduplicar(leads) {
  const vistos = new Set(); const out = [];
  for (const l of leads) {
    const k = l.id ? `id:${l.id}` : `em:${l.email}|${Math.round(l.t / 1000)}`;
    if (vistos.has(k)) continue;
    vistos.add(k); out.push(l);
  }
  return out;
}
