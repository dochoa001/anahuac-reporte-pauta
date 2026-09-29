// Reglas del cotejo: programa de cada lead, estado del contacto y del negocio.
//
// Estatus del lead (uno por lead):
//   completo      → hay negocio del mismo programa creado dentro de la ventana (por defecto ≤ 48 h)
//   tardio        → el negocio del programa existe, pero se creó después de la ventana
//   previo        → el contacto ya tenía un negocio de ese programa antes del lead; no se creó otro
//   sin_negocio   → el contacto existe y no tiene ningún negocio de ese programa
//   sin_contacto  → el correo no existe en HubSpot
// Bandera aparte: contacto "desfasado" = creado en HubSpot más de N minutos después del lead.
import { normalizar } from './util.mjs';

export class CatalogoProgramas {
  constructor(etiquetas, alias = {}) {
    this.porNorm = new Map();
    for (const e of etiquetas) if (e) { const n = normalizar(e); if (!this.porNorm.has(n)) this.porNorm.set(n, e); }
    this.alias = new Map(Object.entries(alias).map(([k, v]) => [normalizar(k), v]));
    this.lista = [...this.porNorm.entries()].sort((a, b) => b[0].length - a[0].length);
  }
  resolver(texto) {
    const n = normalizar(texto);
    if (!n || n.length < 6) return null;
    if (this.alias.has(n)) return this.alias.get(n);
    if (this.porNorm.has(n)) return this.porNorm.get(n);
    // Coincidencia por contención (p. ej. "DII. Doctorado en Ingeniería Industrial | NODS").
    for (const [k, v] of this.lista) if (k.length >= 14 && (n.includes(k) || (n.length >= 14 && k.includes(n)))) return v;
    return null;
  }
  // Intenta con cada segmento del nombre de un formulario o campaña.
  desdeNombre(nombre) {
    if (!nombre) return null;
    const directo = this.resolver(nombre);
    if (directo) return directo;
    for (const seg of String(nombre).split(/[|\-–·_]+|\.\s/)) { const r = this.resolver(seg); if (r) return r; }
    return null;
  }
}

export function clasificar({ leads, proveedores, contactos, asociaciones, negocios, catalogo, etiquetaProgNegocio, etiquetaProgContacto, props, reglas }) {
  const ventana = reglas.ventanaNegocioHoras * 3600e3;
  const tolPrev = reglas.toleranciaPreviaMin * 60e3;
  const H = 3600e3;

  // Negocios por contacto, con programa normalizado.
  const negociosDe = cid => (asociaciones.get(cid) || []).map(id => negocios.get(id)).filter(Boolean).map(d => {
    const bruto = d.properties?.[props.programaNegocio];
    const prog = etiquetaProgNegocio[bruto] || bruto || '';
    return { id: String(d.id), t: Date.parse(d.properties?.createdate), prog, progN: normalizar(prog), etapa: d.properties?.dealstage || '', owner: d.properties?.hubspot_owner_id || '' };
  }).sort((a, b) => a.t - b.t);

  // 1) Estado del contacto y programa de la base / del formulario.
  for (const l of leads) {
    const prov = proveedores[l.p];
    const c = contactos.get(l.email) || null;
    l.c = c ? String(c.id) : null;
    if (c) {
      l.ct = Date.parse(c.properties?.createdate);
      const dm = (l.ct - l.t) / 60e3;
      l.dm = Math.round(dm);
      l.cs = dm > reglas.desfaseMin ? 'desfasado' : dm < -reglas.toleranciaNuevoMin ? 'existente' : 'nuevo';
      const bruto = c.properties?.[props.programaContacto];
      l._progContacto = catalogo.resolver(etiquetaProgContacto[bruto] || bruto || '');
      l._ownerContacto = c.properties?.hubspot_owner_id || '';
    }
    let prog = null, fuente = null;
    if (l.programaFuente) { prog = catalogo.resolver(l.programaFuente); if (prog) fuente = 'base'; }
    if (!prog && prov.programaPorFormulario?.[l.formId]) { prog = prov.programaPorFormulario[l.formId]; fuente = 'formulario'; }
    if (!prog && prov.programaPorPestana?.[l.pestana]) { prog = prov.programaPorPestana[l.pestana]; fuente = 'pestana'; }
    if (!prog) { prog = catalogo.desdeNombre(l.formNombre) || catalogo.desdeNombre(l.campana); if (prog) fuente = 'formulario'; }
    l.prog = prog; l.progFuente = fuente;
  }

  // 2) Programa inferido por formulario: el programa que HubSpot les puso a los contactos
  //    que ese mismo formulario creó (mayoría).
  const votos = new Map();
  for (const l of leads) if (!l.prog && l.cs === 'nuevo' && l._progContacto && l.formId) {
    const k = `${l.p}|${l.formId}`; const m = votos.get(k) || new Map();
    m.set(l._progContacto, (m.get(l._progContacto) || 0) + 1); votos.set(k, m);
  }
  const inferido = new Map();
  for (const [k, m] of votos) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [prog, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / total >= 0.6) inferido.set(k, prog);
  }
  for (const l of leads) {
    if (!l.prog && inferido.has(`${l.p}|${l.formId}`)) { l.prog = inferido.get(`${l.p}|${l.formId}`); l.progFuente = 'inferido'; }
    if (!l.prog && l.cs === 'nuevo' && l._progContacto) { l.prog = l._progContacto; l.progFuente = 'contacto'; }
  }

  // 3) Estatus del negocio.
  for (const l of leads) {
    if (!l.c) { l.s = 'sin_contacto'; continue; }
    const todos = negociosDe(l.c);
    const progN = l.prog ? normalizar(l.prog) : null;
    const mismos = progN ? todos.filter(d => d.progN === progN) : todos;
    const lo = l.t - tolPrev, hi = l.t + ventana;
    const aTiempo = mismos.find(d => d.t >= lo && d.t <= hi);
    const tarde = mismos.find(d => d.t > hi);
    const antes = mismos.filter(d => d.t < lo).pop();
    const elegido = aTiempo || tarde || antes || null;
    l.s = aTiempo ? 'completo' : tarde ? 'tardio' : antes ? 'previo' : 'sin_negocio';
    if (elegido) {
      l.d = elegido.id; l.dt = elegido.t; l.dh = Math.round(((elegido.t - l.t) / H) * 10) / 10; l.etapa = elegido.etapa;
      if (!progN) l.dprog = elegido.prog;
    }
    if (l.s === 'sin_negocio' || l.s === 'previo') {
      const otro = todos.find(d => d.t >= lo && d.t <= hi && d.progN !== progN);
      if (otro) { l.otroProg = otro.prog; l.otroId = otro.id; }
    }
    l.owner = (elegido && elegido.owner) || l._ownerContacto || '';
  }
  return leads;
}
