#!/usr/bin/env node
// Motor del reporte: lee las bases de los proveedores, las coteja contra HubSpot y escribe
// el reporte cifrado que consume la página.
//
// Uso:
//   node src/motor.mjs --config config.json --out dist/data.enc.json
// Variables de entorno:
//   REPORT_CONFIG      JSON de configuración (si no se pasa --config)
//   HUBSPOT_TOKEN      clave de solo lectura de HubSpot (en GitHub Actions)
//   HUBSPOT_BASE_URL   opcional; p. ej. el proxy local de B&O (entonces no hace falta token)
//   GOOGLE_SA_JSON     JSON de la cuenta de servicio de Google (para leer los Sheets)
//   REPORT_PASSWORD    contraseña con la que se cifra el reporte
//   DISPATCH_URL / DISPATCH_KEY  opcionales, para el botón "Actualizar ahora"
import fs from 'node:fs';
import path from 'node:path';
import { HubSpot } from './hubspot.mjs';
import { leerFuente } from './fuentes.mjs';
import { tablaALeads, deduplicar } from './parse.mjs';
import { CatalogoProgramas, clasificar } from './reglas.mjs';
import { cifrar } from './cifrado.mjs';
import { enParalelo } from './util.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const REGLAS = { ventanaNegocioHoras: 48, toleranciaPreviaMin: 10, toleranciaNuevoMin: 5, desfaseMin: 60 };
const PROPS = { programaNegocio: 'n1_0_posgrado_de_interes__negocio_', programaContacto: 'posgrados_en_sitio_mexico_posgrados' };

function cargarConfig() {
  let texto = null, dirBase = process.cwd();
  if (args.config) { texto = fs.readFileSync(args.config, 'utf8'); dirBase = path.dirname(path.resolve(args.config)); }
  else if (process.env.REPORT_CONFIG) texto = process.env.REPORT_CONFIG;
  if (!texto) throw new Error('Falta la configuración: usa --config archivo.json o la variable REPORT_CONFIG.');
  const cfg = JSON.parse(texto);
  cfg.reglas = { ...REGLAS, ...(cfg.reglas || {}) };
  cfg.propiedades = { ...PROPS, ...(cfg.propiedades || {}) };
  cfg._dirBase = dirBase;
  return cfg;
}

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

async function main() {
  const cfg = cargarConfig();
  const salida = args.out || 'dist/data.enc.json';
  const contrasena = process.env.REPORT_PASSWORD || '';
  if (!args.plain && !contrasena) throw new Error('Falta REPORT_PASSWORD.');
  const credencialesGoogle = process.env.GOOGLE_SA_JSON ? JSON.parse(process.env.GOOGLE_SA_JSON) : null;
  const hs = new HubSpot({ baseUrl: process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com', token: process.env.HUBSPOT_TOKEN || '' });
  if (!process.env.HUBSPOT_TOKEN && !process.env.HUBSPOT_BASE_URL) throw new Error('Falta HUBSPOT_TOKEN.');
  const desde = cfg.desde ? Date.parse(cfg.desde + 'T00:00:00-06:00') : -Infinity;

  // 1) Bases de los proveedores
  const proveedores = []; let leads = [];
  for (const [p, prov] of (cfg.proveedores || []).entries()) {
    const info = { id: prov.id, nombre: prov.nombre, estado: 'sin_fuente', detalle: '', fuente: null, filas: 0, descartadas: 0, leads: 0 };
    proveedores.push({ ...prov, _info: info });
    if (!prov.fuente) { info.detalle = prov.nota || 'Aún no hay una base conectada para este proveedor.'; continue; }
    try {
      const r = await leerFuente(prov.fuente, { credencialesGoogle, dirBase: cfg._dirBase });
      let propios = [];
      for (const tabla of r.tablas) {
        const { leads: ls, descartadas } = tablaALeads(tabla.filas, { pestana: tabla.pestana, zonaSinOffset: prov.zonaSinOffset || '-06:00' });
        info.filas += tabla.filas.length; info.descartadas += descartadas;
        propios.push(...ls);
      }
      propios = deduplicar(propios).filter(l => l.t >= desde);
      propios.forEach(l => { l.p = p; });
      info.estado = 'ok'; info.leads = propios.length;
      info.fuente = { tipo: prov.fuente.tipo, titulo: r.titulo || '', pestanas: r.tablas.map(t => t.pestana) };
      leads.push(...propios);
      log(`${prov.nombre}: ${propios.length} leads de ${r.tablas.length} pestaña(s)/archivo(s); ${info.descartadas} filas sin correo o fecha.`);
    } catch (e) {
      info.estado = 'error'; info.detalle = e.message.slice(0, 300);
      log(`${prov.nombre}: ERROR ${info.detalle}`);
    }
  }

  // 2) Catálogos de HubSpot
  const [etapas, propietarios, etqNeg, etqCon] = await Promise.all([
    hs.etapas(), hs.propietarios(),
    hs.opciones('deals', cfg.propiedades.programaNegocio), hs.opciones('contacts', cfg.propiedades.programaContacto),
  ]);
  const catalogo = new CatalogoProgramas([...Object.values(etqNeg), ...Object.values(etqCon), ...(cfg.programasExtra || [])], cfg.aliasProgramas || {});

  // 3) Contactos por correo (principal y, si no aparece, secundario)
  const propsC = ['email', 'createdate', 'hubspot_owner_id', cfg.propiedades.programaContacto];
  const emails = [...new Set(leads.map(l => l.email))];
  const contactos = await hs.contactosPorEmail(emails, propsC);
  const faltantes = emails.filter(e => !contactos.has(e));
  const maxSec = cfg.maxBusquedasSecundarias ?? 200;
  await enParalelo(faltantes.slice(0, maxSec), 2, async e => {
    const c = await hs.contactoPorEmailSecundario(e, propsC).catch(() => null);
    if (c) contactos.set(e, c);
  });
  log(`HubSpot: ${contactos.size} de ${emails.length} correos únicos encontrados (${faltantes.length} buscados también como correo secundario).`);

  // 4) Negocios asociados
  const idsC = [...new Set([...contactos.values()].map(c => String(c.id)))];
  const asociaciones = await hs.negociosDeContactos(idsC);
  const idsD = [...new Set([...asociaciones.values()].flat())];
  const propsD = ['createdate', 'dealstage', 'pipeline', 'hubspot_owner_id', cfg.propiedades.programaNegocio];
  const negocios = await hs.negocios(idsD, propsD);
  log(`HubSpot: ${idsD.length} negocios asociados; ${hs.llamadas} llamadas a la API.`);

  // 5) Reglas
  clasificar({
    leads, proveedores, contactos, asociaciones, negocios, catalogo,
    etiquetaProgNegocio: etqNeg, etiquetaProgContacto: etqCon, props: cfg.propiedades, reglas: cfg.reglas,
  });

  // 6) Carga compacta para la página
  const dic = () => { const lista = []; const idx = new Map(); return { lista, i: v => { if (v == null || v === '') return -1; if (!idx.has(v)) { idx.set(v, lista.length); lista.push(v); } return idx.get(v); } }; };
  const dProg = dic(), dEtapa = dic(), dOwner = dic(), dForm = dic();
  const formularios = [];
  const iForm = l => {
    const k = `${l.formId}|${l.formNombre}`;
    const i = dForm.i(k);
    if (i === formularios.length) formularios.push({ id: l.formId, n: l.formNombre, c: l.campana });
    return i;
  };
  const filas = leads.sort((a, b) => a.t - b.t).map(l => {
    const o = { p: l.p, t: l.t, e: l.email, s: l.s, g: dProg.i(l.prog) };
    if (l.id) o.id = l.id;
    if (l.nombre) o.n = l.nombre;
    if (l.progFuente) o.gf = l.progFuente;
    if (l.formId || l.formNombre) o.f = iForm(l);
    if (l.plataforma) o.pl = l.plataforma;
    if (l.c) { o.c = l.c; o.ct = l.ct; o.cs = l.cs; o.dm = l.dm; }
    if (l.d) { o.d = l.d; o.dt = l.dt; o.dh = l.dh; o.et = dEtapa.i(etapas[l.etapa]?.etiqueta || l.etapa); }
    if (l.dprog) o.dp = dProg.i(l.dprog);
    if (l.otroProg) { o.op = dProg.i(l.otroProg); o.oi = l.otroId; }
    if (l.owner) o.o = dOwner.i(propietarios[l.owner] || l.owner);
    return o;
  });

  const carga = {
    v: 1,
    generadoEn: new Date().toISOString(),
    cliente: cfg.cliente || '', titulo: cfg.titulo || 'Leads de pauta vs HubSpot',
    portalId: String(cfg.portalId || ''), zona: cfg.zonaHoraria || 'America/Mexico_City',
    reglas: cfg.reglas,
    actualizar: process.env.DISPATCH_URL ? { url: process.env.DISPATCH_URL, clave: process.env.DISPATCH_KEY || '' } : null,
    proveedores: proveedores.map(p => p._info),
    programas: dProg.lista, etapas: dEtapa.lista, propietarios: dOwner.lista, formularios,
    leads: filas,
  };

  const resumen = {};
  for (const f of filas) resumen[f.s] = (resumen[f.s] || 0) + 1;
  log('Estatus:', JSON.stringify(resumen));

  fs.mkdirSync(path.dirname(path.resolve(salida)), { recursive: true });
  if (contrasena) {
    fs.writeFileSync(salida, JSON.stringify(cifrar(carga, contrasena, cfg.salCifrado || 'reporte-pauta-v1')));
    fs.writeFileSync(path.join(path.dirname(salida), 'meta.json'), JSON.stringify({ generadoEn: carga.generadoEn }));
    log(`Reporte cifrado: ${salida} (${Math.round(fs.statSync(salida).size / 1024)} KB)`);
  }
  if (args.plain) { fs.writeFileSync(args.plain, JSON.stringify(carga, null, 1)); log(`Copia SIN cifrar (solo uso local, contiene datos personales): ${args.plain}`); }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
