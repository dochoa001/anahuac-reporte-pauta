// Lectura de las bases de los proveedores.
//  - tipo "sheet": Google Sheet vivo, leído con una cuenta de servicio (solo lectura).
//  - tipo "archivos": carpeta local con exportaciones (.xls de Meta, .csv o .json). Solo para
//    corridas locales o de respaldo; en GitHub Actions todo debe venir de Sheets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pedir } from './http.mjs';
import { parseCSV, parseXMLSpreadsheet } from './util.mjs';

let tokenGoogle = null;

async function tokenCuentaServicio(credenciales) {
  if (tokenGoogle && tokenGoogle.expira > Date.now() + 60000) return tokenGoogle.valor;
  const ahora = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const aud = credenciales.token_uri || 'https://oauth2.googleapis.com/token';
  const cabeza = b64({ alg: 'RS256', typ: 'JWT' });
  const cuerpo = b64({ iss: credenciales.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud, iat: ahora, exp: ahora + 3600 });
  const firma = crypto.createSign('RSA-SHA256').update(`${cabeza}.${cuerpo}`).sign(credenciales.private_key).toString('base64url');
  const r = await pedir(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cabeza}.${cuerpo}.${firma}` }).toString(),
  }, { etiqueta: 'Google token' });
  tokenGoogle = { valor: r.access_token, expira: Date.now() + (r.expires_in || 3600) * 1000 };
  return tokenGoogle.valor;
}

async function leerSheet(fuente, credenciales) {
  if (!credenciales) throw new Error('Falta GOOGLE_SA_JSON (cuenta de servicio de Google) para leer el Sheet.');
  const token = await tokenCuentaServicio(credenciales);
  const h = { authorization: `Bearer ${token}` };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fuente.id)}`;
  const meta = await pedir(`${base}?fields=properties.title,sheets.properties(title,hidden)`, { headers: h }, { etiqueta: 'Sheets metadata' });
  let pestanas = (meta.sheets || []).filter(s => !s.properties.hidden).map(s => s.properties.title);
  if (Array.isArray(fuente.pestanas) && fuente.pestanas.length) pestanas = pestanas.filter(t => fuente.pestanas.includes(t));
  if (Array.isArray(fuente.excluirPestanas)) pestanas = pestanas.filter(t => !fuente.excluirPestanas.includes(t));
  if (!pestanas.length) return { titulo: meta.properties?.title, tablas: [] };
  const qs = pestanas.map(t => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`).join('&');
  const r = await pedir(`${base}/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, { headers: h }, { etiqueta: 'Sheets values' });
  const tablas = (r.valueRanges || []).map((vr, i) => ({ pestana: pestanas[i], filas: (vr.values || []).map(f => f.map(v => String(v ?? ''))) }));
  return { titulo: meta.properties?.title, tablas };
}

function leerArchivos(fuente, dirBase) {
  const ruta = path.resolve(dirBase, fuente.ruta);
  const archivos = fs.statSync(ruta).isDirectory()
    ? fs.readdirSync(ruta).filter(f => /\.(xls|xml|csv|json)$/i.test(f)).map(f => path.join(ruta, f))
    : [ruta];
  const tablas = [];
  for (const f of archivos.sort()) {
    const texto = fs.readFileSync(f, 'utf8');
    const nombre = path.basename(f);
    if (/^\s*<\?xml|<Workbook/i.test(texto.slice(0, 500))) {
      for (const h of parseXMLSpreadsheet(texto)) tablas.push({ pestana: `${nombre} · ${h.nombre}`, filas: h.filas });
    } else if (/\.json$/i.test(f)) {
      const j = JSON.parse(texto);
      for (const [pestana, filas] of Object.entries(j)) tablas.push({ pestana, filas });
    } else {
      tablas.push({ pestana: nombre, filas: parseCSV(texto) });
    }
  }
  return { titulo: path.basename(ruta), tablas };
}

export async function leerFuente(fuente, { credencialesGoogle, dirBase = process.cwd() } = {}) {
  if (!fuente) return null;
  if (fuente.tipo === 'sheet') return leerSheet(fuente, credencialesGoogle);
  if (fuente.tipo === 'archivos') return leerArchivos(fuente, dirBase);
  throw new Error(`Tipo de fuente desconocido: ${fuente.tipo}`);
}
