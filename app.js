// HATO · app. Pantallas y flujo. Todo se guarda primero en el teléfono; se envía cuando hay conexión.

import { PARAMS, TIPOS, textoTipo, uuid, hoyLocal, sumarDias, fechaCorta, normArete, validarEvento, eventosVigentes, estadoVaca, tipoSugerido, ordenarTipos } from './lib.js';
import { openIdbStore } from './store.js';
import { createApi } from './api.js';
import { createSync } from './sync.js';

const cfg = window.HATO_CONFIG;
const api = createApi({ url: cfg.url, key: cfg.key, storage: window.localStorage });
const $app = document.getElementById('app');

let store = null;
let sync = null;
let user = null;

const S = {
  vista: 'inicio',
  ranchos: [],
  rancho: null,
  animales: [],
  eventos: [],
  estados: new Map(),
  pend: { animales: 0, eventos: 0, total: 0, conError: 0 },
  ultima: null,
  sincronizando: false,
  reg: null,
  fichaId: null,
  filtro: '',
  aviso: null,
  loginError: null,
  loginEmail: '',
  cargando: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Datos ----------

async function refrescar() {
  if (!store) return;
  const ranchoId = S.rancho ? S.rancho.id : null;
  const animales = (await store.all('animales')).filter((a) => a.rancho_id === ranchoId);
  const eventos = (await store.all('eventos')).filter((e) => e.rancho_id === ranchoId);
  S.animales = animales;
  S.eventos = eventos;
  const hoy = hoyLocal();
  const porVaca = new Map();
  for (const e of eventos) {
    if (!porVaca.has(e.animal_id)) porVaca.set(e.animal_id, []);
    porVaca.get(e.animal_id).push(e);
  }
  S.estados = new Map(animales.map((a) => [a.id, estadoVaca(porVaca.get(a.id) || [], hoy)]));
  S.pend = await sync.contarPendientes();
  S.ultima = (await store.getMeta('ultimaSync')) || null;
}

async function sincronizarYRefrescar(manual = false) {
  if (!sync || S.sincronizando) return null;
  S.sincronizando = true;
  actualizarChip();
  let res = null;
  try {
    res = await sync.sincronizar();
    // Si cambió la lista de ranchos, se actualiza.
    S.ranchos = (await store.getMeta('ranchos')) || [];
    if (S.rancho && !S.ranchos.find((r) => r.id === S.rancho.id)) S.rancho = S.ranchos[0] || null;
    if (!S.rancho && S.ranchos.length) S.rancho = S.ranchos[0];
  } finally {
    S.sincronizando = false;
  }
  await refrescar();
  if (S.vista === 'registro' && S.reg && S.reg.paso >= 1) actualizarChip();
  else render();
  if (manual && res) mostrarResultado(res);
  return res;
}

function mostrarResultado(res) {
  if (res.sesionVencida) toast('Tu sesión venció. Entra de nuevo para enviar.');
  else if (res.sinConexion) toast('Sin conexión. Tus registros siguen guardados en el teléfono.');
  else if (res.error) toast(`No se pudo sincronizar: ${res.error}`);
  else if (res.rechazados) toast(`${res.rechazados} registro(s) fueron rechazados. Revísalos en "Por enviar".`);
  else toast(S.pend.total ? 'Falta enviar algunos registros.' : '✓ Todo enviado');
}

// ---------- Utilidades de pantalla ----------

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

function hace(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

function chipInfo() {
  if (S.sincronizando) return { cls: '', texto: 'Enviando…' };
  if (S.pend.conError) return { cls: 'mal', texto: `⚠ ${S.pend.conError} con problema` };
  if (S.pend.total > 0) return { cls: 'warn', texto: `⏳ ${S.pend.total} por enviar` };
  if (S.ultima && S.ultima.ok) return { cls: '', texto: '✓ Todo enviado' };
  if (S.ultima && !S.ultima.ok) return { cls: 'warn', texto: 'Sin conexión' };
  return { cls: 'warn', texto: 'Sin sincronizar' };
}

function actualizarChip() {
  const b = document.getElementById('chip');
  if (!b) return;
  const c = chipInfo();
  b.className = `chip-sync ${c.cls}`;
  b.textContent = c.texto;
}

function cabecera() {
  const c = chipInfo();
  const selector = S.ranchos.length > 1
    ? `<select id="selRancho" aria-label="Rancho">${S.ranchos.map((r) => `<option value="${esc(r.id)}" ${S.rancho && S.rancho.id === r.id ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select>`
    : `<span>${esc(S.rancho ? S.rancho.nombre : '')}</span>`;
  return `<header class="top"><span class="marca">HATO</span><div class="rancho">${selector}</div><button class="chip-sync ${c.cls}" id="chip" data-accion="ir" data-vista="pendientes">${esc(c.texto)}</button></header>`;
}

function avisoSesion() {
  const s = api.getSession();
  if (s && s.expired) return `<div class="aviso warn">Tu sesión venció. Puedes seguir registrando, pero para enviar hay que entrar de nuevo. <button class="btn chico" data-accion="reingresar" style="margin-top:8px">Entrar de nuevo</button></div>`;
  return '';
}

function estadoChip(est) {
  const cls = est.alerta ? 'alerta' : est.codigo === 'descartada' || est.codigo === 'sin_datos' || est.codigo === 'sin_estado' ? 'gris' : '';
  return `<span class="estado ${cls}">${esc(est.texto)}</span>`;
}

function marco(contenido) {
  return `${cabecera()}<main>${avisoSesion()}${S.aviso ? `<div class="aviso info">${esc(S.aviso)}</div>` : ''}${contenido}</main>`;
}

// ---------- Vistas ----------

function vistaLogin() {
  return `<main style="padding-top:40px">
    <h1 style="font-size:34px;letter-spacing:.08em;color:var(--verde-osc)">HATO</h1>
    <p class="suave">Seguimiento reproductivo del hato.</p>
    ${S.loginError ? `<div class="aviso mal">${esc(S.loginError)}</div>` : ''}
    <form id="formLogin" autocomplete="on">
      <label for="email">Correo</label>
      <input id="email" type="email" inputmode="email" autocomplete="username" required value="${esc(S.loginEmail)}">
      <label for="pass">Contraseña</label>
      <input id="pass" type="password" autocomplete="current-password" required>
      <button class="btn primario" id="btnLogin" type="submit" style="margin-top:18px">Entrar</button>
    </form>
    <p class="pie">Para entrar por primera vez necesitas internet.<br>Después podrás registrar sin conexión.</p>
  </main>`;
}

function vistaInicio() {
  if (!S.rancho) {
    return marco(`<div class="card"><h2>Aún no tienes un rancho asignado</h2><p>Pide a tu cooperativa o a quien administra HATO que vincule tu cuenta (<b>${esc(user ? user.email : '')}</b>) a un rancho. Luego toca el botón de arriba para actualizar.</p><button class="btn primario" data-accion="sync">Actualizar ahora</button></div>${pie()}`);
  }
  const porAtender = [...S.estados.values()].filter((e) => e.alerta).length;
  const info = [S.rancho.socio, S.rancho.cooperativa].filter(Boolean).join(' · ');
  return marco(`
    ${info ? `<p class="suave" style="margin:0 0 10px">${esc(info)}</p>` : ''}
    <button class="btn primario" style="min-height:76px;font-size:22px" data-accion="registrar">➕ Registrar evento</button>
    <div class="grid" style="margin-top:12px">
      <button class="btn tile" data-accion="ir" data-vista="atender"><b>${porAtender}</b><span>Por atender</span></button>
      <button class="btn tile" data-accion="ir" data-vista="vacas"><b>${S.animales.length}</b><span>Mis vacas</span></button>
    </div>
    <button class="btn" style="margin-top:12px" data-accion="ir" data-vista="pendientes">${S.pend.total ? `⏳ ${S.pend.total} por enviar` : '✓ Todo enviado'} · ver detalle</button>
    ${pie()}`);
}

function pie() {
  return `<p class="pie">${esc(user ? user.email : '')}<br><button class="atras" data-accion="salir">Cerrar sesión</button><br>HATO · by FROM TECH 4D</p>`;
}

function vistaVacas() {
  const q = normArete(S.filtro);
  let lista = S.animales.filter((a) => !q || a.arete.includes(q));
  lista = lista.sort((a, b) => S.estados.get(a.id).prioridad - S.estados.get(b.id).prioridad || a.arete.localeCompare(b.arete, 'es', { numeric: true }));
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Mis vacas (${S.animales.length})</h2>
    <input type="text" id="filtro" placeholder="Buscar por arete" autocomplete="off" autocapitalize="characters" value="${esc(S.filtro)}">
    <div id="lista" style="margin-top:12px">${listaVacas(lista)}</div>`);
}

function listaVacas(lista) {
  if (!lista.length) return `<p class="suave">No hay vacas${S.filtro ? ' con ese arete' : ' registradas todavía'}.</p>`;
  return lista.map((a) => {
    const est = S.estados.get(a.id);
    return `<button class="vaca" data-accion="ficha" data-id="${esc(a.id)}"><div class="fila"><span class="arete">${esc(a.arete)}</span>${estadoChip(est)}</div>${est.detalle ? `<div class="suave">${esc(est.detalle)}</div>` : ''}${a._sync !== 'ok' ? '<span class="badge pend">⏳ por enviar</span>' : ''}</button>`;
  }).join('');
}

function vistaAtender() {
  const lista = S.animales.filter((a) => S.estados.get(a.id).alerta).sort((a, b) => S.estados.get(a.id).prioridad - S.estados.get(b.id).prioridad || a.arete.localeCompare(b.arete, 'es', { numeric: true }));
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Por atender (${lista.length})</h2>
    ${lista.length ? listaVacas(lista) : '<p class="suave">Nada por atender según los registros. 🎉</p>'}
    <p class="suave">Los avisos salen de reglas sencillas (por ejemplo, diagnóstico a los ${PARAMS.diasDiagnostico} días del servicio). Valídalas con tu veterinario.</p>`);
}

function detalleEvento(e) {
  const d = e.datos || {};
  const partes = [];
  if (d.resultado) partes.push({ prenada: 'Gestante', vacia: 'Vacía', dudosa: 'Dudosa' }[d.resultado] || d.resultado);
  if (d.cria) partes.push({ hembra: 'Hembra', macho: 'Macho', mellizos: 'Mellizos', nacio_muerta: 'Nació muerta' }[d.cria] || d.cria);
  if (d.toro) partes.push(`Toro/pajilla: ${d.toro}`);
  if (d.motivo) partes.push(`Motivo: ${d.motivo}`);
  if (d.descripcion) partes.push(d.descripcion);
  if (d.texto) partes.push(d.texto);
  return partes.join(' · ');
}

function badgeSync(o) {
  if (o._sync === 'ok') return '<span class="badge ok">✓ enviado</span>';
  if (o._sync === 'error') return `<span class="badge err">⚠ ${esc(o._error || 'problema')}</span>`;
  return '<span class="badge pend">⏳ por enviar</span>';
}

function vistaFicha() {
  const a = S.animales.find((x) => x.id === S.fichaId);
  if (!a) return marco(`<button class="atras" data-accion="ir" data-vista="vacas">‹ Mis vacas</button><p>No se encontró la vaca.</p>`);
  const est = S.estados.get(a.id);
  const todos = S.eventos.filter((e) => e.animal_id === a.id);
  const anulados = new Set(todos.filter((e) => e.tipo === 'anulacion' && e.anula_a).map((e) => e.anula_a));
  const historial = todos.filter((e) => e.tipo !== 'anulacion').sort((x, y) => (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : String(y.dispositivo_ts || '').localeCompare(String(x.dispositivo_ts || ''))));
  const filas = historial.map((e) => {
    const anulado = anulados.has(e.id);
    const mio = user && e.creado_por === user.id;
    const puedeAnular = !anulado && (mio || e._sync !== 'ok');
    const t = TIPOS.find((x) => x.id === e.tipo);
    return `<div class="ev ${anulado ? 'anulado' : ''}">
      <div class="fila"><b>${t ? t.icono : ''} ${esc(textoTipo(e.tipo))}</b><span class="suave">${esc(fechaCorta(e.fecha))}</span></div>
      ${detalleEvento(e) ? `<div class="suave">${esc(detalleEvento(e))}</div>` : ''}
      <div style="margin-top:4px">${badgeSync(e)} ${anulado ? '<span class="badge err">anulado</span>' : ''}</div>
      ${puedeAnular ? `<button class="btn chico peligro" style="margin-top:8px" data-accion="anular" data-id="${esc(e.id)}">Deshacer</button>` : ''}
    </div>`;
  }).join('');
  return marco(`
    <button class="atras" data-accion="ir" data-vista="vacas">‹ Mis vacas</button>
    <div class="card">
      <div class="fila"><h2 style="margin:0">Vaca ${esc(a.arete)}</h2>${badgeSync(a)}</div>
      <p style="margin:10px 0 4px">${estadoChip(est)}</p>
      ${est.detalle ? `<p class="suave" style="margin:0">${esc(est.detalle)}</p>` : ''}
      ${est.diasAbiertos !== null && est.codigo !== 'gestante' && est.codigo !== 'parto_proximo' ? `<p class="suave" style="margin:4px 0 0">Días abiertos: ${est.diasAbiertos}</p>` : ''}
    </div>
    <button class="btn primario" data-accion="registrar" data-id="${esc(a.id)}">➕ Registrar evento a esta vaca</button>
    <div class="card"><h2 style="font-size:18px">Historial</h2>${filas || '<p class="suave">Sin registros todavía.</p>'}</div>`);
}

function vistaRegistro() {
  const r = S.reg;
  const hoy = hoyLocal();
  if (r.paso === 1) {
    return marco(`
      <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
      <h2>¿Qué vaca?</h2>
      ${r.mensaje ? `<div class="aviso info">${esc(r.mensaje)}</div>` : ''}
      <input type="text" id="arete" placeholder="Número de arete" autocomplete="off" autocapitalize="characters" value="${esc(r.arete)}">
      <div id="resultados" style="margin-top:12px"></div>`);
  }
  const a = S.animales.find((x) => x.id === r.animalId);
  const est = a ? S.estados.get(a.id) : null;
  const cabeceraVaca = a ? `<div class="card"><div class="fila"><b style="font-size:22px">Vaca ${esc(a.arete)}</b>${est ? estadoChip(est) : ''}</div>${est && est.detalle ? `<div class="suave">${esc(est.detalle)}</div>` : ''}</div>` : '';
  if (r.paso === 2) {
    const sug = est ? tipoSugerido(est) : null;
    const tipos = ordenarTipos(sug);
    return marco(`
      <button class="atras" data-accion="reg-atras">‹ Cambiar vaca</button>
      ${cabeceraVaca}
      <h2>¿Qué pasó?</h2>
      <div class="grid">${tipos.map((t) => `<button class="btn ${t.id === sug ? 'primario' : ''}" data-accion="tipo" data-tipo="${t.id}"><span class="ico">${t.icono}</span>${esc(t.texto)}${t.id === sug ? '<span class="suave" style="color:inherit;font-size:13px">sugerido</span>' : ''}</button>`).join('')}</div>`);
  }
  const tipo = r.tipo;
  const t = TIPOS.find((x) => x.id === tipo);
  const op = (campo, valor, texto) => `<button class="btn ${r.datos[campo] === valor ? 'sel' : ''}" data-accion="op" data-campo="${campo}" data-valor="${valor}">${texto}</button>`;
  let campos = '';
  if (tipo === 'inseminacion' || tipo === 'monta') campos = `<label for="d_toro">Toro o pajilla (opcional)</label><input type="text" id="d_toro" autocomplete="off" value="${esc(r.datos.toro || '')}">`;
  else if (tipo === 'diagnostico') campos = `<label>Resultado</label>${op('resultado', 'prenada', 'Gestante')}${op('resultado', 'vacia', 'Vacía')}${op('resultado', 'dudosa', 'Dudosa')}`;
  else if (tipo === 'parto') campos = `<label>¿Qué nació?</label>${op('cria', 'hembra', 'Hembra')}${op('cria', 'macho', 'Macho')}${op('cria', 'mellizos', 'Mellizos')}${op('cria', 'nacio_muerta', 'Nació muerta')}`;
  else if (tipo === 'secado' || tipo === 'descarte') campos = `<label for="d_motivo">Motivo (opcional)</label><input type="text" id="d_motivo" autocomplete="off" value="${esc(r.datos.motivo || '')}">`;
  else if (tipo === 'tratamiento') campos = `<label for="d_desc">¿Qué tratamiento?</label><textarea id="d_desc">${esc(r.datos.descripcion || '')}</textarea>`;
  else if (tipo === 'nota') campos = `<label for="d_texto">Nota</label><textarea id="d_texto">${esc(r.datos.texto || '')}</textarea>`;
  return marco(`
    <button class="atras" data-accion="reg-atras">‹ Cambiar tipo</button>
    ${cabeceraVaca}
    <h2>${t ? t.icono : ''} ${esc(t ? t.texto : '')}</h2>
    ${r.error ? `<div class="aviso mal">${esc(r.error)}</div>` : ''}
    ${campos}
    <label for="fecha">Fecha</label>
    <div class="fila" style="gap:8px;margin-bottom:8px"><button class="btn chico" data-accion="fecha-rapida" data-dias="0">Hoy</button><button class="btn chico" data-accion="fecha-rapida" data-dias="-1">Ayer</button></div>
    <input type="date" id="fecha" value="${esc(r.fecha)}" max="${esc(hoy)}" min="2000-01-01">
    <button class="btn primario" style="margin-top:18px" data-accion="guardar">Guardar</button>`);
}

function vistaPendientes() {
  const items = [];
  for (const a of S.animales) if (a._sync !== 'ok') items.push({ tipo: 'animal', obj: a, texto: `Vaca nueva ${a.arete}` });
  for (const e of S.eventos) if (e._sync !== 'ok') {
    const a = S.animales.find((x) => x.id === e.animal_id);
    items.push({ tipo: 'evento', obj: e, texto: `${textoTipo(e.tipo)} · vaca ${a ? a.arete : '?'} · ${fechaCorta(e.fecha)}` });
  }
  const u = S.ultima;
  const ultima = u ? `${u.ok ? 'Última sincronización correcta' : 'Último intento sin éxito'} ${hace(u.ts)}.` : 'Todavía no se ha sincronizado.';
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Por enviar</h2>
    <p class="suave">${esc(ultima)}</p>
    <button class="btn primario" data-accion="sync" ${S.sincronizando ? 'disabled' : ''}>${S.sincronizando ? 'Enviando…' : 'Enviar ahora'}</button>
    ${items.length ? items.map((it) => `<div class="card"><div><b>${esc(it.texto)}</b></div><div style="margin:6px 0">${badgeSync(it.obj)}</div>${it.obj._sync === 'error' ? `<button class="btn chico" data-accion="reintentar" data-tabla="${it.tipo === 'animal' ? 'animales' : 'eventos'}" data-id="${esc(it.obj.id)}">Reintentar</button><button class="btn chico peligro" data-accion="descartar" data-tabla="${it.tipo === 'animal' ? 'animales' : 'eventos'}" data-id="${esc(it.obj.id)}">Descartar</button>` : ''}</div>`).join('') : '<div class="aviso info">✓ Todo lo registrado ya está en el servidor.</div>'}
    <p class="suave">Mientras algo diga "por enviar", vive solo en este teléfono. No borres los datos del navegador ni desinstales la app hasta que todo diga "enviado".</p>`);
}

function render() {
  if (!user) { $app.innerHTML = vistaLogin(); return; }
  if (S.cargando) { $app.innerHTML = `${cabecera()}<main><p class="suave">Descargando tus datos…</p></main>`; return; }
  if (S.vista === 'registro' && S.reg) capturarCampos();
  let html;
  switch (S.vista) {
    case 'vacas': html = vistaVacas(); break;
    case 'atender': html = vistaAtender(); break;
    case 'ficha': html = vistaFicha(); break;
    case 'registro': html = S.rancho ? vistaRegistro() : vistaInicio(); break;
    case 'pendientes': html = vistaPendientes(); break;
    default: html = vistaInicio();
  }
  $app.innerHTML = html;
  if (S.vista === 'registro' && S.reg && S.reg.paso === 1) { pintarResultados(); }
}

function ir(vista) {
  S.vista = vista;
  S.aviso = null;
  if (vista !== 'vacas') S.filtro = '';
  render();
  window.scrollTo(0, 0);
}

// ---------- Registro ----------

function nuevoReg(animalId = null, mensaje = null) {
  return { paso: animalId ? 2 : 1, animalId, arete: '', tipo: null, datos: {}, fecha: hoyLocal(), error: null, mensaje };
}

function capturarCampos() {
  const r = S.reg;
  if (!r) return;
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  if (r.paso === 1) { const v = val('arete'); if (v !== undefined) r.arete = v; }
  if (r.paso === 3) {
    const f = val('fecha'); if (f !== undefined) r.fecha = f;
    const m = { d_toro: 'toro', d_motivo: 'motivo', d_desc: 'descripcion', d_texto: 'texto' };
    for (const [id, k] of Object.entries(m)) { const v = val(id); if (v !== undefined) r.datos[k] = v; }
  }
}

function pintarResultados() {
  const cont = document.getElementById('resultados');
  if (!cont) return;
  const input = document.getElementById('arete');
  const q = normArete(input ? input.value : S.reg.arete);
  if (!q) {
    cont.innerHTML = `<p class="suave">Escribe el número de arete de la vaca.</p>`;
    return;
  }
  const todas = S.animales;
  const exacta = todas.find((a) => a.arete === q);
  const parecidas = todas.filter((a) => a.arete !== q && a.arete.includes(q)).sort((a, b) => a.arete.localeCompare(b.arete, 'es', { numeric: true })).slice(0, 8);
  const botones = [exacta, ...parecidas].filter(Boolean).map((a) => `<button class="vaca" data-accion="elegir" data-id="${esc(a.id)}"><div class="fila"><span class="arete">${esc(a.arete)}</span>${estadoChip(S.estados.get(a.id))}</div></button>`).join('');
  const nueva = !exacta ? `<button class="btn" data-accion="crear-vaca">➕ Vaca nueva: ${esc(q)}</button>` : '';
  cont.innerHTML = botones + nueva;
}

async function crearVaca() {
  capturarCampos();
  const arete = normArete(S.reg.arete);
  if (!arete) return;
  if (arete.length > 30) { toast('El arete es demasiado largo (máximo 30 caracteres).'); return; }
  const existente = S.animales.find((a) => a.arete === arete);
  if (existente) { S.reg.animalId = existente.id; S.reg.paso = 2; render(); return; }
  const a = { id: uuid(), rancho_id: S.rancho.id, arete, nombre: null, fecha_nacimiento: null, dispositivo_ts: new Date().toISOString(), creado_por: user.id, _sync: 'pendiente' };
  await store.put('animales', a);
  await refrescar();
  S.reg.animalId = a.id;
  S.reg.paso = 2;
  render();
}

async function guardarEvento() {
  const r = S.reg;
  capturarCampos();
  const hoy = hoyLocal();
  const limpio = {};
  for (const [k, v] of Object.entries(r.datos)) { const t = typeof v === 'string' ? v.trim() : v; if (t !== '' && t !== undefined && t !== null) limpio[k] = t; }
  const claves = { inseminacion: ['toro'], monta: ['toro'], diagnostico: ['resultado'], parto: ['cria'], secado: ['motivo'], descarte: ['motivo'], tratamiento: ['descripcion'], nota: ['texto'] }[r.tipo] || [];
  const datos = Object.fromEntries(Object.entries(limpio).filter(([k]) => claves.includes(k)));
  const err = validarEvento({ tipo: r.tipo, datos, fecha: r.fecha }, hoy);
  if (err) { r.error = err; render(); return; }
  const vigentes = eventosVigentes(S.eventos.filter((e) => e.animal_id === r.animalId));
  if (vigentes.some((e) => e.tipo === r.tipo && e.fecha === r.fecha)) {
    if (!window.confirm('Ya hay un registro igual para esta vaca y esta fecha. ¿Guardarlo de todos modos?')) return;
  }
  const ev = { id: uuid(), rancho_id: S.rancho.id, animal_id: r.animalId, tipo: r.tipo, fecha: r.fecha, datos, canal: 'app', anula_a: null, creado_por: user.id, dispositivo_ts: new Date().toISOString(), _sync: 'pendiente' };
  await store.put('eventos', ev);
  const a = S.animales.find((x) => x.id === r.animalId);
  S.reg = nuevoReg(null, `✓ Guardado en el teléfono: ${textoTipo(r.tipo)} · vaca ${a ? a.arete : ''}`);
  await refrescar();
  render();
  sincronizarYRefrescar();
}

async function anularEvento(id) {
  const e = S.eventos.find((x) => x.id === id);
  if (!e) return;
  if (!window.confirm('¿Deshacer este registro?')) return;
  if (e._sync !== 'ok') {
    await store.del('eventos', id);
    // Si había una anulación pendiente apuntando a este, se limpia también.
    for (const x of S.eventos) if (x.anula_a === id) await store.del('eventos', x.id);
  } else {
    const an = { id: uuid(), rancho_id: e.rancho_id, animal_id: e.animal_id, tipo: 'anulacion', fecha: hoyLocal(), datos: {}, canal: 'app', anula_a: e.id, creado_por: user.id, dispositivo_ts: new Date().toISOString(), _sync: 'pendiente' };
    await store.put('eventos', an);
  }
  await refrescar();
  render();
  sincronizarYRefrescar();
}

// ---------- Eventos de pantalla ----------

$app.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-accion]');
  if (!el) return;
  const acc = el.dataset.accion;
  switch (acc) {
    case 'ir': ir(el.dataset.vista); break;
    case 'registrar': S.reg = nuevoReg(el.dataset.id || null); S.vista = 'registro'; render(); window.scrollTo(0, 0); break;
    case 'elegir': S.reg.animalId = el.dataset.id; S.reg.paso = 2; render(); break;
    case 'crear-vaca': await crearVaca(); break;
    case 'reg-atras': capturarCampos(); if (S.reg.paso === 3) { S.reg.paso = 2; S.reg.error = null; } else { S.reg = nuevoReg(); } render(); break;
    case 'tipo': S.reg.tipo = el.dataset.tipo; S.reg.datos = {}; S.reg.error = null; S.reg.fecha = hoyLocal(); S.reg.paso = 3; render(); break;
    case 'op': capturarCampos(); S.reg.datos[el.dataset.campo] = el.dataset.valor; render(); break;
    case 'fecha-rapida': { const f = sumarDias(hoyLocal(), Number(el.dataset.dias)); S.reg.fecha = f; const i = document.getElementById('fecha'); if (i) i.value = f; break; }
    case 'guardar': await guardarEvento(); break;
    case 'ficha': S.fichaId = el.dataset.id; ir('ficha'); break;
    case 'anular': await anularEvento(el.dataset.id); break;
    case 'sync': { const res = await sincronizarYRefrescar(true); if (!res) toast('Ya se está enviando.'); break; }
    case 'reintentar': { const o = await store.get(el.dataset.tabla, el.dataset.id); if (o) { await store.put(el.dataset.tabla, { ...o, _sync: 'pendiente', _error: null }); await refrescar(); render(); sincronizarYRefrescar(true); } break; }
    case 'descartar': {
      if (!window.confirm('¿Descartar este registro? Se borrará de este teléfono y no se enviará.')) break;
      await store.del(el.dataset.tabla, el.dataset.id);
      await refrescar(); render(); break;
    }
    case 'reingresar': S.loginEmail = (api.getSession() || { user: {} }).user.email || ''; user = null; render(); break;
    case 'salir': await salir(); break;
    default: break;
  }
});

$app.addEventListener('input', (ev) => {
  if (ev.target.id === 'arete') { S.reg.arete = ev.target.value; pintarResultados(); }
  else if (ev.target.id === 'filtro') {
    S.filtro = ev.target.value;
    const q = normArete(S.filtro);
    const lista = S.animales.filter((a) => !q || a.arete.includes(q)).sort((a, b) => S.estados.get(a.id).prioridad - S.estados.get(b.id).prioridad || a.arete.localeCompare(b.arete, 'es', { numeric: true }));
    document.getElementById('lista').innerHTML = listaVacas(lista);
  }
});

$app.addEventListener('change', async (ev) => {
  if (ev.target.id === 'selRancho') {
    S.rancho = S.ranchos.find((r) => r.id === ev.target.value) || S.rancho;
    await store.setMeta('ranchoActivo', S.rancho.id);
    await refrescar();
    S.reg = null; ir('inicio');
  }
});

$app.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'formLogin') return;
  ev.preventDefault();
  const email = document.getElementById('email').value.trim();
  const pass = document.getElementById('pass').value;
  S.loginEmail = email;
  const btn = document.getElementById('btnLogin');
  btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    const s = await api.login(email, pass);
    S.loginError = null;
    user = s.user;
    await abrirUsuario(true);
  } catch (e) {
    S.loginError = e.network ? 'Sin conexión. Para entrar necesitas internet.' : e.code === 'invalid_credentials' || e.status === 400 ? 'Correo o contraseña incorrectos.' : `No se pudo entrar (${e.message}).`;
    user = null;
    render();
  }
});

async function salir() {
  const pend = S.pend.total;
  const msg = pend ? `Hay ${pend} registro(s) que aún NO se han enviado. Seguirán guardados en este teléfono, pero solo se enviarán cuando vuelvas a entrar con esta misma cuenta. ¿Cerrar sesión?` : '¿Cerrar sesión?';
  if (!window.confirm(msg)) return;
  await api.logout();
  if (store) store.close();
  store = null; sync = null; user = null;
  S.rancho = null; S.ranchos = []; S.animales = []; S.eventos = []; S.reg = null; S.vista = 'inicio';
  render();
}

// ---------- Arranque ----------

async function abrirUsuario(primeraVez = false) {
  if (store) store.close();
  store = await openIdbStore(user.id);
  sync = createSync({ store, api });
  S.ranchos = (await store.getMeta('ranchos')) || [];
  const activo = await store.getMeta('ranchoActivo');
  S.rancho = S.ranchos.find((r) => r.id === activo) || S.ranchos[0] || null;
  S.vista = 'inicio';
  S.reg = null;
  await refrescar();
  render();
  if (primeraVez) {
    S.cargando = true;
    render();
    await sincronizarYRefrescar();
    S.cargando = false;
    if (S.rancho) await store.setMeta('ranchoActivo', S.rancho.id);
    render();
  } else {
    sincronizarYRefrescar();
  }
}

function registrarSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sin SW la app igual funciona mientras haya conexión para cargarla */ });
  }
}

async function iniciar() {
  registrarSW();
  const s = api.getSession();
  if (!s) { render(); return; }
  user = s.user;
  await abrirUsuario(false);
}

window.addEventListener('online', () => sincronizarYRefrescar());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizarYRefrescar(); });
setInterval(() => { if (document.visibilityState === 'visible' && user) sincronizarYRefrescar(); }, 60000);

// Para pruebas de punta a punta
window.__hato = { sincronizar: () => sincronizarYRefrescar(true), estado: () => ({ pend: S.pend, vista: S.vista }) };

iniciar();
