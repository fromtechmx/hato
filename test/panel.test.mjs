import test from 'node:test';
import assert from 'node:assert/strict';
import { resumenRancho, recomendarVisita, agruparSolicitudes, validarSolicitud, sumarDias } from '../lib.js';

const HOY = '2026-11-18';
const NOW = new Date('2026-11-18T18:00:00Z').getTime();
let n = 0;
const vaca = (id = 'v' + ++n) => ({ id, _sync: 'ok', recibido_en: '2026-11-18T12:00:00Z' });
const ev = (animal_id, tipo, off, datos = {}) => ({ id: 'e' + ++n, animal_id, tipo, fecha: sumarDias(HOY, -off), datos, anula_a: null, _sync: 'ok', recibido_en: '2026-11-18T12:00:00Z' });

test('cuenta cada situación y la próxima fecha', () => {
  const a = [vaca('1'), vaca('2'), vaca('3'), vaca('4'), vaca('5')];
  const e = [
    ev('1', 'parto', 100), ev('1', 'inseminacion', 40),                       // toca diagnóstico
    ev('2', 'parto', 400), ev('2', 'inseminacion', 270), ev('2', 'diagnostico', 235, { resultado: 'prenada' }), // parto próximo
    ev('3', 'parto', 70), ev('3', 'celo', 5),                                  // celo
    ev('4', 'parto', 90), ev('4', 'inseminacion', 20),                         // servida: diag en 10 días
    ev('5', 'parto', 500), ev('5', 'inseminacion', 250), ev('5', 'diagnostico', 215, { resultado: 'prenada' }), ev('5', 'secado', 20),
  ];
  const r = resumenRancho(a, e, HOY, NOW);
  assert.equal(r.vacas, 5);
  assert.equal(r.diagnosticar, 1);
  assert.equal(r.partoProximo, 1);
  assert.equal(r.celo, 1);
  assert.equal(r.alertas, 3);
  assert.deepEqual(r.proxima, { fecha: sumarDias(HOY, 10), texto: 'diagnósticos' });
  assert.equal(r.diasSinDatos, 0);
});

test('una anulación quita el pendiente', () => {
  const a = [vaca('1')];
  const celo = ev('1', 'celo', 2);
  const anul = { ...ev('1', 'anulacion', 1), anula_a: celo.id };
  const sin = resumenRancho(a, [ev('1', 'parto', 70), celo, anul], HOY, NOW);
  assert.equal(sin.celo, 0);
});

test('visitar cuando hay suficientes pendientes en sitio', () => {
  const r = { vacas: 20, diagnosticar: 4, partoProximo: 1, celo: 0, abiertas: 0, listas: 0, alertas: 5, proxima: null, ultimoDato: 'x', diasSinDatos: 0 };
  assert.equal(recomendarVisita(r).codigo, 'visitar');
  assert.equal(recomendarVisita({ ...r, diagnosticar: 3 }).codigo, 'llamar');
});

test('cero pendientes pero sin datos recientes pide llamar, no "sin urgencia"', () => {
  const r = { vacas: 9, diagnosticar: 0, partoProximo: 0, celo: 0, abiertas: 0, listas: 0, alertas: 0, proxima: null, ultimoDato: 'x', diasSinDatos: 19 };
  const x = recomendarVisita(r);
  assert.equal(x.codigo, 'sin_datos');
  assert.match(x.motivo, /19 días/);
  assert.equal(recomendarVisita({ ...r, diasSinDatos: 14 }).codigo, 'sin_urgencia'); // el umbral es "más de 14"
});

test('prioridad: visitar < llamar < sin datos < sin urgencia', () => {
  const base = { vacas: 10, diagnosticar: 0, partoProximo: 0, celo: 0, abiertas: 0, listas: 0, alertas: 0, proxima: null, ultimoDato: 'x', diasSinDatos: 0 };
  const p = [{ ...base, diagnosticar: 5, alertas: 5 }, { ...base, alertas: 2, celo: 2 }, { ...base, diasSinDatos: 30 }, base].map((r) => recomendarVisita(r).prioridad);
  assert.deepEqual(p, [1, 2, 3, 4]);
});

test('rancho sin vacas y rancho sin ningún dato recibido', () => {
  assert.equal(recomendarVisita(resumenRancho([], [], HOY, NOW)).codigo, 'sin_vacas');
  const pendienteLocal = [{ id: 'x', _sync: 'pendiente' }];
  const r = resumenRancho(pendienteLocal, [], HOY, NOW);
  assert.equal(r.ultimoDato, null);       // lo que solo está en el teléfono no cuenta como dato recibido
  assert.equal(r.diasSinDatos, null);
  const mixto = resumenRancho([{ id: 'x', _sync: 'pendiente', recibido_en: '2026-11-18T17:00:00Z' }, { id: 'y', _sync: 'ok', recibido_en: '2026-11-10T00:00:00Z' }], [], HOY, NOW);
  assert.equal(mixto.ultimoDato, '2026-11-10T00:00:00Z');
});

test('agrupar solicitudes: solo pendientes, suma por insumo y desglose por rancho', () => {
  const ins = [{ id: 'i1', nombre: 'Pajillas', unidad: 'pajilla' }, { id: 'i2', nombre: 'Guantes', unidad: 'caja' }];
  const ran = [{ id: 'r1', nombre: 'A' }, { id: 'r2', nombre: 'C' }];
  const s = [
    { insumo_id: 'i1', rancho_id: 'r1', cantidad: 40, estado: 'pendiente' },
    { insumo_id: 'i1', rancho_id: 'r2', cantidad: 25, estado: 'pendiente' },
    { insumo_id: 'i1', rancho_id: 'r2', cantidad: 5, estado: 'pendiente' },
    { insumo_id: 'i2', rancho_id: 'r1', cantidad: 3, estado: 'consolidada' },
    { insumo_id: 'i2', rancho_id: 'r1', cantidad: 9, estado: 'cancelada' },
    { insumo_id: 'zz', rancho_id: 'r1', cantidad: 9, estado: 'pendiente' },
  ];
  const g = agruparSolicitudes(s, ins, ran);
  assert.equal(g.length, 1);
  assert.equal(g[0].total, 70);
  assert.deepEqual(g[0].ranchos, [{ rancho: 'A', cantidad: 40 }, { rancho: 'C', cantidad: 30 }]);
});

test('validar solicitud', () => {
  assert.ok(validarSolicitud({ insumo_id: '', cantidad: 3 }));
  for (const c of [0, -1, 1.5, 'abc', '', 100001]) assert.ok(validarSolicitud({ insumo_id: 'x', cantidad: c }), String(c));
  assert.equal(validarSolicitud({ insumo_id: 'x', cantidad: '12' }), null);
});

import { repartir, lineasDeEntrega } from '../lib.js';

const S = (id, cantidad, creado_en = '2026-11-18T10:00:00Z') => ({ id, cantidad, creado_en });
const suma = (m) => [...m.values()].reduce((a, b) => a + b, 0);

test('repartir: llegó todo o más → cada uno recibe lo pedido', () => {
  const r = repartir([S('a', 40), S('c', 25)], 65);
  assert.deepEqual([r.get('a'), r.get('c')], [40, 25]);
  const m = repartir([S('a', 40), S('c', 25)], 100);
  assert.deepEqual([m.get('a'), m.get('c')], [40, 25]); // el excedente no se reparte
});

test('repartir: llegó menos → proporcional y suma exacta (mismo resultado que la función SQL: 50 de 65 → 31 y 19)', () => {
  const r = repartir([S('a', 40), S('c', 25)], 50);
  assert.equal(r.get('a'), 31);
  assert.equal(r.get('c'), 19);
  assert.equal(suma(r), 50);
});

test('repartir: cero, empates y sumas exactas en muchos casos', () => {
  assert.equal(suma(repartir([S('a', 5), S('b', 5)], 0)), 0);
  const e = repartir([S('a', 5, '2026-01-01'), S('b', 5, '2026-01-02')], 5); // 2.5 y 2.5: el residuo va al más antiguo
  assert.deepEqual([e.get('a'), e.get('b')], [3, 2]);
  for (let rec = 0; rec < 60; rec++) {
    const sol = [S('a', 13), S('b', 7), S('c', 29), S('d', 1)];
    const r = repartir(sol, rec);
    assert.equal(suma(r), Math.min(rec, 50), `rec=${rec}`);
    for (const s of sol) assert.ok(r.get(s.id) <= s.cantidad, 'nadie recibe más de lo que pidió');
  }
});

test('lineasDeEntrega: agrupa por insumo y distingue "sin asignar aún"', () => {
  const ins = [{ id: 'i1', nombre: 'Pajillas', unidad: 'pajilla' }, { id: 'i2', nombre: 'Guantes', unidad: 'caja' }];
  const sol = [
    { orden_id: 'o1', rancho_id: 'rA', insumo_id: 'i1', cantidad: 40, cantidad_asignada: null },
    { orden_id: 'o1', rancho_id: 'rA', insumo_id: 'i2', cantidad: 3, cantidad_asignada: null },
    { orden_id: 'o1', rancho_id: 'rC', insumo_id: 'i1', cantidad: 25, cantidad_asignada: null },
    { orden_id: 'o2', rancho_id: 'rA', insumo_id: 'i1', cantidad: 9, cantidad_asignada: 9 },
  ];
  const l = lineasDeEntrega(sol, ins, 'o1', 'rA');
  assert.deepEqual(l, [{ nombre: 'Guantes', unidad: 'caja', pedida: 3, asignada: null }, { nombre: 'Pajillas', unidad: 'pajilla', pedida: 40, asignada: null }]);
  const asignado = lineasDeEntrega([{ ...sol[0], cantidad_asignada: 31 }], ins, 'o1', 'rA');
  assert.equal(asignado[0].asignada, 31);
});
