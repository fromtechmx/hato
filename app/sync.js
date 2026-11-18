// HATO · sincronización. Enviar pendientes (idempotente) y traer lo nuevo.
// Cada registro nace en el dispositivo con su propio UUID: reenviarlo nunca lo duplica.

import { textoError } from './lib.js';

const OVERLAP_MS = 10 * 60 * 1000; // se vuelve a pedir lo de los últimos 10 min por si algo se confirmó tarde

export function createSync({ store, api, pagina = 1000 }) {
  let running = null;

  const esFatal = (e) => e.network || e.auth || e.status === 401 || e.status >= 500;

  async function remapAnimal(viejoId, servidor) {
    const evs = (await store.all('eventos')).filter((e) => e.animal_id === viejoId);
    for (const e of evs) await store.put('eventos', { ...e, animal_id: servidor.id });
    await store.del('animales', viejoId);
    await store.put('animales', { ...servidor, _sync: 'ok', _error: null });
  }

  async function marcarError(tabla, obj, e) {
    await store.put(tabla, { ...obj, _sync: 'error', _error: textoError(e) });
  }

  async function enviarAnimales(res) {
    const lista = (await store.all('animales')).filter((a) => a._sync === 'pendiente');
    for (const a of lista) {
      const body = { id: a.id, rancho_id: a.rancho_id, arete: a.arete, nombre: a.nombre ?? null, fecha_nacimiento: a.fecha_nacimiento ?? null, dispositivo_ts: a.dispositivo_ts ?? null };
      try {
        await api.rest('POST', '/animales?on_conflict=id', body, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
        await store.put('animales', { ...a, _sync: 'ok', _error: null });
        res.enviados++;
      } catch (e) {
        if (esFatal(e)) throw e;
        if (e.status === 409 && e.code === '23505') {
          // Ya existe una vaca con ese arete en el rancho (otro dispositivo la creó): se une a la existente.
          const q = `/animales?rancho_id=eq.${encodeURIComponent(a.rancho_id)}&arete=eq.${encodeURIComponent(a.arete)}&select=*`;
          const found = await api.rest('GET', q);
          if (Array.isArray(found) && found[0]) { await remapAnimal(a.id, found[0]); res.unidas++; continue; }
        }
        await marcarError('animales', a, e);
        res.rechazados++;
      }
    }
  }

  async function enviarEventos(res) {
    const animales = new Map((await store.all('animales')).map((a) => [a.id, a]));
    const todos = await store.all('eventos');
    const porId = new Map(todos.map((e) => [e.id, e]));
    const lista = todos
      .filter((e) => e._sync === 'pendiente')
      // Las anulaciones van después de los eventos (pueden apuntar a uno pendiente); luego por hora del dispositivo.
      .sort((a, b) => (a.anula_a ? 1 : 0) - (b.anula_a ? 1 : 0) || String(a.dispositivo_ts || '').localeCompare(String(b.dispositivo_ts || '')) || a.id.localeCompare(b.id));
    for (const e of lista) {
      const an = animales.get(e.animal_id);
      if (!an || an._sync !== 'ok') continue; // espera a que su vaca llegue al servidor
      if (e.anula_a) {
        const t = porId.get(e.anula_a);
        if (t && t._sync !== 'ok') continue; // espera al registro que anula
      }
      const body = { id: e.id, rancho_id: e.rancho_id, animal_id: e.animal_id, tipo: e.tipo, fecha: e.fecha, datos: e.datos || {}, canal: 'app', anula_a: e.anula_a ?? null, dispositivo_ts: e.dispositivo_ts ?? null };
      try {
        await api.rest('POST', '/eventos?on_conflict=id', body, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
        const ok = { ...e, _sync: 'ok', _error: null };
        await store.put('eventos', ok);
        porId.set(e.id, ok);
        res.enviados++;
      } catch (err) {
        if (esFatal(err)) throw err;
        await marcarError('eventos', e, err);
        porId.set(e.id, { ...e, _sync: 'error' });
        res.rechazados++;
      }
    }
  }

  async function traerRanchos() {
    const q = '/membresias?select=rol,rancho:ranchos(id,nombre,socio:socios(nombre,cooperativa:cooperativas(nombre)))&activo=eq.true';
    const filas = await api.rest('GET', q);
    const ranchos = (filas || [])
      .filter((f) => f.rancho)
      .map((f) => ({ id: f.rancho.id, nombre: f.rancho.nombre, rol: f.rol, socio: f.rancho.socio?.nombre || '', cooperativa: f.rancho.socio?.cooperativa?.nombre || '' }));
    await store.setMeta('ranchos', ranchos);
    return ranchos;
  }

  async function traerAdmin() {
    try {
      const filas = await api.rest('GET', '/admins_cooperativa?select=cooperativa:cooperativas(id,nombre)');
      const admin = (filas || []).filter((f) => f.cooperativa).map((f) => ({ id: f.cooperativa.id, nombre: f.cooperativa.nombre }));
      await store.setMeta('admin', admin);
    } catch (e) {
      if (e.network || e.auth || e.status === 401) throw e; // otros errores: se conserva lo último que se supo
    }
  }

  async function traerTabla(tabla, ranchoId, res) {
    const claveCursor = `cursor:${tabla}:${ranchoId}`;
    const guardado = await store.getMeta(claveCursor);
    const desde = guardado ? new Date(new Date(guardado).getTime() - OVERLAP_MS).toISOString() : null;
    let maxVisto = guardado || null;
    let ultimo = null; // última fila de la página anterior: paginación por (recibido_en, id)
    for (let vueltas = 0; vueltas < 500; vueltas++) {
      let filtro = '';
      if (ultimo) filtro = `&or=${encodeURIComponent(`(recibido_en.gt."${ultimo.ts}",and(recibido_en.eq."${ultimo.ts}",id.gt."${ultimo.id}"))`)}`;
      else if (desde) filtro = `&recibido_en=gte.${encodeURIComponent(desde)}`;
      const q = `/${tabla}?rancho_id=eq.${encodeURIComponent(ranchoId)}&order=recibido_en.asc,id.asc&limit=${pagina}&select=*${filtro}`;
      const filas = await api.rest('GET', q);
      if (!Array.isArray(filas) || !filas.length) break;
      const locales = new Map((await store.all(tabla)).map((o) => [o.id, o]));
      const nuevos = [];
      for (const f of filas) {
        if (!locales.has(f.id)) res.recibidos++;
        nuevos.push({ ...f, _sync: 'ok', _error: null });
      }
      await store.putMany(tabla, nuevos);
      const fin = filas[filas.length - 1];
      ultimo = { ts: fin.recibido_en, id: fin.id };
      if (!maxVisto || fin.recibido_en > maxVisto) maxVisto = fin.recibido_en;
      if (filas.length < pagina) break;
    }
    if (maxVisto) await store.setMeta(claveCursor, maxVisto);
  }

  async function traer(res) {
    const ranchos = await traerRanchos();
    await traerAdmin();
    for (const r of ranchos) {
      await traerTabla('animales', r.id, res); // primero las vacas, luego sus eventos
      await traerTabla('eventos', r.id, res);
    }
  }

  function sincronizar() {
    if (running) return running;
    running = (async () => {
      const res = { enviados: 0, rechazados: 0, unidas: 0, recibidos: 0, sinConexion: false, sesionVencida: false, error: null };
      try {
        await enviarAnimales(res);
        await enviarEventos(res);
        await traer(res);
      } catch (e) {
        if (e.network) res.sinConexion = true;
        else if (e.auth || e.status === 401) res.sesionVencida = true;
        else res.error = e.message || 'Error de sincronización';
      }
      const ok = !res.sinConexion && !res.sesionVencida && !res.error;
      await store.setMeta('ultimaSync', { ts: Date.now(), ok, ...(res.error ? { error: res.error } : {}) });
      return res;
    })().finally(() => { running = null; });
    return running;
  }

  async function contarPendientes() {
    const a = (await store.all('animales')).filter((x) => x._sync !== 'ok');
    const e = (await store.all('eventos')).filter((x) => x._sync !== 'ok');
    return { animales: a.length, eventos: e.length, total: a.length + e.length, conError: [...a, ...e].filter((x) => x._sync === 'error').length };
  }

  return { sincronizar, contarPendientes };
}
