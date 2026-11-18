// Servidor de pruebas de punta a punta: sirve la app (puerto 4173) y un Supabase SIMULADO con CORS (puerto 4174).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { MockSupabase } from './mock-supabase.mjs';

const APP = path.resolve(new URL('..', import.meta.url).pathname);
const mock = new MockSupabase();
const u = mock.crearUsuario('vaquero@test.invalid', 'clave-de-prueba');
const r1 = mock.crearRancho({ cooperativa: 'Coop Sintética', socio: 'Socio Uno', rancho: 'Rancho El Prueba' });
const r2 = mock.crearRancho({ cooperativa: 'Coop Sintética', socio: 'Socio Dos', rancho: 'Rancho Ajeno' });
mock.vincular(u, r1, 'dueno');
// Datos sintéticos
const v1 = { id: crypto.randomUUID(), rancho_id: r1.id, arete: '101', nombre: null, fecha_nacimiento: null, creado_por: u.id, dispositivo_ts: null, recibido_en: mock.marca() };
const v2 = { id: crypto.randomUUID(), rancho_id: r1.id, arete: '202', nombre: null, fecha_nacimiento: null, creado_por: u.id, dispositivo_ts: null, recibido_en: mock.marca() };
const ajena = { id: crypto.randomUUID(), rancho_id: r2.id, arete: '999', nombre: null, fecha_nacimiento: null, creado_por: u.id, dispositivo_ts: null, recibido_en: mock.marca() };
mock.animales.push(v1, v2, ajena);
const hace = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
mock.eventos.push({ id: crypto.randomUUID(), rancho_id: r1.id, animal_id: v1.id, tipo: 'inseminacion', fecha: hace(35), datos: { toro: 'T-5' }, canal: 'app', anula_a: null, creado_por: u.id, dispositivo_ts: null, recibido_en: mock.marca() });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'apikey, authorization, content-type, prefer, x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    return res.end("window.HATO_CONFIG={url:'http://127.0.0.1:4174',key:'sb_publishable_test'};");
  }
  let f = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(APP, f);
  if (!full.startsWith(APP) || !fs.existsSync(full)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}).listen(4173, '127.0.0.1');

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const partes = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => {
    const out = mock.handle(req.method, req.url, req.headers, Buffer.concat(partes).toString());
    res.writeHead(out.status, { ...CORS, 'content-type': 'application/json' });
    res.end(out.body);
  });
}).listen(4174, '127.0.0.1');

// Endpoint de inspección para la prueba (no existe en Supabase real)
http.createServer((req, res) => {
  res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ animales: mock.animales.map((a) => ({ arete: a.arete, rancho: a.rancho_id === r1.id ? 'R1' : 'R2' })), eventos: mock.eventos.map((e) => ({ tipo: e.tipo, fecha: e.fecha, datos: e.datos, anula_a: e.anula_a })) }));
}).listen(4175, '127.0.0.1');

console.log('listo');
