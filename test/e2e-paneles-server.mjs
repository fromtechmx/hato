// Servidor E2E de los paneles (veterinario, insumos, asociación). Supabase SIMULADO.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { MockSupabase } from './mock-supabase.mjs';

const APP = path.resolve(new URL('../app', import.meta.url).pathname);
const mock = new MockSupabase();
const COOP = 'Coop Sintética';
const vet = mock.crearUsuario('vet@test.invalid', 'clave-de-prueba');
const ganadero = mock.crearUsuario('ganadero@test.invalid', 'clave-de-prueba');
const vaquero = mock.crearUsuario('vaquero@test.invalid', 'clave-de-prueba');
const admin = mock.crearUsuario('admin@test.invalid', 'clave-de-prueba');

const rVisita = mock.crearRancho({ cooperativa: COOP, socio: 'S1', rancho: 'Rancho La Visita' });
const rLlamar = mock.crearRancho({ cooperativa: COOP, socio: 'S2', rancho: 'Rancho El Llamar' });
const rViejo = mock.crearRancho({ cooperativa: COOP, socio: 'S3', rancho: 'Rancho Sin Datos' });
const rCalma = mock.crearRancho({ cooperativa: COOP, socio: 'S4', rancho: 'Rancho Tranquilo' });
const rGan = mock.crearRancho({ cooperativa: COOP, socio: 'S5', rancho: 'Rancho Del Ganadero' });
for (const r of [rVisita, rLlamar, rViejo, rCalma]) mock.vincular(vet, r, 'mvz');
mock.vincular(ganadero, rGan, 'dueno');
mock.vincular(vaquero, rGan, 'vaquero');
mock.administrar(admin, COOP);

const hace = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const ts = (dias) => new Date(Date.now() - dias * 86400000 - 3600000).toISOString().replace(/\.(\d{3})Z$/, '.$1123+00:00');
let n = 0;
function vaca(r, rec, evs) {
  const a = { id: crypto.randomUUID(), rancho_id: r.id, arete: String(100 + ++n), nombre: null, fecha_nacimiento: null, creado_por: vet.id, dispositivo_ts: null, recibido_en: ts(rec) };
  mock.animales.push(a);
  for (const [tipo, off, datos] of evs) mock.eventos.push({ id: crypto.randomUUID(), rancho_id: r.id, animal_id: a.id, tipo, fecha: hace(off), datos: datos || {}, canal: 'app', anula_a: null, creado_por: vet.id, dispositivo_ts: null, recibido_en: ts(rec) });
}
const gest = [['inseminacion', 100], ['diagnostico', 60, { resultado: 'prenada' }]];
for (let i = 0; i < 6; i++) vaca(rVisita, 0, [['inseminacion', 40]]);
vaca(rLlamar, 0, [['parto', 70], ['celo', 3]]);
for (let i = 0; i < 3; i++) vaca(rLlamar, 0, gest);
for (let i = 0; i < 3; i++) vaca(rViejo, 20, gest);
for (let i = 0; i < 3; i++) vaca(rCalma, 0, gest);

const pajillas = mock.crearInsumo(COOP, 'Pajillas de semen', 'pajilla');
const guantes = mock.crearInsumo(COOP, 'Guantes de palpación', 'caja');
const sol = (r, i, c) => mock.solicitudes.push({ id: crypto.randomUUID(), rancho_id: r.id, insumo_id: i.id, cantidad: c, nota: null, estado: 'pendiente', orden_id: null, creado_por: vet.id, creado_en: mock.marca() });
sol(rVisita, pajillas, 40); sol(rLlamar, pajillas, 25); sol(rLlamar, guantes, 3); sol(rCalma, guantes, 2);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'apikey, authorization, content-type, prefer, x-client-info', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); return res.end("window.HATO_CONFIG={url:'http://127.0.0.1:4174',key:'sb_publishable_test'};"); }
  const f = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(APP, f);
  if (!full.startsWith(APP) || !fs.existsSync(full)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}).listen(4173, '127.0.0.1');
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const partes = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => { const out = mock.handle(req.method, req.url, req.headers, Buffer.concat(partes).toString()); res.writeHead(out.status, { ...CORS, 'content-type': 'application/json' }); res.end(out.body); });
}).listen(4174, '127.0.0.1');
http.createServer((req, res) => {
  res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
  const nomI = (id) => mock.insumos.find((i) => i.id === id).nombre;
  const nomR = (id) => mock.ranchos.find((r) => r.id === id).nombre;
  res.end(JSON.stringify({ solicitudes: mock.solicitudes.map((s) => ({ rancho: nomR(s.rancho_id), insumo: nomI(s.insumo_id), cantidad: s.cantidad, estado: s.estado, orden: !!s.orden_id })), ordenes: mock.ordenes.map((o) => ({ destinatario: o.destinatario, tipo: o.destinatario_tipo, estado: o.estado })), insumos: mock.insumos.map((i) => i.nombre) }));
}).listen(4175, '127.0.0.1');
console.log('listo');
