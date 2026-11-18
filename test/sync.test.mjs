import test from 'node:test';
import assert from 'node:assert/strict';
import { MockSupabase, crearFetch } from './mock-supabase.mjs';
import { createApi } from '../api.js';
import { createSync } from '../sync.js';
import { createMemStore } from '../store.js';
import { uuid, estadoVaca } from '../lib.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** Un "teléfono": su propio almacenamiento local y su propia sesión. */
async function telefono(mock, ctl, email = 'v@test.invalid', pass = 'x', opts = {}) {
  const api = createApi({ url: 'https://mock.test', key: 'pk', storage: memStorage(), fetchImpl: crearFetch(mock, ctl), ...opts });
  const store = createMemStore();
  const sync = createSync({ store, api, ...(opts.pagina ? { pagina: opts.pagina } : {}) });
  await api.login(email, pass);
  return { api, store, sync, user: api.getSession().user };
}

function escenario() {
  const mock = new MockSupabase();
  const u = mock.crearUsuario('v@test.invalid', 'x');
  const r = mock.crearRancho({ socio: 'Socio A', rancho: 'Rancho A' });
  mock.vincular(u, r);
  return { mock, u, r, ctl: { online: true, perderRespuestas: 0 } };
}

const animalLocal = (r, arete) => ({ id: uuid(), rancho_id: r.id, arete, nombre: null, fecha_nacimiento: null, dispositivo_ts: new Date().toISOString(), _sync: 'pendiente' });
const eventoLocal = (r, a, tipo, fecha, datos = {}, extra = {}) => ({ id: uuid(), rancho_id: r.id, animal_id: a.id, tipo, fecha, datos, canal: 'app', anula_a: null, dispositivo_ts: new Date().toISOString(), _sync: 'pendiente', ...extra });

test('login y primera descarga: trae ranchos, vacas y eventos solo del propio rancho', async () => {
  const { mock, u, r, ctl } = escenario();
  const otro = mock.crearRancho({ socio: 'Socio B', rancho: 'Rancho B' }); // sin vínculo
  const x = crypto.randomUUID(); const y = crypto.randomUUID();
  mock.animales.push({ id: x, rancho_id: r.id, arete: '100', recibido_en: mock.marca() }, { id: y, rancho_id: otro.id, arete: '900', recibido_en: mock.marca() });
  const t = await telefono(mock, ctl);
  const res = await t.sync.sincronizar();
  assert.equal(res.error, null);
  const ranchos = await t.store.getMeta('ranchos');
  assert.deepEqual(ranchos.map((q) => q.nombre), ['Rancho A']);
  assert.equal(ranchos[0].socio, 'Socio A');
  assert.equal(ranchos[0].cooperativa, 'Coop Sintética');
  const animales = await t.store.all('animales');
  assert.deepEqual(animales.map((a) => a.arete), ['100']); // la vaca del otro rancho no llega
  void u;
});

test('sin conexión: lo registrado queda pendiente; al volver la conexión se envía una sola vez', async () => {
  const { mock, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar(); // descarga ranchos
  ctl.online = false;
  const a = animalLocal(r, '345');
  const e1 = eventoLocal(r, a, 'inseminacion', '2026-11-10', { toro: 'T-9' });
  const e2 = eventoLocal(r, a, 'celo', '2026-11-18');
  await t.store.put('animales', a); await t.store.put('eventos', e1); await t.store.put('eventos', e2);
  const off = await t.sync.sincronizar();
  assert.equal(off.sinConexion, true);
  assert.deepEqual(await t.sync.contarPendientes(), { animales: 1, eventos: 2, total: 3, conError: 0 });
  assert.equal(mock.animales.length, 0);
  ctl.online = true;
  const on = await t.sync.sincronizar();
  assert.equal(on.enviados, 3);
  assert.equal((await t.sync.contarPendientes()).total, 0);
  assert.equal(mock.animales.length, 1);
  assert.equal(mock.eventos.length, 2);
  const otra = await t.sync.sincronizar(); // volver a sincronizar no duplica
  assert.equal(otra.enviados, 0);
  assert.equal(mock.eventos.length, 2);
});

test('se pierde la respuesta del servidor (él SÍ guardó): el reenvío no duplica', async () => {
  const { mock, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  const a = animalLocal(r, '77');
  const e = eventoLocal(r, a, 'celo', '2026-11-18');
  await t.store.put('animales', a); await t.store.put('eventos', e);
  ctl.perderRespuestas = 1; // se cae la conexión justo después de que el servidor guardó la vaca
  const r1 = await t.sync.sincronizar();
  assert.equal(r1.sinConexion, true);
  assert.equal(mock.animales.length, 1); // el servidor la tiene...
  assert.equal((await t.store.get('animales', a.id))._sync, 'pendiente'); // ...pero el teléfono no lo sabe
  const r2 = await t.sync.sincronizar();
  assert.equal(r2.error, null);
  assert.equal(mock.animales.length, 1);
  assert.equal(mock.eventos.length, 1);
  assert.equal((await t.sync.contarPendientes()).total, 0);
});

test('dos teléfonos crean la misma vaca sin conexión: se unen y los eventos de ambos quedan en una sola vaca', async () => {
  const { mock, r, ctl } = escenario();
  const u2 = mock.crearUsuario('d@test.invalid', 'y'); mock.vincular(u2, r, 'vaquero');
  const A = await telefono(mock, ctl, 'v@test.invalid', 'x');
  const B = await telefono(mock, ctl, 'd@test.invalid', 'y');
  await A.sync.sincronizar(); await B.sync.sincronizar();
  const aA = animalLocal(r, '555'); const aB = animalLocal(r, '555');
  await A.store.put('animales', aA); await A.store.put('eventos', eventoLocal(r, aA, 'inseminacion', '2026-11-01'));
  await B.store.put('animales', aB); await B.store.put('eventos', eventoLocal(r, aB, 'celo', '2026-10-10'));
  await A.sync.sincronizar();
  const resB = await B.sync.sincronizar();
  assert.equal(resB.unidas, 1);
  assert.equal(mock.animales.length, 1);
  assert.equal(mock.eventos.length, 2);
  assert.ok(mock.eventos.every((e) => e.animal_id === aA.id));
  const locales = await B.store.all('animales');
  assert.equal(locales.length, 1);
  assert.equal(locales[0].id, aA.id);
  assert.equal((await B.sync.contarPendientes()).total, 0);
});

test('se pierde la respuesta al enviar un EVENTO (el servidor sí lo guardó): el reenvío no duplica ni lo marca como error', async () => {
  const { mock, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  const a = animalLocal(r, '88');
  await t.store.put('animales', a);
  await t.sync.sincronizar(); // la vaca ya está en el servidor
  const e = eventoLocal(r, a, 'inseminacion', '2026-11-18', { toro: 'T-1' });
  await t.store.put('eventos', e);
  ctl.perderRespuestas = 1; // la primera petición (el evento) llega al servidor pero la respuesta se pierde
  const r1 = await t.sync.sincronizar();
  assert.equal(r1.sinConexion, true);
  assert.equal(mock.eventos.length, 1);
  assert.equal((await t.store.get('eventos', e.id))._sync, 'pendiente');
  const r2 = await t.sync.sincronizar();
  assert.equal(r2.error, null);
  assert.equal(r2.rechazados, 0);
  assert.equal(mock.eventos.length, 1);
  assert.equal((await t.store.get('eventos', e.id))._sync, 'ok');
});

test('anulación con la misma marca de tiempo que su evento: igual se envía en el orden correcto (repetido 30 veces)', async () => {
  for (let i = 0; i < 30; i++) {
    const { mock, r, ctl } = escenario();
    const t = await telefono(mock, ctl);
    await t.sync.sincronizar();
    const a = animalLocal(r, `X${i}`);
    const ts = '2026-11-18T10:00:00.000Z';
    const dx = eventoLocal(r, a, 'diagnostico', '2026-11-18', { resultado: 'vacia' }, { dispositivo_ts: ts });
    const an = eventoLocal(r, a, 'anulacion', '2026-11-18', {}, { anula_a: dx.id, dispositivo_ts: ts });
    await t.store.put('animales', a); await t.store.put('eventos', an); await t.store.put('eventos', dx);
    const res = await t.sync.sincronizar();
    assert.equal(res.rechazados, 0);
    assert.equal(mock.eventos.length, 2, `iteración ${i}`);
  }
});

test('anulación: se envía después del evento que anula y la vaca vuelve a su estado anterior', async () => {
  const { mock, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  const a = animalLocal(r, '12');
  const ia = eventoLocal(r, a, 'inseminacion', '2026-01-10');
  const dx = eventoLocal(r, a, 'diagnostico', '2026-02-12', { resultado: 'prenada' });
  const anul = eventoLocal(r, a, 'anulacion', '2026-02-13', {}, { anula_a: dx.id });
  for (const e of [anul, dx, ia]) await t.store.put('eventos', e); // desordenados a propósito
  await t.store.put('animales', a);
  const res = await t.sync.sincronizar();
  assert.equal(res.rechazados, 0);
  assert.equal(mock.eventos.length, 3);
  const todos = await t.store.all('eventos');
  assert.notEqual(estadoVaca(todos, '2026-02-20').codigo, 'gestante');
});

test('un evento espera a que su vaca llegue al servidor', async () => {
  const { mock, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  const a = { ...animalLocal(r, '1'), _sync: 'error', _error: 'x' };
  await t.store.put('animales', a);
  await t.store.put('eventos', eventoLocal(r, a, 'celo', '2026-11-18'));
  await t.sync.sincronizar();
  assert.equal(mock.eventos.length, 0);
  assert.equal((await t.sync.contarPendientes()).eventos, 1);
});

test('quitan al usuario del rancho: sus pendientes se marcan con error (no se pierden) y no bloquean lo demás', async () => {
  const { mock, u, r, ctl } = escenario();
  const r2 = mock.crearRancho({ rancho: 'Rancho C' }); mock.vincular(u, r2);
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  mock.membresias.find((m) => m.user_id === u.id && m.rancho_id === r.id).activo = false;
  const a1 = animalLocal(r, '1'); const a2 = animalLocal(r2, '2');
  await t.store.put('animales', a1); await t.store.put('animales', a2);
  const res = await t.sync.sincronizar();
  assert.equal(res.rechazados, 1);
  assert.equal(res.enviados, 1);
  const p = await t.store.get('animales', a1.id);
  assert.equal(p._sync, 'error');
  assert.match(p._error, /permiso/i);
  assert.equal(mock.animales.length, 1);
});

test('el token vence: se renueva solo; si la renovación falla, la sesión vence y NADA se pierde', async () => {
  const { mock, u, r, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  const a = animalLocal(r, '9'); await t.store.put('animales', a);
  mock.vencerAccess(u.id);
  const ok = await t.sync.sincronizar(); // renueva con el refresh token
  assert.equal(ok.error, null);
  assert.equal(mock.animales.length, 1);
  const b = animalLocal(r, '10'); await t.store.put('animales', b);
  mock.vencerAccess(u.id); mock.revocarRefresh(u.id);
  const mal = await t.sync.sincronizar();
  assert.equal(mal.sesionVencida, true);
  assert.equal(t.api.getSession().expired, true);
  assert.equal((await t.store.get('animales', b.id))._sync, 'pendiente'); // sigue pendiente, intacto
  // vuelve a entrar con la misma cuenta y se envía
  await t.api.login('v@test.invalid', 'x');
  const fin = await t.sync.sincronizar();
  assert.equal(fin.error, null);
  assert.equal(mock.animales.length, 2);
});

test('sin conexión durante la renovación del token NO cierra la sesión', async () => {
  const { mock, u, ctl } = escenario();
  const t = await telefono(mock, ctl);
  await t.sync.sincronizar();
  mock.vencerAccess(u.id);
  ctl.online = false;
  const res = await t.sync.sincronizar();
  assert.equal(res.sinConexion, true);
  assert.equal(t.api.getSession().expired, false);
  ctl.online = true;
  assert.equal((await t.sync.sincronizar()).error, null);
});

test('descarga con paginación: 2500 registros, incluso con la misma recibido_en (carga masiva en una transacción)', async () => {
  const { mock, r, ctl } = escenario();
  mock.empates = true;
  const a = { id: crypto.randomUUID(), rancho_id: r.id, arete: 'M', recibido_en: mock.marca() };
  mock.animales.push(a);
  for (let i = 0; i < 2500; i++) mock.eventos.push({ id: crypto.randomUUID(), rancho_id: r.id, animal_id: a.id, tipo: 'celo', fecha: '2026-01-01', datos: {}, canal: 'app', anula_a: null, recibido_en: mock.marca() });
  const t = await telefono(mock, ctl, 'v@test.invalid', 'x', { pagina: 1000 });
  const res = await t.sync.sincronizar();
  assert.equal(res.error, null);
  assert.equal((await t.store.all('eventos')).length, 2500);
  assert.equal(res.recibidos, 2501);
  const otra = await t.sync.sincronizar(); // segunda vez: solo la ventana de solapamiento
  assert.equal(otra.error, null);
  assert.equal((await t.store.all('eventos')).length, 2500);
});

test('un teléfono ve lo que registró otro (descarga incremental)', async () => {
  const { mock, u, r, ctl } = escenario();
  const u2 = mock.crearUsuario('d@test.invalid', 'y'); mock.vincular(u2, r, 'vaquero');
  const A = await telefono(mock, ctl, 'v@test.invalid', 'x');
  const B = await telefono(mock, ctl, 'd@test.invalid', 'y');
  await A.sync.sincronizar(); await B.sync.sincronizar();
  const a = animalLocal(r, '31'); await A.store.put('animales', a);
  await A.store.put('eventos', eventoLocal(r, a, 'parto', '2026-11-17', { cria: 'hembra' }));
  await A.sync.sincronizar();
  await B.sync.sincronizar();
  const evB = await B.store.all('eventos');
  assert.equal(evB.length, 1);
  assert.equal(evB[0].tipo, 'parto');
  assert.equal((await B.store.all('animales'))[0].arete, '31');
  void u;
});
