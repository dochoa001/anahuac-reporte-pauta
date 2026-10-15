// Conciliación Meta ↔ HubSpot: ¿cada lead que entró por un formulario de Meta llegó a HubSpot?
//
// Entrada:
//  - paginas: lo que regresa leerPaginasMeta() → [{ id, nombre, estado, detalle, formularios:[{id,n}], leads:[{id,t,formId,formNombre,email,nombre}] }]
//  - envios:  los envíos FACEBOOK_LEAD_AD que la Sincronización de leads dejó en HubSpot → [{ id, t, formId, formNombre, email, nombre }]
//  - desde / hasta: ventana que se compara (ms). Meta solo guarda ~90 días de leads.
//  - duenio(formIdHubSpot, nombre): a qué proveedor pertenece cada formulario (el mismo asignador del reporte).
//
// Cruce, uno a uno:
//  1) mismo formulario (por nombre) + mismo correo, el envío más cercano en tiempo (≤ 24 h);
//  2) lo que quede: mismo formulario y misma hora (≤ 5 min), por si el contacto quedó con otro correo principal.
// Solo se cuentan los leads de Meta dentro de la ventana; del lado de HubSpot se busca con 24 h de holgura
// en las orillas para no marcar como faltante un lead que cayó justo en el corte.
import { normalizar } from './util.mjs';

const H24 = 24 * 3600e3;
const M5 = 5 * 60e3;

export function conciliar({ paginas = [], envios = [], desde, hasta, duenio = () => null, zona = 'America/Mexico_City', maxFaltantes = 2000 }) {
  const k = s => normalizar(s);
  const fDia = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dia = t => fDia.format(t);

  // Formularios de las páginas conectadas: nombre normalizado → índice de página.
  const pagDeForm = new Map();
  paginas.forEach((p, ip) => {
    if (p.estado !== 'ok') return;
    for (const f of p.formularios || []) if (!pagDeForm.has(k(f.n))) pagDeForm.set(k(f.n), ip);
  });

  // HubSpot: envíos de esos formularios, con holgura en las orillas.
  const hs = envios.filter(e => pagDeForm.has(k(e.formNombre)) && e.t >= desde - H24 && e.t < hasta + H24);
  const libre = new Uint8Array(hs.length).fill(1);
  const porCorreo = new Map(), porForm = new Map();
  hs.forEach((e, i) => {
    const kf = k(e.formNombre);
    const kc = `${kf}|${e.email}`;
    if (e.email) { if (!porCorreo.has(kc)) porCorreo.set(kc, []); porCorreo.get(kc).push(i); }
    if (!porForm.has(kf)) porForm.set(kf, []); porForm.get(kf).push(i);
  });
  // Formulario de HubSpot que corresponde a cada nombre (para saber la agencia por ID).
  const hsFormId = new Map();
  for (const e of envios) if (!hsFormId.has(k(e.formNombre))) hsFormId.set(k(e.formNombre), e.formId);

  // Meta: leads dentro de la ventana.
  const meta = [];
  paginas.forEach((p, ip) => { if (p.estado === 'ok') for (const l of p.leads || []) if (l.t >= desde && l.t < hasta) meta.push({ ...l, ip }); });
  meta.sort((a, b) => a.t - b.t);
  const par = new Int32Array(meta.length).fill(-1);
  const elegir = (cands, t, tope) => {
    let mejor = -1, dist = Infinity;
    for (const i of cands || []) if (libre[i]) { const d = Math.abs(hs[i].t - t); if (d <= tope && d < dist) { dist = d; mejor = i; } }
    return mejor;
  };
  meta.forEach((l, j) => {
    if (!l.email) return;
    const i = elegir(porCorreo.get(`${k(l.formNombre)}|${l.email}`), l.t, H24);
    if (i >= 0) { par[j] = i; libre[i] = 0; }
  });
  meta.forEach((l, j) => {
    if (par[j] >= 0) return;
    const i = elegir(porForm.get(k(l.formNombre)), l.t, M5);
    if (i >= 0) { par[j] = i; libre[i] = 0; }
  });

  // Agregados por página, por formulario y por día.
  const vacio = () => ({ meta: 0, coinciden: 0, faltan: 0, soloHs: 0 });
  const resPag = paginas.map(p => ({ id: p.id, nombre: p.nombre, estado: p.estado, detalle: p.detalle || '', formularios: (p.formularios || []).length, ...vacio() }));
  const resForm = new Map();
  const formDe = (ip, nombre) => {
    const kk = `${ip}|${k(nombre)}`;
    if (!resForm.has(kk)) resForm.set(kk, { pg: ip, n: nombre, prov: duenio(hsFormId.get(k(nombre)) || '', nombre) || null, ...vacio() });
    return resForm.get(kk);
  };
  const dias = {};
  const faltantes = [];
  meta.forEach((l, j) => {
    const ok = par[j] >= 0;
    const rp = resPag[l.ip], rf = formDe(l.ip, l.formNombre);
    const d = dia(l.t); const rd = dias[d] || (dias[d] = [0, 0]);
    rp.meta++; rf.meta++; rd[0]++;
    if (ok) { rp.coinciden++; rf.coinciden++; rd[1]++; }
    else {
      rp.faltan++; rf.faltan++;
      if (faltantes.length < maxFaltantes) faltantes.push({ pg: l.ip, t: l.t, e: l.email || '', n: l.nombre || '', f: l.formNombre || '' });
    }
  });
  hs.forEach((e, i) => {
    if (!libre[i] || e.t < desde || e.t >= hasta) return;
    const ip = pagDeForm.get(k(e.formNombre));
    resPag[ip].soloHs++; formDe(ip, e.formNombre).soloHs++;
  });

  const total = resPag.reduce((a, p) => ({ meta: a.meta + p.meta, coinciden: a.coinciden + p.coinciden, faltan: a.faltan + p.faltan, soloHs: a.soloHs + p.soloHs }), vacio());
  return {
    desde, hasta,
    total,
    paginas: resPag,
    formularios: [...resForm.values()].sort((a, b) => a.pg - b.pg || b.meta - a.meta || a.n.localeCompare(b.n)),
    dias,
    faltantes: faltantes.sort((a, b) => b.t - a.t),
    faltantesRecortados: total.faltan > faltantes.length,
  };
}
