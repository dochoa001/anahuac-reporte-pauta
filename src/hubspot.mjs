// Lectura de HubSpot (solo lectura). Con HUBSPOT_TOKEN habla con api.hubapi.com;
// con HUBSPOT_BASE_URL apuntando al proxy local de B&O no necesita token.
import { pedir } from './http.mjs';
import { enParalelo, trozos } from './util.mjs';

export class HubSpot {
  constructor({ baseUrl = 'https://api.hubapi.com', token = '' } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.llamadas = 0;
  }

  async api(path, { method = 'GET', body } = {}) {
    this.llamadas++;
    const headers = this.token ? { authorization: `Bearer ${this.token}` } : {};
    return pedir(this.base + path, { method, headers, body }, { etiqueta: `HubSpot ${method} ${path.split('?')[0]}` });
  }

  // Contactos por correo principal (lotes de 100).
  async contactosPorEmail(emails, propiedades) {
    const mapa = new Map();
    await enParalelo(trozos(emails, 100), 3, async lote => {
      const r = await this.api('/crm/v3/objects/contacts/batch/read', {
        method: 'POST',
        body: { idProperty: 'email', properties: propiedades, inputs: lote.map(id => ({ id })) },
      });
      for (const c of r.results || []) {
        const e = String(c.properties?.email || '').toLowerCase();
        if (e) mapa.set(e, c);
      }
    });
    return mapa;
  }

  // Segunda pasada para correos que no son el principal del contacto (hs_additional_emails).
  async contactoPorEmailSecundario(email, propiedades) {
    const r = await this.api('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'hs_additional_emails', operator: 'CONTAINS_TOKEN', value: email }] }],
        properties: propiedades, limit: 2,
      },
    });
    return (r.results || [])[0] || null;
  }

  // Asociaciones contacto → negocios (v4, lotes de 100).
  async negociosDeContactos(ids) {
    const mapa = new Map();
    await enParalelo(trozos(ids, 100), 3, async lote => {
      const r = await this.api('/crm/v4/associations/contacts/deals/batch/read', {
        method: 'POST', body: { inputs: lote.map(id => ({ id: String(id) })) },
      });
      for (const x of r.results || []) mapa.set(String(x.from.id), (x.to || []).map(t => String(t.toObjectId)));
    });
    return mapa;
  }

  async negocios(ids, propiedades) {
    const mapa = new Map();
    await enParalelo(trozos(ids, 100), 3, async lote => {
      const r = await this.api('/crm/v3/objects/deals/batch/read', {
        method: 'POST', body: { properties: propiedades, inputs: lote.map(id => ({ id: String(id) })) },
      });
      for (const d of r.results || []) mapa.set(String(d.id), d);
    });
    return mapa;
  }

  async etapas() {
    const r = await this.api('/crm/v3/pipelines/deals');
    const mapa = {};
    for (const p of r.results || []) for (const s of p.stages || []) mapa[s.id] = { etiqueta: s.label, pipeline: p.label, cerrada: s.metadata?.isClosed === 'true' };
    return mapa;
  }

  async propietarios() {
    const mapa = {};
    for (const archivados of [false, true]) {
      let after;
      do {
        const r = await this.api(`/crm/v3/owners?limit=500&archived=${archivados}${after ? `&after=${after}` : ''}`);
        for (const o of r.results || []) mapa[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || String(o.id);
        after = r.paging?.next?.after;
      } while (after);
    }
    return mapa;
  }

  // Opciones de una propiedad de enumeración: valor interno → etiqueta.
  async opciones(objeto, propiedad) {
    try {
      const r = await this.api(`/crm/v3/properties/${objeto}/${propiedad}`);
      const mapa = {};
      for (const o of r.options || []) mapa[o.value] = o.label;
      return mapa;
    } catch (e) {
      if (e.status === 404) return {};
      throw e;
    }
  }
}
