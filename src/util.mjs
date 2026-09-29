// Utilidades compartidas: texto, fechas, CSV/XML y concurrencia.

export function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

export const RE_EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;

export function limpiarEmail(s) {
  const e = String(s ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  return RE_EMAIL.test(e) ? e : '';
}

// Quita los prefijos que Meta pone a sus IDs en las exportaciones (l:, f:, c:, ag:, as:, p:).
export function sinPrefijo(s) {
  return String(s ?? '').trim().replace(/^(l|f|c|ag|as|p):/i, '');
}

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

// Convierte una fecha de la base del proveedor a milisegundos UTC.
// Si la fecha no trae zona horaria, se interpreta con `zonaSinOffset` (p. ej. "-06:00", CDMX).
export function parseFecha(valor, zonaSinOffset = '-06:00') {
  const s = String(valor ?? '').trim();
  if (!s) return NaN;
  const m = s.match(RE_ISO);
  if (m) {
    const [, Y, M, D, h, mi, se = '00', z] = m;
    let zona = z ? z.toUpperCase() : zonaSinOffset;
    if (zona !== 'Z' && !zona.includes(':')) zona = zona.slice(0, 3) + ':' + zona.slice(3);
    return Date.parse(`${Y}-${M}-${D}T${h}:${mi}:${se}${zona}`);
  }
  // Formato de Excel en español/inglés: d/m/aaaa h:mm (se asume día primero si el primer número > 12)
  const x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?)?$/i);
  if (x) {
    let [, a, b, y, h = '0', mi = '0', se = '0', ampm] = x;
    let d = +a, mo = +b;
    if (+a <= 12 && +b > 12) { d = +b; mo = +a; }
    let yy = +y; if (yy < 100) yy += 2000;
    let hh = +h;
    if (ampm) { const pm = /^p/i.test(ampm); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
    const pad = n => String(n).padStart(2, '0');
    return Date.parse(`${yy}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mi)}:${pad(se)}${zonaSinOffset}`);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

// CSV (RFC 4180) → matriz de textos.
export function parseCSV(texto) {
  const filas = []; let fila = []; let campo = ''; let enComillas = false;
  const t = String(texto).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (enComillas) {
      if (ch === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodificarEntidades(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}

// "Excel 2003 XML" (el .xls que exporta el administrador de anuncios de Meta) → matriz por hoja.
export function parseXMLSpreadsheet(texto) {
  const hojas = [];
  const reHoja = /<(?:ss:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Worksheet>/g;
  let mh;
  while ((mh = reHoja.exec(texto))) {
    const nombre = (mh[1].match(/ss:Name="([^"]*)"/) || [])[1] || `Hoja${hojas.length + 1}`;
    const filas = [];
    for (const mr of mh[2].matchAll(/<(?:ss:)?Row\b[^>]*>([\s\S]*?)<\/(?:ss:)?Row>/g)) {
      const fila = []; let col = 0;
      for (const mc of mr[1].matchAll(/<(?:ss:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/g)) {
        const idx = (mc[1].match(/ss:Index="(\d+)"/) || [])[1];
        if (idx) col = +idx - 1;
        const dato = mc[2] ? (mc[2].match(/<(?:ss:)?Data\b[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/) || [])[1] : '';
        fila[col] = decodificarEntidades(String(dato ?? '').replace(/<[^>]+>/g, '')).trim();
        col++;
      }
      for (let i = 0; i < fila.length; i++) if (fila[i] === undefined) fila[i] = '';
      filas.push(fila);
    }
    hojas.push({ nombre, filas });
  }
  return hojas;
}

export async function enParalelo(items, limite, fn) {
  const res = new Array(items.length); let i = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  });
  await Promise.all(trabajadores);
  return res;
}

export const pausa = ms => new Promise(r => setTimeout(r, ms));

export function trozos(arr, n) {
  const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out;
}
