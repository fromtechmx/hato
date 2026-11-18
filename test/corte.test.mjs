import test from 'node:test';
import assert from 'node:assert/strict';
import { acumuladoCiclo, cortesAlrededor, textoFalta, textoCorte, resumenCorte, necesidadSemana } from '../app/lib.js';

const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
// 2026-11-18 es miércoles
test('cortes: miércoles 18:00, estando en miércoles 13:52', () => {
  const { ultimo, proximo } = cortesAlrededor(L(2026, 11, 18, 13, 52), 3, 18);
  assert.equal(ultimo.getTime(), L(2026, 11, 11, 18).getTime());
  assert.equal(proximo.getTime(), L(2026, 11, 18, 18).getTime());
});
test('cortes: justo en el instante del corte, ese corte ya pasó', () => {
  const { ultimo, proximo } = cortesAlrededor(L(2026, 11, 18, 18, 0), 3, 18);
  assert.equal(ultimo.getTime(), L(2026, 11, 18, 18).getTime());
  assert.equal(proximo.getTime(), L(2026, 11, 25, 18).getTime());
});
test('cortes: un minuto antes todavía es el corte de hoy', () => {
  const { proximo } = cortesAlrededor(L(2026, 11, 18, 17, 59), 3, 18);
  assert.equal(proximo.getTime(), L(2026, 11, 18, 18).getTime());
});
test('cortes: día posterior en la semana y cruce de mes', () => {
  const { ultimo, proximo } = cortesAlrededor(L(2026, 11, 29, 10), 5, 9); // domingo; corte viernes 9h
  assert.equal(ultimo.getTime(), L(2026, 11, 27, 9).getTime());
  assert.equal(proximo.getTime(), L(2026, 12, 4, 9).getTime());
});
test('cortes: domingo (0) corta el domingo siguiente', () => {
  const { ultimo, proximo } = cortesAlrededor(L(2026, 11, 18, 12), 0, 8);
  assert.equal(ultimo.getTime(), L(2026, 11, 15, 8).getTime());
  assert.equal(proximo.getTime(), L(2026, 11, 22, 8).getTime());
});
test('texto de falta y de corte', () => {
  assert.equal(textoFalta(L(2026, 11, 16, 14), L(2026, 11, 18, 18)), 'faltan 2 días 4 h');
  assert.equal(textoFalta(L(2026, 11, 17, 18), L(2026, 11, 18, 18)), 'faltan 1 día');
  assert.equal(textoFalta(L(2026, 11, 18, 13, 52), L(2026, 11, 18, 18)), 'faltan 4 h');
  assert.equal(textoFalta(L(2026, 11, 18, 17, 40), L(2026, 11, 18, 18)), 'falta menos de 1 h');
  assert.equal(textoCorte(3, 18), 'miércoles 18:00');
  assert.equal(textoCorte(0, 8), 'domingo 08:00');
});
test('resumenCorte separa rezagadas (antes del último corte) de nuevas', () => {
  const ahora = L(2026, 11, 18, 13);
  const s = [
    { estado: 'pendiente', creado_en: L(2026, 11, 11, 17, 59).toISOString() }, // rezagada
    { estado: 'pendiente', creado_en: L(2026, 11, 11, 18, 0).toISOString() },  // justo en el corte → nueva
    { estado: 'pendiente', creado_en: L(2026, 11, 17, 9).toISOString() },
    { estado: 'consolidada', creado_en: L(2026, 11, 1, 9).toISOString() },
  ];
  const r = resumenCorte(s, ahora, 3, 18);
  assert.equal(r.rezagadas, 1);
  assert.equal(r.nuevas, 2);
});

// ---- necesidadSemana ----
const hoy = '2026-11-18';
const A = (id) => ({ id });
const ev = (animal_id, tipo, fecha, datos = {}) => ({ id: `${animal_id}-${tipo}-${fecha}`, animal_id, tipo, fecha, datos, anulado: false });
test('necesidadSemana: cuenta vacas por servir y por diagnosticar con factor y redondea hacia arriba', () => {
  const animales = ['celo', 'lista', 'abierta', 'posp_pronto', 'posp_lejos', 'dx_ya', 'dx_pronto', 'dx_lejos', 'gest', 'sin', 'pp_borde', 'pp_fuera', 'dx_borde', 'dx_fuera'].map(A);
  const eventos = [
    ev('celo', 'parto', '2026-06-01'), ev('celo', 'celo', '2026-11-17'),
    ev('lista', 'parto', '2026-09-01'),
    ev('abierta', 'parto', '2026-05-01'), ev('abierta', 'diagnostico', '2026-10-01', { resultado: 'vacia' }),
    ev('posp_pronto', 'parto', '2026-10-10'),   // 39 días → 45-39=6 ≤ 7 → entra
    ev('posp_lejos', 'parto', '2026-11-10'),    // 8 días → no
    ev('dx_ya', 'inseminacion', '2026-10-10'),  // 39 días ≥ 30 → toca
    ev('dx_pronto', 'inseminacion', '2026-10-25'), // 24 días → 30-24=6 ≤ 7 → entra
    ev('dx_lejos', 'inseminacion', '2026-11-10'),  // 8 días → no
    ev('pp_borde', 'parto', '2026-10-11'),  // 38 días → faltan exactamente 7 → entra
    ev('pp_fuera', 'parto', '2026-10-12'),  // 37 días → faltan 8 → no
    ev('dx_borde', 'inseminacion', '2026-10-26'), // 23 días → faltan 7 → entra
    ev('dx_fuera', 'inseminacion', '2026-10-27'), // 22 días → faltan 8 → no
    ev('gest', 'inseminacion', '2026-03-01'), ev('gest', 'diagnostico', '2026-04-05', { resultado: 'prenada' }),
  ];
  const insumos = [
    { id: 'pajillas', nombre: 'Pajillas', unidad: 'pajilla', estimar_base: 'servicio', estimar_factor: '1.5' },
    { id: 'pruebas', nombre: 'Pruebas', unidad: 'caja', estimar_base: 'diagnostico', estimar_factor: '1' },
    { id: 'guantes', nombre: 'Guantes', unidad: 'caja', estimar_base: 'ninguna', estimar_factor: '3' },
    { id: 'cero', nombre: 'Cero', unidad: 'x', estimar_base: 'servicio', estimar_factor: '0' },
  ];
  const r = necesidadSemana(animales, eventos, hoy, insumos, new Map([['pajillas', 3]]));
  const por = Object.fromEntries(r.map((x) => [x.insumo_id, x]));
  assert.deepEqual(Object.keys(por).sort(), ['pajillas', 'pruebas']);
  assert.equal(por.pajillas.vacas, 5);          // celo, lista, abierta, posp_pronto, pp_borde
  assert.equal(por.pajillas.sugerida, 8);        // ceil(5 × 1.5)
  assert.equal(por.pajillas.ya, 3);
  assert.equal(por.pajillas.faltante, 5);
  assert.equal(por.pruebas.vacas, 3);            // dx_ya, dx_pronto, dx_borde
  assert.equal(por.pruebas.sugerida, 3);
});
test('necesidadSemana: redondeo hacia arriba y faltante nunca negativo', () => {
  const animales = [A('a')];
  const eventos = [ev('a', 'parto', '2026-06-01'), ev('a', 'celo', '2026-11-17')];
  const insumos = [{ id: 'p', nombre: 'P', unidad: 'u', estimar_base: 'servicio', estimar_factor: '1.2' }];
  const r = necesidadSemana(animales, eventos, hoy, insumos, new Map([['p', 10]]));
  assert.equal(r[0].sugerida, 2);
  assert.equal(r[0].faltante, 0);
});
test('necesidadSemana: sin vacas elegibles no sugiere nada', () => {
  const r = necesidadSemana([A('a')], [ev('a', 'inseminacion', '2026-03-01'), ev('a', 'diagnostico', '2026-04-05', { resultado: 'prenada' })], hoy, [{ id: 'p', nombre: 'P', unidad: 'u', estimar_base: 'servicio', estimar_factor: '2' }]);
  assert.deepEqual(r, []);
});

test('acumuladoCiclo: suma desde el último corte, incluye consolidadas, excluye canceladas y anteriores', () => {
  const ahora = L(2026, 11, 18, 13);
  const s = [
    { insumo_id: 'p', cantidad: 10, estado: 'pendiente', creado_en: L(2026, 11, 17, 9).toISOString() },
    { insumo_id: 'p', cantidad: 5, estado: 'consolidada', creado_en: L(2026, 11, 12, 9).toISOString() },
    { insumo_id: 'p', cantidad: 100, estado: 'cancelada', creado_en: L(2026, 11, 17, 9).toISOString() },
    { insumo_id: 'p', cantidad: 50, estado: 'consolidada', creado_en: L(2026, 11, 11, 17, 59).toISOString() }, // ciclo anterior
    { insumo_id: 'p', cantidad: 1, estado: 'pendiente', creado_en: L(2026, 11, 11, 18, 0).toISOString() },     // justo en el corte → ciclo actual
    { insumo_id: 'g', cantidad: 2, estado: 'pendiente', creado_en: L(2026, 11, 18, 8).toISOString() },
  ];
  const r = acumuladoCiclo(s, ahora, 3, 18);
  assert.equal(r.get('p'), 16);
  assert.equal(r.get('g'), 2);
  // pasado el corte de hoy, el ciclo se reinicia
  const despues = acumuladoCiclo(s, L(2026, 11, 18, 18, 1), 3, 18);
  assert.equal(despues.size, 0);
});
