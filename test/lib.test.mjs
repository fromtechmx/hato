import test from 'node:test';
import assert from 'node:assert/strict';
import { hoyLocal, diasEntre, sumarDias, normArete, validarEvento, eventosVigentes, estadoVaca, tipoSugerido, PARAMS } from '../app/lib.js';

const ev = (tipo, fecha, datos = {}, extra = {}) => ({ id: `${tipo}-${fecha}-${Math.random()}`, tipo, fecha, datos, dispositivo_ts: `${fecha}T12:00:00Z`, ...extra });

test('hoyLocal usa la fecha LOCAL, no la UTC (23:30 en CDMX sigue siendo el mismo día)', () => {
  const d = new Date('2026-11-18T23:30:00-06:00'); // en UTC ya es 19 de noviembre
  assert.equal(d.toISOString().slice(0, 10), '2026-11-19');
  if ((process.env.TZ || '').includes('Mexico')) assert.equal(hoyLocal(d), '2026-11-18');
  else assert.match(hoyLocal(d), /^2026-11-(18|19)$/); // sin TZ de México la prueba no puede distinguir
});

test('diasEntre y sumarDias cruzan meses y años', () => {
  assert.equal(diasEntre('2026-01-31', '2026-03-01'), 29);
  assert.equal(diasEntre('2025-12-31', '2026-01-01'), 1);
  assert.equal(sumarDias('2026-11-18', 283), '2027-08-28');
  assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
});

test('normArete limpia espacios y pasa a mayúsculas', () => {
  assert.equal(normArete('  ab  12 '), 'AB 12');
  assert.equal(normArete(null), '');
});

test('validarEvento', () => {
  const hoy = '2026-11-18';
  assert.equal(validarEvento({ tipo: 'celo', fecha: hoy }, hoy), null);
  assert.match(validarEvento({ tipo: 'celo', fecha: '2026-11-19' }, hoy), /futura/);
  assert.match(validarEvento({ tipo: 'celo', fecha: '1999-01-01' }, hoy), /antigua/);
  assert.match(validarEvento({ tipo: 'diagnostico', fecha: hoy, datos: {} }, hoy), /resultado/);
  assert.equal(validarEvento({ tipo: 'diagnostico', fecha: hoy, datos: { resultado: 'vacia' } }, hoy), null);
  assert.match(validarEvento({ tipo: 'parto', fecha: hoy, datos: {} }, hoy), /nació/);
  assert.match(validarEvento({ tipo: 'nota', fecha: hoy, datos: { texto: '  ' } }, hoy), /nota/);
  assert.match(validarEvento({ tipo: 'inventado', fecha: hoy }, hoy), /Elige/);
});

test('eventosVigentes excluye anulados y anulaciones', () => {
  const a = ev('inseminacion', '2026-10-01'); a.id = 'a';
  const b = ev('diagnostico', '2026-11-01', { resultado: 'prenada' }); b.id = 'b';
  const an = ev('anulacion', '2026-11-02', {}, { anula_a: 'b' });
  assert.deepEqual(eventosVigentes([a, b, an]).map((e) => e.id), ['a']);
});

test('estado: sin eventos', () => {
  assert.equal(estadoVaca([], '2026-11-18').codigo, 'sin_datos');
});

test('estado: servida, aún no toca diagnóstico y luego sí', () => {
  const evs = [ev('inseminacion', '2026-11-01')];
  const e1 = estadoVaca(evs, '2026-11-18');
  assert.equal(e1.codigo, 'servida');
  assert.equal(e1.dias, 17);
  assert.equal(e1.alerta, false);
  const e2 = estadoVaca(evs, sumarDias('2026-11-01', PARAMS.diasDiagnostico));
  assert.equal(e2.codigo, 'diagnosticar');
  assert.equal(e2.alerta, true);
  assert.equal(tipoSugerido(e2), 'diagnostico');
});

test('estado: gestante, parto esperado y aviso de parto próximo', () => {
  const evs = [ev('inseminacion', '2026-01-10'), ev('diagnostico', '2026-02-12', { resultado: 'prenada' })];
  const g = estadoVaca(evs, '2026-06-01');
  assert.equal(g.codigo, 'gestante');
  assert.equal(g.partoEsperado, sumarDias('2026-01-10', 283));
  const cerca = estadoVaca(evs, sumarDias(g.partoEsperado, -5));
  assert.equal(cerca.codigo, 'parto_proximo');
  assert.equal(tipoSugerido(cerca), 'parto');
});

test('estado: diagnóstico vacía deja la vaca abierta; celo y nuevo servicio la regresan a servida', () => {
  const base = [ev('parto', '2026-01-01', { cria: 'hembra' }), ev('inseminacion', '2026-03-01'), ev('diagnostico', '2026-04-05', { resultado: 'vacia' })];
  const ab = estadoVaca(base, '2026-05-01');
  assert.equal(ab.codigo, 'abierta');
  assert.equal(ab.diasAbiertos, 120);
  const celo = estadoVaca([...base, ev('celo', '2026-05-02')], '2026-05-03');
  assert.equal(celo.codigo, 'celo');
  const servida = estadoVaca([...base, ev('celo', '2026-05-02'), ev('inseminacion', '2026-05-03')], '2026-05-10');
  assert.equal(servida.codigo, 'servida');
});

test('estado: parto reinicia el ciclo; posparto y lista para servicio', () => {
  const evs = [ev('inseminacion', '2026-01-10'), ev('diagnostico', '2026-02-12', { resultado: 'prenada' }), ev('parto', '2026-10-20', { cria: 'macho' })];
  assert.equal(estadoVaca(evs, '2026-11-01').codigo, 'posparto');
  assert.equal(estadoVaca(evs, '2026-12-10').codigo, 'lista');
});

test('estado: diagnóstico anulado no cuenta', () => {
  const dx = ev('diagnostico', '2026-02-12', { resultado: 'prenada' }); dx.id = 'dx';
  const evs = [ev('inseminacion', '2026-01-10'), dx, ev('anulacion', '2026-02-13', {}, { anula_a: 'dx' })];
  // sin el diagnóstico anulado, la vaca sigue servida y ya pasaron 50 días: toca diagnosticar (no 'gestante')
  assert.equal(estadoVaca(evs, '2026-03-01').codigo, 'diagnosticar');
});

test('estado: descarte y celo en gestante', () => {
  const g = [ev('inseminacion', '2026-01-10'), ev('diagnostico', '2026-02-12', { resultado: 'prenada' })];
  assert.equal(estadoVaca([...g, ev('celo', '2026-03-01')], '2026-03-02').codigo, 'gestante'); // un celo en gestante no cambia el estado
  assert.equal(estadoVaca([...g, ev('descarte', '2026-03-01')], '2026-03-02').codigo, 'descartada');
});
