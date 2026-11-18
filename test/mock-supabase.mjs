// Supabase SIMULADO para pruebas (no es Supabase real). Imita lo que usa HATO:
// Auth (password + refresh con rotación), PostgREST (filtros, orden, límite, on_conflict) y las reglas RLS/FK/únicos del esquema.

const AHORA_BASE = Date.UTC(2026, 10, 18, 17, 0, 0);

export class MockSupabase {
  constructor({ accessTtl = 3600 } = {}) {
    this.accessTtl = accessTtl;
    this.users = [];
    this.cooperativas = [];
    this.socios = [];
    this.ranchos = [];
    this.membresias = [];
    this.animales = [];
    this.eventos = [];
    this.admins = [];
    this.insumos = [];
    this.solicitudes = [];
    this.ordenes = [];
    this.tokens = new Map();
    this.refresh = new Map();
    this.reloj = 0;
    this.empates = false;      // si es true, todo lo nuevo recibe la misma recibido_en
    this.contador = 0;
    this.peticiones = [];      // bitácora
  }

  crearUsuario(email, password) {
    const u = { id: crypto.randomUUID(), email, password };
    this.users.push(u);
    return u;
  }

  crearRancho({ cooperativa = 'Coop Sintética', socio = 'Socio', rancho = 'Rancho' }) {
    let c = this.cooperativas.find((x) => x.nombre === cooperativa);
    if (!c) { c = { id: crypto.randomUUID(), nombre: cooperativa }; this.cooperativas.push(c); }
    const s = { id: crypto.randomUUID(), cooperativa_id: c.id, nombre: socio };
    this.socios.push(s);
    const r = { id: crypto.randomUUID(), socio_id: s.id, nombre: rancho };
    this.ranchos.push(r);
    return r;
  }

  vincular(user, rancho, rol = 'dueno', activo = true) {
    this.membresias.push({ user_id: user.id, rancho_id: rancho.id, rol, activo });
  }

  administrar(user, cooperativaNombre) {
    const c = this.cooperativas.find((x) => x.nombre === cooperativaNombre);
    this.admins.push({ user_id: user.id, cooperativa_id: c.id });
  }

  crearInsumo(cooperativaNombre, nombre, unidad) {
    const c = this.cooperativas.find((x) => x.nombre === cooperativaNombre);
    const i = { id: crypto.randomUUID(), cooperativa_id: c.id, nombre, unidad, activo: true };
    this.insumos.push(i);
    return i;
  }

  // --- reglas de acceso de insumos (espejo de las políticas reales) ---
  _coopsAdmin(uid) { return new Set(this.admins.filter((a) => a.user_id === uid).map((a) => a.cooperativa_id)); }
  _coopDeRancho(rid) { const r = this.ranchos.find((x) => x.id === rid); return r ? this.socios.find((x) => x.id === r.socio_id).cooperativa_id : null; }
  _ranchosAdmin(uid) { const cs = this._coopsAdmin(uid); return new Set(this.ranchos.filter((r) => cs.has(this._coopDeRancho(r.id))).map((r) => r.id)); }
  _coopsVisibles(uid, mis) { const s = new Set([...this._coopsAdmin(uid)]); for (const rid of mis) s.add(this._coopDeRancho(rid)); return s; }

  _filtrar(filas, url) {
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const mm = v.match(/^(eq)\.(.*)$/);
      if (!mm) return null;
      filas = filas.filter((f) => String(f[k]) === mm[2]);
    }
    return filas;
  }

  _getInsumos(tabla, url, uid, mis) {
    let filas;
    if (tabla === 'admins_cooperativa') {
      filas = this.admins.filter((a) => a.user_id === uid).map((a) => ({ cooperativa: { id: a.cooperativa_id, nombre: this.cooperativas.find((c) => c.id === a.cooperativa_id).nombre } }));
      return this._json(200, filas);
    }
    const ra = this._ranchosAdmin(uid);
    if (tabla === 'insumos') { const cs = this._coopsVisibles(uid, mis); filas = this.insumos.filter((i) => cs.has(i.cooperativa_id)); }
    else if (tabla === 'ranchos') filas = this.ranchos.filter((r) => mis.has(r.id) || ra.has(r.id)).map((r) => ({ id: r.id, nombre: r.nombre }));
    else if (tabla === 'ordenes_consolidadas') { const cs = this._coopsAdmin(uid); filas = this.ordenes.filter((o) => cs.has(o.cooperativa_id)); }
    else if (tabla === 'solicitudes_insumo') {
      filas = this.solicitudes.filter((s) => mis.has(s.rancho_id) || ra.has(s.rancho_id));
    } else return null;
    filas = this._filtrar(filas, url);
    if (!filas) return this._json(400, { code: 'PGRST100', message: 'filtro no soportado' });
    if (tabla === 'solicitudes_insumo' && /insumo:insumos/.test(url.searchParams.get('select') || '')) {
      filas = filas.map((s) => { const i = this.insumos.find((x) => x.id === s.insumo_id); return { ...s, insumo: { nombre: i.nombre, unidad: i.unidad } }; });
    }
    const ord = url.searchParams.get('order') || '';
    const m = ord.match(/^(\w+)\.(asc|desc)$/);
    if (m) filas = [...filas].sort((a, b) => (a[m[1]] < b[m[1]] ? -1 : a[m[1]] > b[m[1]] ? 1 : 0) * (m[2] === 'desc' ? -1 : 1));
    const lim = Number(url.searchParams.get('limit'));
    if (lim) filas = filas.slice(0, lim);
    return this._json(200, filas);
  }

  _postInsumos(tabla, h, body, uid, mis) {
    if (tabla === 'solicitudes_insumo') {
      const m = this.membresias.find((x) => x.user_id === uid && x.rancho_id === body.rancho_id && x.activo && (x.rol === 'dueno' || x.rol === 'mvz'));
      const ins = this.insumos.find((i) => i.id === body.insumo_id && i.activo);
      if (!m || !ins || ins.cooperativa_id !== this._coopDeRancho(body.rancho_id) || body.creado_por !== uid) return this._json(403, { code: '42501', message: 'new row violates row-level security policy for table "solicitudes_insumo"' });
      if (!Number.isInteger(body.cantidad) || body.cantidad < 1) return this._json(400, { code: '23514', message: 'check constraint' });
      this.solicitudes.push({ id: body.id, rancho_id: body.rancho_id, insumo_id: body.insumo_id, cantidad: body.cantidad, nota: body.nota ?? null, estado: 'pendiente', orden_id: null, creado_por: uid, creado_en: this.marca() });
      return { status: 201, body: '' };
    }
    if (tabla === 'insumos') {
      if (!this._coopsAdmin(uid).has(body.cooperativa_id)) return this._json(403, { code: '42501', message: 'new row violates row-level security policy for table "insumos"' });
      if (this.insumos.some((i) => i.cooperativa_id === body.cooperativa_id && i.nombre === body.nombre)) return this._json(409, { code: '23505', message: 'duplicate key' });
      this.insumos.push({ id: crypto.randomUUID(), cooperativa_id: body.cooperativa_id, nombre: body.nombre, unidad: body.unidad, activo: true });
      return { status: 201, body: '' };
    }
    if (tabla === 'rpc/consolidar_solicitudes') {
      if (!this._coopsAdmin(uid).has(body.p_cooperativa)) return this._json(403, { code: '42501', message: 'No eres administrador de esta cooperativa' });
      const objetivo = this.solicitudes.filter((s) => s.estado === 'pendiente' && this._coopDeRancho(s.rancho_id) === body.p_cooperativa && (!body.p_insumo_ids || body.p_insumo_ids.includes(s.insumo_id)));
      if (!objetivo.length) return this._json(404, { code: 'P0002', message: 'No hay solicitudes pendientes para consolidar' });
      const o = { id: crypto.randomUUID(), cooperativa_id: body.p_cooperativa, destinatario_tipo: body.p_tipo, destinatario: body.p_destinatario, nota: body.p_nota ?? null, estado: 'borrador', creada_por: uid, creada_en: this.marca() };
      this.ordenes.push(o);
      for (const s of objetivo) { s.estado = 'consolidada'; s.orden_id = o.id; }
      return this._json(200, o.id);
    }
    return null;
  }

  _patch(tabla, url, body, uid, mis) {
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    if (tabla === 'solicitudes_insumo') {
      const s = this.solicitudes.find((x) => x.id === id);
      const puede = s && s.estado === 'pendiente' && this.membresias.some((m) => m.user_id === uid && m.rancho_id === s.rancho_id && m.activo && (m.rol === 'dueno' || m.rol === 'mvz'));
      if (!puede || body.estado !== 'cancelada') return this._json(200, []);
      s.estado = 'cancelada';
      return this._json(200, [s]);
    }
    if (tabla === 'ordenes_consolidadas') {
      const o = this.ordenes.find((x) => x.id === id && this._coopsAdmin(uid).has(x.cooperativa_id));
      if (!o || !['borrador', 'enviada', 'recibida', 'cancelada'].includes(body.estado)) return this._json(200, []);
      o.estado = body.estado;
      return this._json(200, [o]);
    }
    return this._json(404, { message: 'tabla desconocida' });
  }

  marca() {
    const ms = AHORA_BASE + (this.empates ? 0 : this.reloj++ * 1000);
    return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1123+00:00'); // como PostgREST: microsegundos y +00:00
  }

  _json(status, obj) { return { status, body: obj === null || obj === undefined ? '' : JSON.stringify(obj) }; }

  _emitir(userId) {
    const access = `at_${userId}_${++this.contador}`;
    const refresh = `rt_${userId}_${++this.contador}`;
    const exp = Math.floor(Date.now() / 1000) + this.accessTtl;
    this.tokens.set(access, { userId, exp });
    this.refresh.set(refresh, userId);
    const u = this.users.find((x) => x.id === userId);
    return { access_token: access, refresh_token: refresh, expires_in: this.accessTtl, expires_at: exp, user: { id: u.id, email: u.email } };
  }

  /** Obliga a que el access token de un usuario venza ya. */
  vencerAccess(userId) { for (const [t, v] of this.tokens) if (v.userId === userId) v.exp = 1; }
  revocarRefresh(userId) { for (const [t, u] of this.refresh) if (u === userId) this.refresh.delete(t); }

  handle(method, rawUrl, headers = {}, bodyText = '') {
    const url = new URL(rawUrl, 'http://mock.local');
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.peticiones.push(`${method} ${url.pathname}`);
    if (!h.apikey) return this._json(401, { message: 'No API key found in request' });
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { return this._json(400, { message: 'JSON inválido' }); }

    if (url.pathname === '/auth/v1/token') {
      const g = url.searchParams.get('grant_type');
      if (g === 'password') {
        const u = this.users.find((x) => x.email === body.email && x.password === body.password);
        if (!u) return this._json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return this._json(200, this._emitir(u.id));
      }
      if (g === 'refresh_token') {
        const uid = this.refresh.get(body.refresh_token);
        if (!uid) return this._json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        this.refresh.delete(body.refresh_token);
        return this._json(200, this._emitir(uid));
      }
    }
    if (url.pathname === '/auth/v1/logout') return { status: 204, body: '' };

    if (!url.pathname.startsWith('/rest/v1/')) return this._json(404, { message: 'no existe' });
    const tk = (h.authorization || '').replace(/^Bearer\s+/i, '');
    const sesion = this.tokens.get(tk);
    if (!sesion) return this._json(401, { code: 'PGRST301', message: 'JWT inválido' });
    if (sesion.exp < Math.floor(Date.now() / 1000)) return this._json(401, { code: 'PGRST303', message: 'JWT expired' });
    const uid = sesion.userId;
    const tabla = url.pathname.replace('/rest/v1/', '');
    const mis = new Set(this.membresias.filter((m) => m.user_id === uid && m.activo).map((m) => m.rancho_id));

    if (method === 'GET') { const x = this._getInsumos(tabla, url, uid, mis); if (x) return x; return this._get(tabla, url, uid, mis); }
    if (method === 'POST') { const x = this._postInsumos(tabla, h, body || {}, uid, mis); if (x) return x; return this._post(tabla, url, h, body, uid, mis); }
    if (method === 'PATCH') return this._patch(tabla, url, body || {}, uid, mis);
    return this._json(405, { message: 'método no permitido' });
  }

  _get(tabla, url, uid, mis) {
    if (tabla === 'membresias') {
      const filas = this.membresias.filter((m) => m.user_id === uid && (url.searchParams.get('activo') !== 'eq.true' || m.activo));
      const out = filas.map((m) => {
        const r = this.ranchos.find((x) => x.id === m.rancho_id);
        const s = this.socios.find((x) => x.id === r.socio_id);
        const c = this.cooperativas.find((x) => x.id === s.cooperativa_id);
        return { rol: m.rol, rancho: { id: r.id, nombre: r.nombre, socio: { nombre: s.nombre, cooperativa: { nombre: c.nombre } } } };
      });
      return this._json(200, out);
    }
    if (tabla !== 'animales' && tabla !== 'eventos') return this._json(404, { message: 'tabla desconocida' });
    let filas = this[tabla].filter((f) => mis.has(f.rancho_id)); // RLS
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (k === 'or') {
        const m = v.match(/^\(recibido_en\.gt\."(.+?)",and\(recibido_en\.eq\."(.+?)",id\.gt\."(.+?)"\)\)$/);
        if (!m) return this._json(400, { code: 'PGRST100', message: 'or no soportado por el simulador' });
        filas = filas.filter((f) => f.recibido_en > m[1] || (f.recibido_en === m[2] && f.id > m[3]));
        continue;
      }
      const mm = v.match(/^(eq|gte|gt)\.(.*)$/);
      if (!mm) return this._json(400, { code: 'PGRST100', message: `filtro no soportado: ${k}=${v}` });
      const [, op, val] = mm;
      filas = filas.filter((f) => {
        const x = String(f[k]);
        if (op === 'eq') return x === val;
        if (op === 'gte') return x >= val;
        return x > val;
      });
    }
    filas = [...filas].sort((a, b) => (a.recibido_en < b.recibido_en ? -1 : a.recibido_en > b.recibido_en ? 1 : a.id < b.id ? -1 : 1));
    const lim = Number(url.searchParams.get('limit'));
    if (lim) filas = filas.slice(0, lim);
    return this._json(200, filas);
  }

  _post(tabla, url, h, body, uid, mis) {
    const ignorar = /ignore-duplicates/.test(h.prefer || '') && url.searchParams.get('on_conflict') === 'id';
    const lista = Array.isArray(body) ? body : [body];
    if (tabla !== 'animales' && tabla !== 'eventos') return this._json(404, { message: 'tabla desconocida' });
    const nuevos = [];
    for (const f of lista) {
      if (!mis.has(f.rancho_id)) return this._json(403, { code: '42501', message: 'new row violates row-level security policy' });
      if (this[tabla].some((x) => x.id === f.id)) { if (ignorar) continue; return this._json(409, { code: '23505', message: 'duplicate key value violates unique constraint "pkey"' }); }
      if (tabla === 'animales') {
        if (!f.arete || String(f.arete).trim().length < 1 || String(f.arete).length > 30) return this._json(400, { code: '23514', message: 'check constraint' });
        if (this.animales.some((x) => x.rancho_id === f.rancho_id && x.arete === f.arete) || nuevos.some((x) => x.rancho_id === f.rancho_id && x.arete === f.arete)) {
          return this._json(409, { code: '23505', message: 'duplicate key value violates unique constraint "animales_rancho_id_arete_key"' });
        }
        nuevos.push({ id: f.id, rancho_id: f.rancho_id, arete: f.arete, nombre: f.nombre ?? null, fecha_nacimiento: f.fecha_nacimiento ?? null, creado_por: uid, dispositivo_ts: f.dispositivo_ts ?? null, recibido_en: this.marca() });
      } else {
        const hoyMas1 = new Date(Date.now() + 86400000 * 1.5).toISOString().slice(0, 10);
        if (f.fecha > hoyMas1) return this._json(403, { code: '42501', message: 'new row violates row-level security policy' });
        if (!this.animales.some((a) => a.id === f.animal_id && a.rancho_id === f.rancho_id)) return this._json(409, { code: '23503', message: 'violates foreign key constraint' });
        if (!['celo', 'inseminacion', 'monta', 'diagnostico', 'parto', 'aborto', 'secado', 'descarte', 'tratamiento', 'nota', 'anulacion'].includes(f.tipo)) return this._json(400, { code: '23514', message: 'check constraint tipo' });
        if ((f.tipo === 'anulacion') !== Boolean(f.anula_a)) return this._json(400, { code: '23514', message: 'check constraint anulacion' });
        nuevos.push({ id: f.id, rancho_id: f.rancho_id, animal_id: f.animal_id, tipo: f.tipo, fecha: f.fecha, datos: f.datos || {}, canal: f.canal || 'app', anula_a: f.anula_a ?? null, creado_por: uid, dispositivo_ts: f.dispositivo_ts ?? null, recibido_en: this.marca() });
      }
    }
    this[tabla].push(...nuevos); // la inserción es atómica: o entran todos o ninguno
    return { status: 201, body: '' };
  }
}

/** fetch simulado con control de conexión y pérdida de respuesta. */
export function crearFetch(mock, ctl = { online: true, perderRespuestas: 0 }) {
  const f = async (url, init = {}) => {
    if (!ctl.online) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const r = mock.handle(init.method || 'GET', u.pathname + u.search, init.headers || {}, init.body || '');
    if (ctl.perderRespuestas > 0) { ctl.perderRespuestas--; throw new TypeError('connection reset'); } // el servidor SÍ procesó la petición
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  f.ctl = ctl;
  return f;
}
