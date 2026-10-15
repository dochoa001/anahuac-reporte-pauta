// Cliente HTTP mínimo con reintentos. Usa http/https nativos (sin dependencias) para que
// funcione igual contra la API pública y contra el proxy local de B&O.
import http from 'node:http';
import https from 'node:https';
import { pausa } from './util.mjs';

function unaVez(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const datos = body == null ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const h = { accept: 'application/json', ...headers };
    if (datos != null) {
      if (!Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(datos);
    }
    // Tope total por llamada: además de mantener vivo el proceso, garantiza que la promesa siempre termine.
    let listo = false;
    const tope = setTimeout(() => { if (!listo) req.destroy(new Error('timeout total (120 s)')); }, 120000);
    const ok = v => { if (!listo) { listo = true; clearTimeout(tope); resolve(v); } };
    const mal = e => { if (!listo) { listo = true; clearTimeout(tope); reject(e); } };
    const req = lib.request(u, { method, headers: h, timeout: 60000 }, res => {
      const partes = [];
      res.on('data', c => partes.push(c));
      res.on('error', mal);
      res.on('aborted', () => mal(new Error('respuesta interrumpida')));
      res.on('close', () => { if (!res.complete) mal(new Error('conexión cerrada antes de terminar')); });
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = texto ? JSON.parse(texto) : null; } catch { /* no es JSON */ }
        ok({ status: res.statusCode, headers: res.headers, texto, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', mal);
    req.on('close', () => { if (!listo) setTimeout(() => mal(new Error('conexión cerrada sin respuesta')), 1000); });
    if (datos != null) req.write(datos);
    req.end();
  });
}

export async function pedir(url, opciones = {}, { intentos = 5, etiqueta = '' } = {}) {
  let espera = 1000;
  for (let n = 1; ; n++) {
    let r;
    try { r = await unaVez(url, opciones); }
    catch (e) { if (n >= intentos) throw new Error(`${etiqueta || url}: ${e.message}`); await pausa(espera); espera *= 2; continue; }
    if (r.status === 429 || r.status >= 500) {
      if (n >= intentos) throw new Error(`${etiqueta || url}: HTTP ${r.status} ${r.texto.slice(0, 300)}`);
      const ra = Number(r.headers['retry-after']);
      await pausa(Number.isFinite(ra) && ra > 0 ? ra * 1000 : espera); espera *= 2; continue;
    }
    if (r.status >= 400) {
      const err = new Error(`${etiqueta || url}: HTTP ${r.status} ${r.texto.slice(0, 400)}`);
      err.status = r.status; err.respuesta = r.json;
      throw err;
    }
    return r.json ?? r.texto;
  }
}
