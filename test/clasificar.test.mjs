import test from 'node:test';
import assert from 'node:assert/strict';
import { clasificarHato, motivoSinDatos, estadoVaca, resumenRancho } from '../app/lib.js';

const hoy = '2026-11-18';
const A = (id, arete) => ({ id, arete: arete ?? id });
const ev = (animal_id, tipo, fecha, datos = {}) => ({ id: `${animal_id}-${tipo}-${fecha}`, animal_id, tipo, fecha, datos, anula_a: null });
const dias = (n) => { const d = new Date(Date.UTC(2026, 10, 18) - n * 86400000); return d.toISOString().slice(0, 10); };

const animales = [A('a1', '1'), A('a10', '10'), A('a9', '9'), A('nada', '20'), A('nota', '21'), A('vieja', '22'), A('vencida', '23'), A('gest', '24'), A('celo', '30'), A('desc', '31'), A('lista', '32'), A('abierta', '33'), A('dx2', '40')];
const eventos = [
  ev('a1', 'inseminacion', dias(40)),   // diagnosticar 40 d
  ev('a10', 'inseminacion', dias(75)),  // diagnosticar 75 d (más atrasada)
  ev('a9', 'inseminacion', dias(31)),   // diagnosticar 31 d
  ev('nota', 'nota', dias(10), { texto: 'x' }),
  ev('vieja', 'parto', dias(400)), ev('vieja', 'diagnostico', dias(300), { resultado: 'vacia' }), // abierta y sin movimiento 300 d
  ev('vencida', 'inseminacion', dias(350)), ev('vencida', 'diagnostico', dias(320), { resultado: 'prenada' }), // parto esperado hace 67 d
  ev('gest', 'inseminacion', dias(100)), ev('gest', 'diagnostico', dias(60), { resultado: 'prenada' }),
  ev('celo', 'parto', dias(70)), ev('celo', 'celo', dias(2)),
  ev('desc', 'parto', dias(300)), ev('desc', 'descarte', dias(200)),
  ev('lista', 'parto', dias(60)),
  ev('abierta', 'parto', dias(200)), ev('abierta', 'diagnostico', dias(30), { resultado: 'vacia' }), // abierta reciente
  ev('dx2', 'inseminacion', dias(32)),
];
const r = clasificarHato(animales, eventos, hoy);

test('grupos por ver: orden de prioridad y dentro del grupo por urgencia', () => {
  assert.deepEqual(r.grupos.map((g) => g.codigo), ['diagnosticar', 'parto_proximo', 'celo', 'abierta', 'lista']);
  const dx = r.grupos[0].vacas.map((v) => v.a.arete);
  assert.deepEqual(dx, ['10', '1', '40', '9'], 'más días sin diagnóstico primero (75, 40, 32, 31)');
  const ab = r.grupos.find((g) => g.codigo === 'abierta').vacas.map((v) => v.a.arete);
  assert.deepEqual(ab, ['22', '33'], 'abiertas: la que lleva más días (400) antes que la de 200');
});
test('la gestante normal y la descartada no aparecen por ver', () => {
  const todas = r.grupos.flatMap((g) => g.vacas.map((v) => v.a.arete));
  assert.ok(!todas.includes('24') && !todas.includes('31'));
});
test('totalPorVer coincide con las vacas en alerta (mismo número que el panel)', () => {
  const alertas = animales.filter((a) => estadoVaca(eventos.filter((e) => e.animal_id === a.id), hoy).alerta).length;
  assert.equal(r.totalPorVer, alertas);
  const res = resumenRancho(animales, eventos, hoy);
  assert.equal(res.alertas, alertas);
});
test('sin datos: parto vencido, sin movimiento, sin estado y sin registros, en ese orden', () => {
  assert.deepEqual(r.sinDatos.map((f) => [f.a.arete, f.motivo.tipo]), [
    ['23', 'parto_vencido'], ['22', 'sin_movimiento'], ['21', 'sin_estado'], ['20', 'sin_registros'],
  ]);
  assert.match(r.sinDatos[0].motivo.texto, /hace 67 días/);
  assert.match(r.sinDatos[1].motivo.texto, /hace 300 días/);
});
test('las dudosas se marcan dentro de por ver (aparecen en ambos lados)', () => {
  const vencida = r.grupos.find((g) => g.codigo === 'parto_proximo').vacas.find((v) => v.a.arete === '23');
  assert.equal(vencida.dudosa, true);
  const celo = r.grupos.find((g) => g.codigo === 'celo').vacas[0];
  assert.equal(celo.dudosa, false);
});
test('resumenRancho.sinDatosVacas cuenta las mismas que la lista', () => {
  assert.equal(resumenRancho(animales, eventos, hoy).sinDatosVacas, r.sinDatos.length);
});
test('umbrales: justo en el límite no se marca; un día más sí', () => {
  const a = [A('x')];
  const mk = (n) => [ev('x', 'parto', dias(n + 60)), ev('x', 'diagnostico', dias(n), { resultado: 'vacia' })];
  const est = (evs) => estadoVaca(evs, hoy);
  assert.equal(motivoSinDatos(est(mk(120)), mk(120), hoy), null, '120 días exactos: todavía no');
  assert.equal(motivoSinDatos(est(mk(121)), mk(121), hoy).tipo, 'sin_movimiento');
  // parto esperado = servicio + 283; vencido > 21 días
  const g = (n) => [ev('x', 'inseminacion', dias(283 + n)), ev('x', 'diagnostico', dias(240), { resultado: 'prenada' })];
  assert.equal(motivoSinDatos(est(g(21)), g(21), hoy), null, '21 días de retraso: todavía no');
  assert.equal(motivoSinDatos(est(g(22)), g(22), hoy).tipo, 'parto_vencido');
});
test('anulaciones: un registro anulado no cuenta como movimiento', () => {
  const evs = [ev('x', 'parto', dias(400)), ev('x', 'diagnostico', dias(300), { resultado: 'vacia' }), ev('x', 'nota', dias(5), { texto: 'n' })];
  const anul = { id: 'an', animal_id: 'x', tipo: 'anulacion', fecha: dias(4), datos: {}, anula_a: evs[2].id };
  const est = estadoVaca([...evs, anul], hoy);
  assert.equal(motivoSinDatos(est, [...evs, anul], hoy).tipo, 'sin_movimiento');
  const est2 = estadoVaca(evs, hoy);
  assert.equal(motivoSinDatos(est2, evs, hoy), null, 'sin la anulación, la nota de hace 5 días sí cuenta como movimiento');
});
