// Lectura de las bases de los proveedores.
//  - tipo "sheet": Google Sheet vivo, leído con una cuenta de servicio (solo lectura).
//  - tipo "meta": leads leídos directo de la Graph API de Meta (solo GET). Por página → formularios,
//    o por cuenta publicitaria → anuncios, según el acceso que haya. Devuelve una tabla por
//    formulario con el encabezado estándar del export de Meta, que parse.mjs ya reconoce.
//  - tipo "hubspot": los leads de Meta que la Sincronización de leads de HubSpot ya trae de las
//    páginas (envíos de formularios FACEBOOK_LEAD_AD). No necesita acceso a las páginas ni token
//    de Meta. La agencia se reconoce por el formulario (IDs y/o expresión sobre el nombre).
//  - tipo "archivos": carpeta local con exportaciones (.xls de Meta, .csv o .json). Solo para
//    corridas locales o de respaldo; en GitHub Actions todo debe venir de Sheets o de Meta.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pedir } from './http.mjs';
import { parseCSV, parseXMLSpreadsheet, normalizar, RE_EMAIL, enParalelo, trozos, parseFecha, limpiarEmail } from './util.mjs';

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

// ---------------------------------------------------------------------------------------------
// Meta (Graph API). Dos formas de autenticar:
//   - META_TOKENS (GitHub Actions): JSON {"usuario":"…","paginas":{"<idPagina>":"…"}}. Va como
//     Authorization: Bearer; nunca en la URL.
//   - META_BASE_URL (local): el mini-proxy de B&O (http://127.0.0.1:8788/<Cuenta>) pone el token;
//     aquí solo se manda la cabecera X-BNO-Clave con el tipo (usuario | pagina-<id>).
// Privacidad: esta función no escribe en consola. Los valores de los leads solo viajan en memoria.
const META_VERSION = 'v26.0';
const CAMPOS_LEAD = 'id,created_time,form_id,ad_id,ad_name,campaign_name,platform,is_organic,field_data';
const ENCABEZADO_META = ['id', 'created_time', 'form_id', 'form_name', 'campaign_name', 'ad_name', 'platform', 'email', 'full_name', 'programa'];

function clienteMeta({ tokens, version }) {
  const proxy = !!process.env.META_BASE_URL;
  const base = `${(process.env.META_BASE_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${version || META_VERSION}`;
  const tokenDe = tipo => (tipo === 'usuario' ? tokens?.usuario : tokens?.paginas?.[tipo.replace(/^pagina-/, '')]) || '';
  const tieneToken = tipo => proxy || !!tokenDe(tipo);
  const cabeceras = tipo => (proxy ? { 'x-bno-clave': tipo } : { authorization: `Bearer ${tokenDe(tipo)}` });
  async function get(ruta, params, tipo, etiqueta) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    return pedir(`${base}/${ruta}${q ? '?' + q : ''}`, { headers: cabeceras(tipo) }, { etiqueta: `Meta ${etiqueta || ruta.split('?')[0]}` });
  }
  // Recorre todas las páginas de un edge con cursores (no se sigue paging.next: trae el token en la URL).
  async function todo(ruta, params, tipo, etiqueta) {
    const out = []; let after = null;
    for (let n = 0; n < 500; n++) {
      const r = await get(ruta, { ...params, limit: 100, after: after || undefined }, tipo, etiqueta);
      out.push(...(r.data || []));
      after = r.paging?.next ? r.paging?.cursors?.after : null;
      if (!after) break;
    }
    return out;
  }
  return { proxy, tieneToken, get, todo };
}

// Saca correo, nombre y programa de field_data. El teléfono no se toma: el reporte no lo usa.
function camposLead(fieldData) {
  const o = {};
  for (const f of fieldData || []) {
    const k = normalizar(f.name);
    const v = (f.values || []).map(x => String(x ?? '').trim()).filter(Boolean).join(' / ');
    if (k && v && !(k in o)) o[k] = v;
  }
  const email = o.email || Object.entries(o).find(([k, v]) => /email|correo|mail/.test(k) && RE_EMAIL.test(v))?.[1] || '';
  const nombre = o['full name'] || [o['first name'] || o.firstname || o.nombre || o.nombres, o['last name'] || o.lastname || o.apellido || o.apellidos].filter(Boolean).join(' ');
  const programa = Object.entries(o).find(([k]) => /programa|posgrado|maestria|doctorado|especialidad|carrera|interes/.test(k)
    && !/email|correo|mail|telefono|phone|nombre|name|apellido/.test(k))?.[1] || '';
  return { email, nombre, programa };
}

function filaLead(l, formNombre) {
  const c = camposLead(l.field_data);
  return [l.id || '', l.created_time || '', l.form_id || '', formNombre || '', l.campaign_name || '', l.ad_name || '', l.platform || '', c.email, c.nombre, c.programa];
}

// Agrupa leads por formulario y arma una tabla por formulario (encabezado + filas).
function tablasPorFormulario(leads, nombres) {
  const porForm = new Map();
  for (const l of leads) {
    const k = String(l.form_id || '');
    if (!porForm.has(k)) porForm.set(k, []);
    porForm.get(k).push(l);
  }
  return [...porForm.entries()].map(([formId, ls]) => {
    const nombre = nombres.get(formId) || '';
    return { pestana: nombre ? `${nombre} (${formId})` : `form ${formId}`, filas: [ENCABEZADO_META, ...ls.map(l => filaLead(l, nombre))] };
  });
}

async function leerMeta(fuente, { tokens, desde } = {}) {
  const m = clienteMeta({ tokens, version: fuente.version });
  if (!m.proxy && !tokens) throw new Error('Meta: falta META_TOKENS (token de usuario y/o de página).');
  const inc = fuente.formularios?.incluir ? new RegExp(fuente.formularios.incluir, 'i') : null;
  const exc = fuente.formularios?.excluir ? new RegExp(fuente.formularios.excluir, 'i') : null;
  const pasa = nombre => (!inc || inc.test(nombre)) && (!exc || !exc.test(nombre));
  const filtro = Number.isFinite(desde) ? JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(desde / 1000) - 1 }]) : undefined;
  const nombres = new Map(); const notas = [];
  let leads = []; let ruta = '';

  // Ruta 1 — por formulario, con el token de cada página (la forma documentada por Meta).
  for (const pagina of fuente.paginas || []) {
    const tipo = `pagina-${pagina}`;
    if (!m.tieneToken(tipo)) { notas.push(`sin token de la página ${pagina}`); continue; }
    try {
      const formularios = await m.todo(`${pagina}/leadgen_forms`, { fields: 'id,name,status,leads_count' }, tipo, 'leadgen_forms');
      const elegidos = formularios.filter(f => pasa(f.name || ''));
      for (const f of elegidos) {
        nombres.set(String(f.id), f.name || '');
        leads.push(...await m.todo(`${f.id}/leads`, { fields: CAMPOS_LEAD, filtering: filtro }, tipo, 'leads por formulario'));
      }
      ruta = ruta || 'pagina';
    } catch (e) {
      notas.push(`página ${pagina}: ${e.message.slice(0, 160)}`);
    }
  }

  // Ruta 2 — por anuncio, con el token de usuario y la cuenta publicitaria de la agencia.
  if (ruta !== 'pagina') {
    for (const cuenta of fuente.cuentas || []) {
      if (!m.tieneToken('usuario')) { notas.push('sin token de usuario'); break; }
      const act = String(cuenta).startsWith('act_') ? cuenta : `act_${cuenta}`;
      try {
        const anuncios = await m.todo(`${act}/ads`, { fields: 'id,name,effective_status' }, 'usuario', 'ads');
        for (const a of anuncios) {
          leads.push(...await m.todo(`${a.id}/leads`, { fields: CAMPOS_LEAD, filtering: filtro }, 'usuario', 'leads por anuncio'));
        }
        ruta = 'anuncio';
      } catch (e) {
        notas.push(`cuenta ${act}: ${e.message.slice(0, 160)}`);
      }
    }
    // Nombre de cada formulario (si el token alcanza); si no, se queda el ID y parse.mjs usa la campaña.
    for (const formId of new Set(leads.map(l => String(l.form_id || '')).filter(Boolean))) {
      try { const f = await m.get(formId, { fields: 'id,name' }, 'usuario', 'leadgen_form'); nombres.set(formId, f.name || ''); }
      catch { nombres.set(formId, ''); }
    }
    if (inc || exc) leads = leads.filter(l => pasa(nombres.get(String(l.form_id || '')) || ''));
  }

  if (!ruta) throw new Error(`Meta: falta acceso${notas.length ? ' — ' + notas.join('; ') : ''}`);
  const tablas = tablasPorFormulario(leads, nombres);
  const titulo = `Meta · ${ruta === 'pagina' ? `página(s) ${(fuente.paginas || []).join(', ')}` : `cuenta(s) ${(fuente.cuentas || []).join(', ')}`}`;
  return { titulo, tablas, notas, ruta };
}

// Leads de varias páginas de Meta, cada una con su token de página, para la conciliación Meta ↔ HubSpot.
// Una página sin token sale como "sin_acceso" (no tumba la corrida). Solo se piden los formularios que
// tienen leads recientes (leads_count > 0) o que se crearon dentro de la ventana; Meta guarda ~90 días.
// Privacidad: no escribe en consola; correo y nombre solo viajan en memoria y en el reporte cifrado.
export async function leerPaginasMeta({ tokens, paginas = [], desde, version, avance = () => {} } = {}) {
  const m = clienteMeta({ tokens, version });
  const filtro = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(desde / 1000) - 1 }]);
  const salida = [];
  for (const pg of paginas) {
    const id = String(pg.id ?? pg);
    const r = { id, nombre: pg.nombre || '', estado: 'ok', detalle: '', formularios: [], leads: [] };
    salida.push(r);
    const tipo = `pagina-${id}`;
    if (!m.tieneToken(tipo)) { r.estado = 'sin_acceso'; r.detalle = 'Acceso pendiente a la página.'; continue; }
    try {
      if (!r.nombre) r.nombre = (await m.get(id, { fields: 'name' }, tipo, 'página')).name || id;
      const forms = await m.todo(`${id}/leadgen_forms`, { fields: 'id,name,leads_count,created_time' }, tipo, 'leadgen_forms');
      r.formularios = forms.map(f => ({ id: String(f.id), n: f.name || '' }));
      const conLeads = forms.filter(f => !(Number(f.leads_count) === 0) || parseFecha(f.created_time) >= desde);
      avance(`${r.nombre}: ${forms.length} formularios, ${conLeads.length} con leads recientes`);
      await enParalelo(conLeads, 3, async f => {
        const ls = await m.todo(`${f.id}/leads`, { fields: 'id,created_time,field_data', filtering: filtro }, tipo, 'leads por formulario');
        for (const l of ls) {
          const t = parseFecha(l.created_time);
          if (!(t >= desde)) continue;
          const c = camposLead(l.field_data);
          r.leads.push({ id: String(l.id || ''), t, formId: String(f.id), formNombre: f.name || '', email: limpiarEmail(c.email), nombre: c.nombre });
        }
      });
      avance(`${r.nombre}: ${r.leads.length} leads leídos`);
    } catch (e) {
      r.estado = 'error'; r.detalle = e.message.replace(/EAA[0-9A-Za-z]+/g, '[token]').slice(0, 200);
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------------------------
// HubSpot como fuente de los leads de Meta (tipo "hubspot").
// HubSpot ya está conectado a las páginas por la Sincronización de leads: cada lead de Meta entra
// como un envío de un formulario de tipo FACEBOOK_LEAD_AD (nombre = nombre del formulario en Meta).
// Se escanea una sola vez por corrida y cada proveedor se queda con sus formularios:
//   "formularios": { "ids": ["<guid HubSpot>", …], "incluir": "regex", "excluir": "regex" }
//   "resto": true → se queda con los formularios de Meta que ningún otro proveedor reclamó.
// Privacidad: aquí no se escribe nada en consola salvo conteos.
const TIPO_FORM_META = 'FACEBOOK_LEAD_AD';
const escaneos = new Map();

async function buscarContactosConConversion(hs, desde, hasta) {
  // La búsqueda de HubSpot no pasa de 10,000 resultados por consulta: se parte la ventana si hace falta.
  const props = ['email'];
  const filtro = (a, b) => ({ filterGroups: [{ filters: [
    { propertyName: 'recent_conversion_date', operator: 'GTE', value: String(a) },
    { propertyName: 'recent_conversion_date', operator: 'LT', value: String(b) },
  ] }], properties: props, limit: 200, sorts: [{ propertyName: 'recent_conversion_date', direction: 'ASCENDING' }] });
  const ids = new Set();
  const ventanas = [[desde, hasta]];
  while (ventanas.length) {
    const [a, b] = ventanas.shift();
    const primera = await hs.api('/crm/v3/objects/contacts/search', { method: 'POST', body: filtro(a, b) });
    if ((primera.total || 0) > 9800 && b - a > 3600e3) { const m = Math.floor((a + b) / 2); ventanas.unshift([a, m], [m, b]); continue; }
    for (const c of primera.results || []) ids.add(String(c.id));
    let after = primera.paging?.next?.after;
    while (after) {
      const r = await hs.api('/crm/v3/objects/contacts/search', { method: 'POST', body: { ...filtro(a, b), after } });
      for (const c of r.results || []) ids.add(String(c.id));
      after = r.paging?.next?.after;
    }
  }
  return [...ids];
}

export async function escanearLeadsMeta(hs, desde) {
  const clave = String(desde);
  if (escaneos.has(clave)) return escaneos.get(clave);
  const promesa = (async () => {
    const inicio = Number.isFinite(desde) ? desde : Date.parse('2024-01-01T00:00:00Z');
    const ids = await buscarContactosConConversion(hs, inicio, Date.now() + 3600e3);
    const envios = []; const vistos = new Set();
    await enParalelo(trozos(ids, 100), 3, async lote => {
      const qs = lote.map(id => `vid=${id}`).join('&');
      const r = await hs.api(`/contacts/v1/contact/vids/batch/?${qs}&formSubmissionMode=all&propertyMode=value_only&showListMemberships=false&property=email&property=firstname&property=lastname`);
      for (const [vid, c] of Object.entries(r || {})) {
        const p = c.properties || {};
        const email = String(p.email?.value || '').trim().toLowerCase();
        const nombre = [p.firstname?.value, p.lastname?.value].filter(Boolean).join(' ');
        for (const f of c['form-submissions'] || []) {
          if (f['form-type'] !== TIPO_FORM_META || !(f.timestamp >= inicio)) continue;
          const k = `${vid}|${f['form-id']}|${f.timestamp}`;
          if (vistos.has(k)) continue;
          vistos.add(k);
          envios.push({ id: f['conversion-id'] || k, t: f.timestamp, formId: String(f['form-id'] || ''), formNombre: String(f.title || ''), email, nombre });
        }
      }
    });
    return { contactos: ids.length, envios };
  })();
  escaneos.set(clave, promesa);
  return promesa;
}

// A qué proveedor pertenece cada formulario: primero por ID (gana siempre), luego por la expresión
// sobre el nombre, en el orden de la configuración; lo que nadie reclama va al proveedor "resto".
export function asignadorDeFormularios(proveedores) {
  const conHubspot = proveedores.filter(p => p.fuente?.tipo === 'hubspot');
  const porId = new Map();
  for (const p of conHubspot) for (const id of p.fuente.formularios?.ids || []) if (!porId.has(String(id))) porId.set(String(id), p.id);
  const porNombre = conHubspot.filter(p => !p.fuente.resto && p.fuente.formularios?.incluir).map(p => ({
    id: p.id, inc: new RegExp(p.fuente.formularios.incluir, 'i'), exc: p.fuente.formularios.excluir ? new RegExp(p.fuente.formularios.excluir, 'i') : null,
  }));
  const resto = conHubspot.find(p => p.fuente.resto)?.id || null;
  const cache = new Map();
  return (formId, formNombre) => {
    const k = `${formId}|${formNombre}`;
    if (cache.has(k)) return cache.get(k);
    let duenio = porId.get(String(formId)) || null;
    if (!duenio) duenio = porNombre.find(r => r.inc.test(formNombre) && !(r.exc && r.exc.test(formNombre)))?.id || resto;
    cache.set(k, duenio);
    return duenio;
  };
}

async function leerHubspot(fuente, { hs, desde, proveedores = [], idProveedor } = {}) {
  if (!hs) throw new Error('HubSpot: falta el cliente (HUBSPOT_TOKEN o HUBSPOT_BASE_URL).');
  const { contactos, envios } = await escanearLeadsMeta(hs, desde);
  const lista = proveedores.length ? proveedores : [{ id: idProveedor || '_', fuente }];
  const duenio = asignadorDeFormularios(lista);
  const yo = idProveedor || lista.find(p => p.fuente === fuente)?.id;
  const propios = envios.filter(e => duenio(e.formId, e.formNombre) === yo);
  const porForm = new Map();
  for (const e of propios) {
    if (!porForm.has(e.formId)) porForm.set(e.formId, { nombre: e.formNombre, filas: [] });
    porForm.get(e.formId).filas.push([e.id, new Date(e.t).toISOString(), e.formId, e.formNombre, '', '', '', e.email, e.nombre, '']);
  }
  const tablas = [...porForm.entries()].map(([formId, x]) => ({ pestana: `${x.nombre} (${formId})`, filas: [ENCABEZADO_META, ...x.filas] }));
  return { titulo: `HubSpot · Sincronización de leads de Meta (${contactos} contactos revisados)`, tablas, notas: [] };
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

export async function leerFuente(fuente, { credencialesGoogle, tokensMeta, desde, dirBase = process.cwd(), hs, proveedores, idProveedor } = {}) {
  if (!fuente) return null;
  if (fuente.tipo === 'sheet') return leerSheet(fuente, credencialesGoogle);
  if (fuente.tipo === 'hubspot') return leerHubspot(fuente, { hs, desde, proveedores, idProveedor });
  if (fuente.tipo === 'meta') return leerMeta(fuente, { tokens: tokensMeta, desde });
  if (fuente.tipo === 'archivos') return leerArchivos(fuente, dirBase);
  throw new Error(`Tipo de fuente desconocido: ${fuente.tipo}`);
}
