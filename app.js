// HATO · app. Pantallas y flujo. Todo se guarda primero en el teléfono; se envía cuando hay conexión.

import { PARAMS, TIPOS, textoTipo, uuid, hoyLocal, sumarDias, fechaCorta, normArete, validarEvento, eventosVigentes, estadoVaca, tipoSugerido, ordenarTipos, UMBRALES, resumenRancho, recomendarVisita, agruparSolicitudes, validarSolicitud, repartir, lineasDeEntrega, clasificarHato, agruparTodas, cortesAlrededor, acumuladoCiclo, textoFalta, textoCorte, resumenCorte, necesidadSemana, DIAS_SEMANA, fechaEntregaVet, DIAS_ENTREGA_VET } from './lib.js';
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
  comprasVet: [],
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
  admin: [],
  panel: [],
  ped: null,
  ordenVacas: 'numero',
  tabAtender: 'ver',
  grupoAtender: null,
  fichaDesde: 'vacas',
  asoc: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Datos ----------

async function refrescar() {
  if (!store) return;
  const ranchoId = S.rancho ? S.rancho.id : null;
  const todosA = await store.all('animales');
  const todosE = await store.all('eventos');
  const animales = todosA.filter((a) => a.rancho_id === ranchoId);
  const eventos = todosE.filter((e) => e.rancho_id === ranchoId);
  S.animales = animales;
  S.eventos = eventos;
  const hoy = hoyLocal();
  S.panel = calcularPanel(todosA, todosE, hoy);
  const porVaca = new Map();
  for (const e of eventos) {
    if (!porVaca.has(e.animal_id)) porVaca.set(e.animal_id, []);
    porVaca.get(e.animal_id).push(e);
  }
  S.estados = new Map(animales.map((a) => [a.id, estadoVaca(porVaca.get(a.id) || [], hoy)]));
  S.pend = await sync.contarPendientes();
  S.ultima = (await store.getMeta('ultimaSync')) || null;
}

// Compras de la cooperativa dirigidas a este usuario como veterinario (por correo). Se guarda en el teléfono para verlas sin internet.
async function cargarComprasVet() {
  try {
    const filas = await api.rest('POST', '/rpc/mis_compras_vet', {});
    S.comprasVet = Array.isArray(filas) ? filas : [];
    if (store) await store.setMeta('comprasVet', S.comprasVet);
  } catch (e) {
    // sin conexión u otro error: se conserva lo último que se supo
  }
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
    S.admin = (await store.getMeta('admin')) || [];
    await cargarComprasVet();
    if (S.rancho && !S.ranchos.find((r) => r.id === S.rancho.id)) S.rancho = S.ranchos[0] || null;
    if (!S.rancho && S.ranchos.length) S.rancho = S.ranchos[0];
  } finally {
    S.sincronizando = false;
  }
  await refrescar();
  if (S.vista === 'registro' && S.reg && S.reg.paso >= 1) actualizarChip();
  else if (S.vista === 'asoc' || S.vista === 'insumos') actualizarChip(); // no se pisa lo que se está escribiendo
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

function vistaComprasVet() {
  const lista = S.comprasVet.map((o) => {
    const [cls, txt] = ESTADOS_ORDEN[o.estado] || ['gris', o.estado];
    const f = fechaEntregaVet(o.creada_en);
    const porRancho = new Map();
    for (const l of o.por_rancho || []) { if (!porRancho.has(l.rancho)) porRancho.set(l.rancho, []); porRancho.get(l.rancho).push(l); }
    return `<div class="card"><div class="fila"><b>${esc(o.codigo)}</b><span class="estado ${cls}">${esc(txt)}</span></div>
      <span class="suave">${esc(o.cooperativa)} · pedida el ${esc(fechaCorta(String(o.creada_en).slice(0, 10)))}</span>
      ${f ? `<div style="margin-top:6px"><b>Entrega estimada: ${esc(fechaCorta(f))}</b> <span class="suave">(${DIAS_ENTREGA_VET} días después de la orden)</span></div>` : ''}
      ${o.procede_de ? `<div class="aviso info" style="margin-top:8px">Procede de <b>${esc(o.procede_de)}</b>: es lo que faltó por llegar.</div>` : ''}
      <div style="margin-top:8px"><b>Total a surtir</b></div>
      ${(o.lineas || []).map((l) => `<div class="fila"><span>${esc(l.insumo)}</span><b>${esc(l.total)} ${esc(l.unidad)}</b></div>`).join('')}
      <div style="margin-top:8px"><b>Por rancho</b></div>
      ${[...porRancho.entries()].map(([r, ls]) => `<div class="ev"><b>${esc(r)}</b><br><span class="suave">${ls.map((l) => `${esc(l.insumo)}: ${esc(l.cantidad)} ${esc(l.unidad)}`).join(' · ')}</span></div>`).join('')}
      ${o.nota ? `<p class="suave" style="margin:8px 0 0">Nota: ${esc(o.nota)}</p>` : ''}</div>`;
  }).join('');
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Compras para mí</h2>
    <p class="suave">Compras de tu cooperativa dirigidas a ti. Aquí solo ves lo que hay que surtir y para qué rancho; no ves vacas ni registros. Se actualiza al sincronizar.</p>
    ${lista || '<p class="suave">No hay compras para ti por ahora.</p>'}
    ${pie()}`);
}

function vistaInicio() {
  const hayPanel = S.panel.length > 0;
  const hayAsoc = S.admin.length > 0;
  const hayCompras = S.comprasVet.length > 0;
  if (!S.rancho && !hayPanel && !hayAsoc && !hayCompras) {
    return marco(`<div class="card"><h2>Aún no tienes un rancho asignado</h2><p>Pide a tu cooperativa o a quien administra HATO que vincule tu cuenta (<b>${esc(user ? user.email : '')}</b>) a un rancho. Luego toca el botón de arriba para actualizar.</p><button class="btn primario" data-accion="sync">Actualizar ahora</button></div>${pie()}`);
  }
  const extra = `${hayPanel ? `<button class="btn" style="margin-top:12px" data-accion="ir" data-vista="panel">🩺 Panel del veterinario${S.panel.some((p) => p.rec.prioridad === 1) ? ' · hay visitas urgentes' : ''}</button>` : ''}
    ${hayCompras ? `<button class="btn" data-accion="ir" data-vista="comprasvet">🛒 Compras para mí · ${S.comprasVet.length}</button>` : ''}
    ${hayAsoc ? `<button class="btn" data-accion="abrir-asoc">🤝 Panel de la asociación</button>` : ''}`;
  if (!S.rancho) return marco(`${extra}${pie()}`);
  const porAtender = [...S.estados.values()].filter((e) => e.alerta).length;
  const info = [S.rancho.socio, S.rancho.cooperativa].filter(Boolean).join(' · ');
  const puedePedir = S.rancho.rol === 'dueno' || S.rancho.rol === 'mvz';
  return marco(`
    ${info ? `<p class="suave" style="margin:0 0 10px">${esc(info)}</p>` : ''}
    <button class="btn primario" style="min-height:76px;font-size:22px" data-accion="registrar">➕ Registrar evento</button>
    <div class="grid" style="margin-top:12px">
      <button class="btn tile" data-accion="ir" data-vista="atender"><b>${porAtender}</b><span>Por atender</span></button>
      <button class="btn tile" data-accion="ir" data-vista="vacas"><b>${S.animales.length}</b><span>Mis vacas</span></button>
    </div>
    <button class="btn" style="margin-top:12px" data-accion="ir" data-vista="pendientes">${S.pend.total ? `⏳ ${S.pend.total} por enviar` : '✓ Todo enviado'} · ver detalle</button>
    ${puedePedir ? `<button class="btn" data-accion="abrir-insumos">📦 Pedir insumos</button>` : ''}
    ${extra}
    ${pie()}`);
}

function pie() {
  return `<p class="pie">${esc(user ? user.email : '')}<br><button class="atras" data-accion="salir">Cerrar sesión</button><br>HATO · by FROM TECH 4D</p>`;
}

function htmlVacasAgrupadas() {
  const q = normArete(S.filtro);
  const animales = S.animales.filter((x) => !q || x.arete.includes(q));
  if (!animales.length) return `<p class="suave">No hay vacas${q ? ' con ese arete' : ' registradas todavía'}.</p>`;
  const evs = new Set(animales.map((x) => x.id));
  const grupos = agruparTodas(animales, S.eventos.filter((e) => evs.has(e.animal_id)), hoyLocal());
  return grupos.map((g) => `<div style="margin:14px 0 6px"><b>${esc(g.titulo)} (${g.vacas.length})</b>${g.nota ? `<span class="suave"> · ${esc(g.nota)}</span>` : ''}</div>
    <div class="cuadros">${g.vacas.map((v) => cuadroVaca(v.a, 'ficha', etiquetaPorVer(v.est))).join('')}</div>`).join('');
}

function vistaVacas() {
  const alertas = S.animales.filter((x) => S.estados.get(x.id).alerta).length;
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Mis vacas (${S.animales.length})</h2>
    <input type="text" id="filtro" placeholder="Buscar por arete" autocomplete="off" autocapitalize="characters" value="${esc(S.filtro)}">
    ${alertas ? `<p class="suave" style="margin:8px 0 0">${alertas} por atender (borde naranja). Toca una vaca para ver su historial.</p>` : '<p class="suave" style="margin:8px 0 0">Toca una vaca para ver su historial.</p>'}
    <div id="lista">${htmlVacasAgrupadas()}</div>`);
}


function etiquetaPorVer(est) {
  switch (est.codigo) {
    case 'diagnosticar': return `Diag. · ${est.dias} d`;
    case 'parto_proximo': return est.partoEsperado ? `Parto ${fechaCorta(est.partoEsperado).replace(/ \d{4}$/, '')}` : 'Parto próximo';
    case 'abierta': case 'lista': case 'posparto': case 'servida': return est.dias !== null ? `${ETIQUETA_CORTA[est.codigo]} · ${est.dias} d` : ETIQUETA_CORTA[est.codigo];
    case 'gestante': return est.partoEsperado ? `Parto ${fechaCorta(est.partoEsperado).replace(/ \d{4}$/, '')}` : 'Gestante';
    default: return ETIQUETA_CORTA[est.codigo] || est.texto;
  }
}

function vistaAtender() {
  const C = clasificarHato(S.animales, S.eventos, hoyLocal());
  const GR = { diagnosticar: ['diagnosticar'], parto_proximo: ['parto_proximo'], celo_abierta_lista: ['celo', 'abierta', 'lista'] };
  const filtro = S.grupoAtender && GR[S.grupoAtender] ? GR[S.grupoAtender] : null;
  const tab = filtro ? 'ver' : (S.tabAtender === 'sin' ? 'sin' : 'ver');
  const gruposVista = filtro ? C.grupos.filter((g) => filtro.includes(g.codigo)) : C.grupos;
  const nFiltro = gruposVista.reduce((n, g) => n + g.vacas.length, 0);
  const nSin = C.sinDatos.length;
  const botones = filtro ? `<div class="aviso info" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span>Mostrando ${esc(nFiltro)} vaca(s): ${esc(gruposVista.map((g) => g.titulo.toLowerCase()).join(', '))}</span><button class="btn chico" style="margin:0;width:auto" data-accion="atender-todas">Ver todas</button></div>` : `<div class="fila" style="gap:8px;margin:0 0 12px">
    <button class="btn chico ${tab === 'ver' ? 'sel' : ''}" style="margin:0" data-accion="tab-atender" data-tab="ver">Por ver (${C.totalPorVer})</button>
    <button class="btn chico ${tab === 'sin' ? 'sel' : ''}" style="margin:0" data-accion="tab-atender" data-tab="sin">Sin datos (${nSin})</button></div>`;
  let cuerpo;
  if (tab === 'ver') {
    cuerpo = nFiltro || (!filtro && C.totalPorVer)
      ? gruposVista.map((g) => `<div style="margin:14px 0 6px"><b>${esc(g.titulo)} (${g.vacas.length})</b>${g.nota ? `<span class="suave"> · ${esc(g.nota)}</span>` : ''}</div>
          <div class="cuadros">${g.vacas.map((v) => cuadroVaca(v.a, 'ficha', etiquetaPorVer(v.est), v.dudosa)).join('')}</div>`).join('')
        + (gruposVista.some((g) => g.vacas.some((v) => v.dudosa)) ? '<p class="suave" style="margin-top:12px">Los cuadros con borde punteado tienen un dato dudoso: míralos también en “Sin datos”.</p>' : '')
      : '<p class="suave">Nada por ver según los registros. 🎉</p>';
  } else {
    cuerpo = nSin
      ? `<p class="suave" style="margin:0 0 8px">Vacas con registros que no cuadran o sin registros. Averigua qué pasó con cada una (pregunta al encargado, revisa el corral) y regístralo; si ya no está, márcala como descarte. Más urgentes primero.</p>`
        + C.sinDatos.map((f) => `<button class="vaca" data-accion="ficha" data-id="${esc(f.a.id)}"><div class="fila"><span class="arete">${esc(f.a.arete)}</span>${estadoChip(f.est)}</div><div class="suave">${esc(f.motivo.texto)}</div></button>`).join('')
      : '<p class="suave">Todas las vacas tienen datos que cuadran. 👍</p>';
  }
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Por atender</h2>
    ${botones}
    ${cuerpo}
    <p class="suave" style="margin-top:14px">Los avisos salen de reglas sencillas (por ejemplo, diagnóstico a los ${PARAMS.diasDiagnostico} días del servicio; “sin datos” = sin registros, solo notas, más de ${UMBRALES.diasSinMovimiento} días sin movimiento o parto vencido por más de ${UMBRALES.diasPartoVencido} días). Valídalas con tu veterinario.</p>`);
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
  if (!a) return marco(`<button class="atras" data-accion="ir" data-vista="${S.fichaDesde === 'atender' ? 'atender' : 'vacas'}">‹ ${S.fichaDesde === 'atender' ? 'Por atender' : 'Mis vacas'}</button><p>No se encontró la vaca.</p>`);
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
    <button class="atras" data-accion="ir" data-vista="${S.fichaDesde === 'atender' ? 'atender' : 'vacas'}">‹ ${S.fichaDesde === 'atender' ? 'Por atender' : 'Mis vacas'}</button>
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
  if (S.vista === 'asoc') capturarFormAsoc();
  if (S.vista === 'insumos' && S.ped && document.getElementById('nota')) {
    document.querySelectorAll('input[data-cant]').forEach((el) => { if (Object.prototype.hasOwnProperty.call(S.ped.form.items, el.dataset.cant)) S.ped.form.items[el.dataset.cant] = el.value; }); // solo los aún elegidos: el DOM viejo no resucita lo quitado/enviado
    S.ped.form.nota = document.getElementById('nota').value;
  }
  let html;
  switch (S.vista) {
    case 'vacas': html = vistaVacas(); break;
    case 'atender': html = vistaAtender(); break;
    case 'ficha': html = vistaFicha(); break;
    case 'registro': html = S.rancho ? vistaRegistro() : vistaInicio(); break;
    case 'pendientes': html = vistaPendientes(); break;
    case 'panel': html = vistaPanel(); break;
    case 'insumos': html = S.rancho ? vistaInsumos() : vistaInicio(); break;
    case 'asoc': html = vistaAsoc(); break;
    case 'comprasvet': html = vistaComprasVet(); break;
    default: html = vistaInicio();
  }
  $app.innerHTML = html;
  if (S.vista === 'registro' && S.reg && S.reg.paso === 1) { pintarResultados(); }
}

function ir(vista, conservarFiltro = false) {
  if (vista === 'atender' && S.vista !== 'ficha' && !conservarFiltro) S.grupoAtender = null;
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

const ETIQUETA_CORTA = { sin_datos: 'Sin datos', diagnosticar: 'Diagnóstico', servida: 'Servida', gestante: 'Gestante', parto_proximo: 'Parto próximo', celo: 'En celo', abierta: 'Vacía', lista: 'Lista', posparto: 'Posparto', descartada: 'Descartada', sin_estado: 'Sin estado' };

function cuadroVaca(a, accion = 'elegir', etiqueta = null, dudosa = false) {
  const est = S.estados.get(a.id);
  const cls = (est && est.alerta ? 'alerta' : est && est.codigo === 'descartada' ? 'apagada' : '') + (dudosa ? ' dudosa' : '');
  return `<button class="cuadro ${cls}" data-accion="${accion}" data-id="${esc(a.id)}" aria-label="Vaca ${esc(a.arete)}, ${esc(est ? est.texto : '')}${dudosa ? ', revisar el dato' : ''}"><b>${esc(a.arete)}</b><small>${esc(etiqueta || (est ? (ETIQUETA_CORTA[est.codigo] || est.texto) : ''))}${a._sync && a._sync !== 'ok' ? ' ⏳' : ''}</small></button>`;
}

function pintarResultados() {
  const cont = document.getElementById('resultados');
  if (!cont) return;
  const input = document.getElementById('arete');
  const q = normArete(input ? input.value : S.reg.arete);
  const porNumero = (x, y) => x.arete.localeCompare(y.arete, 'es', { numeric: true });
  const orden = S.ordenVacas === 'atencion' ? (x, y) => S.estados.get(x.id).prioridad - S.estados.get(y.id).prioridad || porNumero(x, y) : porNumero;
  const lista = S.animales.filter((a) => !q || a.arete.includes(q)).sort(orden);
  const exacta = q && S.animales.some((a) => a.arete === q);
  const alertas = S.animales.filter((a) => S.estados.get(a.id).alerta).length;
  const toggle = S.animales.length > 6 ? `<div class="fila" style="gap:8px;margin:0 0 10px"><button class="btn chico ${S.ordenVacas === 'atencion' ? '' : 'sel'}" style="margin:0" data-accion="orden-vacas" data-orden="numero">Por número</button><button class="btn chico ${S.ordenVacas === 'atencion' ? 'sel' : ''}" style="margin:0" data-accion="orden-vacas" data-orden="atencion">Atención primero</button></div>` : '';
  const nueva = q && !exacta ? `<button class="btn" style="margin-top:12px" data-accion="crear-vaca">➕ Vaca nueva: ${esc(q)}</button>` : '';
  if (!S.animales.length) { cont.innerHTML = `<p class="suave">Aún no hay vacas. Escribe el arete para crear la primera.</p>${nueva}`; return; }
  cont.innerHTML = `<p class="suave" style="margin:0 0 8px">${q ? `${lista.length} de ${S.animales.length} vacas` : `${S.animales.length} vacas${alertas ? ` · ${alertas} por atender` : ''}`}. Toca la vaca.</p>${toggle}${lista.length ? `<div class="cuadros">${lista.map((a) => cuadroVaca(a)).join('')}</div>` : '<p class="suave">Ninguna vaca con ese número.</p>'}${nueva}`;
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

// ---------- Panel del veterinario ----------

function calcularPanel(todosA, todosE, hoy) {
  return S.ranchos.filter((r) => r.rol === 'mvz').map((r) => {
    const res = resumenRancho(todosA.filter((a) => a.rancho_id === r.id), todosE.filter((e) => e.rancho_id === r.id), hoy);
    return { rancho: r, res, rec: recomendarVisita(res) };
  }).sort((a, b) => a.rec.prioridad - b.rec.prioridad
    || (b.res.diagnosticar + b.res.partoProximo) - (a.res.diagnosticar + a.res.partoProximo)
    || a.rancho.nombre.localeCompare(b.rancho.nombre, 'es'));
}

function claseRec(c) { return c === 'visitar' ? 'mal' : c === 'llamar' || c === 'sin_datos' ? 'alerta' : c === 'sin_vacas' ? 'gris' : ''; }
function textoDato(res) {
  if (res.diasSinDatos === null) return 'sin datos';
  if (res.diasSinDatos === 0) return 'hoy';
  if (res.diasSinDatos === 1) return 'ayer';
  return `hace ${res.diasSinDatos} días`;
}

function metricaVaca(p, grupo, n, texto) {
  if (!n) return `<div><b>${n}</b><span>${esc(texto)}</span></div>`;
  return `<button class="metrica" data-accion="panel-grupo" data-id="${esc(p.rancho.id)}" data-grupo="${grupo}" aria-label="${esc(n)} ${esc(texto)}: ver cuáles son"><b>${n}</b><span>${esc(texto)}</span><span class="ver">Ver cuáles ›</span></button>`;
}

function vistaPanel() {
  const tarjetas = S.panel.map((p) => {
    const viejo = p.res.diasSinDatos !== null && p.res.diasSinDatos > UMBRALES.diasSinDatos;
    return `<div class="card">
      <div class="fila"><b>${esc(p.rancho.nombre)}</b><span class="estado ${claseRec(p.rec.codigo)}">${esc(p.rec.texto)}</span></div>
      <div class="metricas">
        ${metricaVaca(p, 'diagnosticar', p.res.diagnosticar, 'Toca diagnóstico')}
        ${metricaVaca(p, 'parto_proximo', p.res.partoProximo, 'Parto próximo')}
        ${metricaVaca(p, 'celo_abierta_lista', p.res.celo + p.res.abiertas + p.res.listas, 'Celo, abiertas o listas')}
        <div><b class="${viejo ? 'rojo' : ''}" style="font-size:18px">${esc(textoDato(p.res))}</b><span>Último dato</span></div>
      </div>
      <p class="suave" style="margin:8px 0">${esc(p.rec.motivo)}</p>
      ${p.res.sinDatosVacas ? `<p style="margin:0 0 8px;color:var(--rojo,#a32020);font-weight:700">${esc(p.res.sinDatosVacas)} vaca(s) sin datos o con datos que no cuadran</p>` : ''}
      <button class="btn chico" data-accion="panel-abrir" data-id="${esc(p.rancho.id)}">Ver vacas por atender</button>
    </div>`;
  }).join('');
  const proximos = S.panel.filter((p) => p.res.proxima).sort((a, b) => a.res.proxima.fecha.localeCompare(b.res.proxima.fecha));
  const lista = proximos.length
    ? `<div class="card"><b>Próximos pendientes por fecha</b>${proximos.map((p) => `<div class="ev"><div class="fila"><span>${esc(p.rancho.nombre)}</span><span class="suave">${esc(fechaCorta(p.res.proxima.fecha))}</span></div><span class="suave">${esc(p.res.proxima.texto)}</span></div>`).join('')}</div>`
    : '';
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Panel del veterinario</h2>
    ${tarjetas || '<p class="suave">No tienes ranchos asignados como veterinario.</p>'}
    ${lista}
    <p class="suave">Las recomendaciones salen de reglas provisionales (${UMBRALES.visitaMin} o más pendientes en sitio = visita; más de ${UMBRALES.diasSinDatos} días sin datos = llamar). Faltan validarlas con un veterinario y no sustituyen su criterio. Se calcula con los datos de este teléfono; funciona sin internet.</p>
    ${pie()}`);
}

// ---------- Insumos (rancho) ----------

function limpiarCampos(...ids) { for (const id of ids) { const el = document.getElementById(id); if (el) el.value = ''; } }

function msgError(e) {
  if (e && e.network) return 'Sin conexión. Esto necesita internet.';
  if (e && (e.status === 401 || e.auth)) return 'Tu sesión venció. Entra de nuevo.';
  if (e && (e.status === 403 || e.code === '42501')) return 'No tienes permiso para hacer esto.';
  return (e && e.message) || 'Ocurrió un error.';
}

async function abrirInsumos() {
  S.ped = { cargando: true, error: null, formError: null, corte: null, estim: new Map(), configAbierta: false, estError: null, insumos: [], solicitudes: [], entregas: [], form: { items: {}, nota: '' } };
  ir('insumos');
  await cargarInsumos();
}

async function cargarInsumos() {
  try {
    const rid = encodeURIComponent(S.rancho.id);
    const [ins, sol, ent, coop, est] = await Promise.all([
      api.rest('GET', '/insumos?select=id,nombre,unidad&activo=eq.true&order=nombre.asc'),
      api.rest('GET', `/solicitudes_insumo?rancho_id=eq.${rid}&select=id,cantidad,cantidad_asignada,estado,nota,creado_en,orden_id,insumo_id,origen_solicitud_id,insumo:insumos(nombre,unidad)&order=creado_en.desc&limit=100`),
      api.rest('GET', `/entregas?rancho_id=eq.${rid}&select=id,orden_id,codigo,estado&order=codigo.desc&limit=50`),
      api.rest('GET', '/cooperativas?select=id,nombre,corte_dia,corte_hora&order=nombre.asc&limit=1'),
      api.rest('GET', `/estimacion_insumo_rancho?rancho_id=eq.${rid}&select=insumo_id,base,factor`),
    ]);
    S.ped.estim = new Map((est || []).map((x) => [x.insumo_id, { base: x.base, factor: Number(x.factor) }]));
    S.ped.corte = coop && coop[0] ? { dia: coop[0].corte_dia, hora: coop[0].corte_hora } : null;
    S.ped.insumos = ins || [];
    S.ped.solicitudes = sol || [];
    S.ped.entregas = ent || [];
    S.ped.error = null;
  } catch (e) { S.ped.error = msgError(e); }
  S.ped.cargando = false;
  if (S.vista === 'insumos') render();
}

const ESTADOS_ENTREGA_RANCHO = { por_entregar: ['alerta', 'En camino'], entregada: ['alerta', 'Entregada: confírmala'], confirmada: ['', 'Confirmada'] };

function entregasRancho() {
  const P = S.ped;
  if (!P || !P.entregas || !P.entregas.length) return '';
  return `<div class="card"><b>Entregas de compras en conjunto</b>${P.entregas.map((e) => {
    const [cls, txt] = ESTADOS_ENTREGA_RANCHO[e.estado] || ['gris', e.estado];
    const lineas = new Map();
    for (const s of P.solicitudes) {
      if (s.orden_id !== e.orden_id) continue;
      const k = s.insumo_id;
      const l = lineas.get(k) || { nombre: s.insumo ? s.insumo.nombre : 'Insumo', unidad: s.insumo ? s.insumo.unidad : '', pedida: 0, asignada: 0, ok: false };
      l.pedida += s.cantidad;
      if (s.cantidad_asignada !== null && s.cantidad_asignada !== undefined) { l.asignada += s.cantidad_asignada; l.ok = true; }
      lineas.set(k, l);
    }
    const mias = P.solicitudes.filter((s) => s.orden_id === e.orden_id);
    const hijas = P.solicitudes.filter((s) => mias.some((m) => m.id === s.origen_solicitud_id));
    const entregaHija = hijas.length ? P.entregas.find((x) => x.orden_id === hijas[0].orden_id) : null;
    const nota = mias.some((s) => s.origen_solicitud_id) ? '<div class="suave" style="margin-top:4px"><b>Procede de una entrega anterior:</b> es lo que faltó por llegar.</div>'
      : hijas.length ? `<div class="suave" style="margin-top:4px"><b>Faltaron ${esc(hijas.reduce((t, s) => t + s.cantidad, 0))}</b> en esta entrega${entregaHija ? `; los recibirás en <b>${esc(entregaHija.codigo)}</b>` : ''}.</div>` : '';
    return `<div class="ev"><div class="fila"><b>${esc(e.codigo)}</b><span class="estado ${cls}">${esc(txt)}</span></div>
      <span class="suave">${[...lineas.values()].map((l) => `${esc(l.nombre)}: ${l.ok ? `${esc(l.asignada)} de ${esc(l.pedida)} pedidas` : `${esc(l.pedida)} pedidas`} ${esc(l.unidad)}`).join(' · ')}</span>${nota}
      ${e.estado === 'entregada' ? `<div><button class="btn chico primario" style="margin-top:6px" data-accion="entrega-confirmar" data-id="${esc(e.id)}">Confirmar que lo recibí</button></div>` : ''}</div>`;
  }).join('')}</div>`;
}

async function confirmarEntrega(id) {
  if (!window.confirm('¿Confirmas que recibiste esta entrega?')) return;
  try { await api.rest('POST', '/rpc/confirmar_entrega', { p_entrega: id }); toast('Entrega confirmada'); }
  catch (e) { toast(msgError(e)); }
  await cargarInsumos();
}

function bloqueCorte(corte) {
  if (!corte) return '';
  const ahora = new Date();
  const { proximo } = cortesAlrededor(ahora, corte.dia, corte.hora);
  return `<div class="aviso warn"><b>Corte semanal: ${esc(textoCorte(corte.dia, corte.hora))}</b> · ${esc(textoFalta(ahora, proximo))}.<br><span class="suave">Lo que pidas antes entra a la compra de esta semana. Lo que pidas después, a la siguiente.</span></div>`;
}

const BASES_EST = { ninguna: 'No estimar', servicio: 'Vacas por servir', diagnostico: 'Vacas por diagnosticar' };

function tarjetaMiEstimacion(hayConfig) {
  const P = S.ped;
  if (!P.configAbierta) {
    return `<div class="card"><b>Mi estimación semanal</b>
      <p class="suave" style="margin:4px 0 8px">${hayConfig ? 'Tú decides cuánto usas por vaca. Tu cooperativa no la ve ni la cambia.' : 'Aún no hay sugerencias porque no has dicho cuánto usas por vaca. Tú decides: tu cooperativa no la ve ni la cambia.'}</p>
      <button class="btn chico" style="margin:0" data-accion="est-abrir">${hayConfig ? 'Cambiar mi estimación' : 'Configurar mi estimación'}</button></div>`;
  }
  return `<div class="card"><b>Mi estimación semanal</b>
    <p class="suave" style="margin:4px 0 8px">Para cada insumo elige sobre qué vacas se calcula y cuánto usas por vaca. Solo tú (dueño o veterinario de este rancho) la ves y la cambias. Es una guía, no pide nada por sí sola.</p>
    ${P.estError ? `<div class="aviso mal">${esc(P.estError)}</div>` : ''}
    ${P.insumos.map((i) => { const m = P.estim.get(i.id) || { base: 'ninguna', factor: 0 }; return `<div class="ev"><b>${esc(i.nombre)}</b> <span class="suave">· ${esc(i.unidad)}</span>
      <label for="eb-${esc(i.id)}">Se calcula sobre</label>
      <select id="eb-${esc(i.id)}" class="campo">${Object.entries(BASES_EST).map(([k, v]) => `<option value="${k}" ${m.base === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label for="ef-${esc(i.id)}">Cantidad por vaca</label>
      <input id="ef-${esc(i.id)}" type="text" inputmode="decimal" value="${esc(m.factor)}">
      <button class="btn chico" style="margin-top:6px" data-accion="est-guardar" data-id="${esc(i.id)}">Guardar</button></div>`; }).join('')}
    <button class="btn" style="margin:10px 0 0" data-accion="est-cerrar">Listo</button></div>`;
}

async function guardarEstimacion(id) {
  const base = document.getElementById(`eb-${id}`).value;
  const txt = document.getElementById(`ef-${id}`).value.trim().replace(',', '.');
  const factor = Number(txt);
  if (txt === '' || !Number.isFinite(factor) || factor < 0 || factor > 1000) { S.ped.estError = 'Escribe una cantidad por vaca entre 0 y 1000.'; render(); return; }
  try {
    await api.rest('POST', '/rpc/guardar_estimacion', { p_rancho: S.rancho.id, p_insumo: id, p_base: base, p_factor: factor });
    S.ped.estim.set(id, { base, factor });
    S.ped.estError = null;
    toast('Estimación guardada');
    render();
  } catch (e) { S.ped.estError = msgError(e); render(); }
}

function sugerenciaRancho() {
  const P = S.ped;
  if (!P || !S.animales) return '';
  const ahora = new Date();
  // "ya pedido" = acumulado del ciclo (desde el último corte), pendiente o ya consolidado; sin corte configurado, solo lo pendiente
  let acumulado;
  if (P.corte) acumulado = acumuladoCiclo(P.solicitudes, ahora, P.corte.dia, P.corte.hora);
  else { acumulado = new Map(); for (const x of P.solicitudes) if (x.estado === 'pendiente') acumulado.set(x.insumo_id, (acumulado.get(x.insumo_id) || 0) + x.cantidad); }
  const insumosEst = P.insumos.map((i) => { const m = P.estim.get(i.id); return { ...i, estimar_base: m ? m.base : 'ninguna', estimar_factor: m ? m.factor : 0 }; });
  const sug = necesidadSemana(S.animales, S.eventos, hoyLocal(), insumosEst, acumulado);
  const hayConfig = insumosEst.some((i) => i.estimar_base !== 'ninguna' && i.estimar_factor > 0);
  const ult = resumenRancho(S.animales, S.eventos, hoyLocal());
  const sinDatos = ult.diasSinDatos !== null && ult.diasSinDatos > UMBRALES.diasSinDatos;
  const desde = P.corte ? cortesAlrededor(ahora, P.corte.dia, P.corte.hora).ultimo : null;
  const tarjetaSug = sug.length ? `<div class="card"><b>Lo que podrías necesitar esta semana</b>
    <p class="suave" style="margin:4px 0 8px">Estimación según tus vacas y la cantidad por vaca que tú configuraste. Es una guía: tú decides cuánto pedir.${sinDatos ? ` <b>Ojo: tu último registro tiene ${esc(ult.diasSinDatos)} días; la estimación puede estar baja.</b>` : ''}</p>
    ${sug.map((x) => `<div class="ev"><div class="fila"><b>${esc(x.nombre)}: ${esc(x.sugerida)} ${esc(x.unidad)}</b></div>
      <span class="suave">${esc(x.vacas)} ${x.base === 'servicio' ? 'vacas por servir' : 'vacas por diagnosticar'} × ${esc(x.factor)} · ya pediste ${esc(x.ya)} en este ciclo</span>
      ${x.faltante > 0 ? `<div><button class="btn chico" style="margin-top:6px" data-accion="sug-usar" data-id="${esc(x.insumo_id)}" data-cant="${esc(x.faltante)}">Pedir ${esc(x.faltante)} (lo que falta)</button></div>` : '<div class="suave" style="margin-top:4px">Ya cubierto con lo que pediste.</div>'}</div>`).join('')}</div>` : '';
  const filas = [...acumulado.entries()].map(([id, n]) => { const i = P.insumos.find((q) => q.id === id) || { nombre: 'Insumo', unidad: '' }; return { nombre: i.nombre, unidad: i.unidad, n }; }).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
  const tarjetaAcum = P.corte ? `<div class="card"><b>Acumulado de este ciclo</b>
    <p class="suave" style="margin:4px 0 8px">Lo que has pedido desde el último corte (${esc(fechaCorta(hoyLocalDe(desde)))} ${esc(String(P.corte.hora).padStart(2, '0'))}:00), ya sea pendiente o incluido en una compra.</p>
    ${filas.length ? filas.map((f) => `<div class="fila" style="padding:6px 0;border-top:1px solid var(--linea)"><span>${esc(f.nombre)}</span><b>${esc(f.n)} ${esc(f.unidad)}</b></div>`).join('') : '<p class="suave" style="margin:0">Todavía no has pedido nada en este ciclo.</p>'}</div>` : '';
  const tarjetaConfig = tarjetaMiEstimacion(hayConfig);
  return tarjetaSug + tarjetaAcum + tarjetaConfig;
}

function hoyLocalDe(d) { return hoyLocal(d); }

function htmlResumenPedido() {
  const P = S.ped; const items = (P && P.form && P.form.items) || {};
  const elegidos = (P ? P.insumos : []).filter((i) => Object.prototype.hasOwnProperty.call(items, i.id));
  return `<div id="resumenPedido">${elegidos.length ? `<div class="resumen"><b>Lo que vas a solicitar</b>${elegidos.map((i) => `<div class="fila"><span>${esc(i.nombre)}</span><b>${String(items[i.id]).trim() ? `${esc(String(items[i.id]).trim())} ${esc(i.unidad)}` : '<span class="suave">falta cantidad</span>'}</b></div>`).join('')}</div>` : '<p class="suave" style="margin:12px 0 0">Toca un insumo para pedirlo: debajo de él aparece la cantidad.</p>'}</div>`;
}

function textoBotonEnviar() {
  const n = Object.keys(S.ped.form.items).length;
  return n > 1 ? `Enviar ${n} solicitudes` : 'Enviar solicitud';
}

function vistaInsumos() {
  const P = S.ped || { cargando: true, insumos: [], solicitudes: [], form: {} };
  const f = P.form || {};
  const items = f.items || {};
  const opciones = P.insumos.map((i) => {
    const sel = Object.prototype.hasOwnProperty.call(items, i.id);
    return `<div class="celda"><button class="cuadro ancho ${sel ? 'sel' : ''}" data-accion="ins-elegir" data-id="${esc(i.id)}" aria-pressed="${sel}"><b>${esc(i.nombre)}</b><small>${esc(i.unidad)}</small></button>
      ${sel ? `<label class="cant" for="cant-${esc(i.id)}">Cantidad de ${esc(i.nombre)}</label><input id="cant-${esc(i.id)}" data-cant="${esc(i.id)}" type="text" inputmode="numeric" value="${esc(items[i.id])}" placeholder="10" aria-label="Cantidad de ${esc(i.nombre)}">` : ''}</div>`;
  }).join('');
  const elegidos = P.insumos.filter((i) => Object.prototype.hasOwnProperty.call(items, i.id));
  const resumen = htmlResumenPedido();
  const estados = { pendiente: ['alerta', 'Pendiente'], consolidada: ['', 'En compra consolidada'], cancelada: ['gris', 'Cancelada'] };
  const historial = P.solicitudes.map((s) => {
    const [cls, txt] = estados[s.estado] || ['gris', s.estado];
    return `<div class="ev"><div class="fila"><b>${esc(s.insumo ? s.insumo.nombre : 'Insumo')} · ${esc(s.cantidad)} ${esc(s.insumo ? s.insumo.unidad : '')}</b><span class="estado ${cls}">${esc(txt)}</span></div>
      <span class="suave">${esc(fechaCorta(String(s.creado_en).slice(0, 10)))}${s.nota ? ` · ${esc(s.nota)}` : ''}</span>
      ${s.estado === 'pendiente' ? `<div><button class="btn chico peligro" style="margin-top:6px" data-accion="sol-cancelar" data-id="${esc(s.id)}">Cancelar</button></div>` : ''}</div>`;
  }).join('');
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Pedir insumos</h2>
    <p class="suave">Tu cooperativa junta los pedidos de todos los ranchos para comprar en conjunto. Necesita internet.</p>
    ${P.error ? `<div class="aviso mal">${esc(P.error)}</div>` : ''}
    ${P.cargando ? '<p class="suave">Cargando…</p>' : `
    ${bloqueCorte(P.corte)}
    ${sugerenciaRancho()}
    <div class="card">
      <label id="insumo">¿Qué insumo?</label>
      <div class="cuadros dos" role="group" aria-labelledby="insumo">${opciones}</div>
      ${resumen}
      <label for="nota">Nota (opcional)</label>
      <input id="nota" type="text" value="${esc(f.nota)}" placeholder="Para qué lo necesitas">
      ${P.formError ? `<div class="aviso mal" style="margin-top:10px">${esc(P.formError)}</div>` : ''}
      <button class="btn primario" style="margin-top:12px" data-accion="sol-enviar">${textoBotonEnviar()}</button>
    </div>
    ${entregasRancho()}
    <div class="card"><b>Mis solicitudes</b>${historial || '<p class="suave">Aún no has pedido nada.</p>'}</div>`}
    ${pie()}`);
}

async function enviarSolicitud() {
  const F = S.ped.form;
  document.querySelectorAll('input[data-cant]').forEach((el) => { F.items[el.dataset.cant] = el.value.trim(); });
  F.nota = document.getElementById('nota').value.trim();
  const ids = S.ped.insumos.map((i) => i.id).filter((id) => Object.prototype.hasOwnProperty.call(F.items, id));
  if (!ids.length) { S.ped.formError = 'Elige al menos un insumo.'; render(); return; }
  for (const id of ids) {
    const err = validarSolicitud({ insumo_id: id, cantidad: F.items[id] });
    if (err) { const ins = S.ped.insumos.find((i) => i.id === id); S.ped.formError = `${ins ? ins.nombre : 'Insumo'}: ${err}`; render(); return; }
  }
  try {
    for (const id of ids) {
      await api.rest('POST', '/solicitudes_insumo', { id: uuid(), rancho_id: S.rancho.id, insumo_id: id, cantidad: Number(F.items[id]), nota: F.nota || null, creado_por: user.id }, { Prefer: 'return=minimal' });
      delete F.items[id]; // lo ya enviado no se reenvía si otro falla
    }
    S.ped.form = { items: {}, nota: '' };
    S.ped.formError = null;
    toast(ids.length > 1 ? `${ids.length} solicitudes enviadas` : 'Solicitud enviada');
    await cargarInsumos();
  } catch (e) { S.ped.formError = msgError(e) + (ids.some((id) => !Object.prototype.hasOwnProperty.call(F.items, id)) ? ' Lo que ya se envió quedó registrado; revisa "Mis solicitudes".' : ''); render(); }
}

async function cancelarSolicitud(id) {
  try {
    const filas = await api.rest('PATCH', `/solicitudes_insumo?id=eq.${encodeURIComponent(id)}`, { estado: 'cancelada' }, { Prefer: 'return=representation' });
    if (!Array.isArray(filas) || !filas.length) toast('Ya no se puede cancelar: tu cooperativa la incluyó en una compra.');
    else toast('Solicitud cancelada');
  } catch (e) { toast(msgError(e)); }
  await cargarInsumos();
}

// ---------- Panel de la asociación ----------

async function abrirAsoc() {
  S.asoc = { cargando: true, error: null, corte: null, corteError: null, corteAbierto: false, coop: S.admin[0], solicitudes: [], insumos: [], ranchos: [], ordenes: [], entregas: [], recepciones: [], recep: null, form: { tipo: 'veterinario', destinatario: '', nota: '' }, formError: null, sel: null, insForm: { nombre: '', unidad: '' }, insError: null };
  ir('asoc');
  await cargarAsoc();
}

async function cargarAsoc() {
  try {
    const [sol, ins, ran, ord, ent, rec, coop] = await Promise.all([
      api.rest('GET', '/solicitudes_insumo?select=id,rancho_id,insumo_id,cantidad,cantidad_asignada,estado,orden_id,origen_solicitud_id,creado_en&order=creado_en.desc&limit=1000'),
      api.rest('GET', '/insumos?select=id,nombre,unidad,activo&order=nombre.asc'),
      api.rest('GET', '/ranchos?select=id,nombre'),
      api.rest('GET', '/ordenes_consolidadas?select=id,codigo,destinatario_tipo,destinatario,nota,estado,creada_en,origen_orden_id,pendiente,pendiente_orden_id,veterinario_correo&order=creada_en.desc&limit=30'),
      api.rest('GET', '/entregas?select=id,orden_id,rancho_id,codigo,estado&order=codigo.asc&limit=500'),
      api.rest('GET', '/orden_recepciones?select=orden_id,insumo_id,cantidad_solicitada,cantidad_recibida&limit=500'),
      api.rest('GET', `/cooperativas?id=eq.${encodeURIComponent(S.asoc.coop.id)}&select=id,corte_dia,corte_hora`),
    ]);
    S.asoc.corte = coop && coop[0] ? { dia: coop[0].corte_dia, hora: coop[0].corte_hora } : null;
    Object.assign(S.asoc, { solicitudes: sol || [], insumos: ins || [], ranchos: ran || [], ordenes: ord || [], entregas: ent || [], recepciones: rec || [], error: null });
    const ids = agruparSolicitudes(S.asoc.solicitudes, S.asoc.insumos, S.asoc.ranchos).map((g) => g.insumo_id);
    S.asoc.sel = new Set(S.asoc.sel ? ids.filter((i) => S.asoc.sel.has(i)) : ids);
  } catch (e) { S.asoc.error = msgError(e); }
  S.asoc.cargando = false;
  if (S.vista === 'asoc') render();
}

const TIPOS_DEST = { veterinario: 'Veterinario', proveedor: 'Proveedor', otro: 'Otra instancia' };
const ESTADOS_ORDEN = { borrador: ['alerta', 'Borrador'], enviada: ['', 'Enviada'], recibida: ['', 'Recibida'], cancelada: ['gris', 'Cancelada'] };

function itemsDeOrden(ordenId) {
  const A = S.asoc;
  const porInsumo = new Map();
  for (const s of A.solicitudes) {
    if (s.orden_id !== ordenId) continue;
    porInsumo.set(s.insumo_id, (porInsumo.get(s.insumo_id) || 0) + s.cantidad);
  }
  return [...porInsumo.entries()].map(([id, total]) => {
    const i = A.insumos.find((x) => x.id === id) || { nombre: 'Insumo', unidad: '' };
    return { nombre: i.nombre, unidad: i.unidad, total };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function nombreRancho(id) { const r = (S.asoc.ranchos || []).find((x) => x.id === id); return r ? r.nombre : 'Rancho'; }

function entregasDeOrden(ordenId) {
  return (S.asoc.entregas || []).filter((e) => e.orden_id === ordenId);
}

const ESTADOS_ENTREGA = { por_entregar: ['alerta', 'Por entregar'], entregada: ['', 'Entregada, falta confirmar'], confirmada: ['', 'Confirmada por el rancho'] };

function textoReparto(ordenId, valores) {
  // vista previa del reparto con lo recibido que se está escribiendo
  const A = S.asoc;
  const porInsumo = new Map();
  for (const x of A.solicitudes) if (x.orden_id === ordenId) { if (!porInsumo.has(x.insumo_id)) porInsumo.set(x.insumo_id, []); porInsumo.get(x.insumo_id).push(x); }
  return [...porInsumo.entries()].map(([insumoId, sols]) => {
    const ins = A.insumos.find((i) => i.id === insumoId) || { nombre: 'Insumo', unidad: '' };
    const v = Number(valores[insumoId]);
    if (!Number.isInteger(v) || v < 0 || String(valores[insumoId]).trim() === '') return `<b>${esc(ins.nombre)}</b>: escribe cuánto llegó.`;
    const r = repartir(sols, v);
    const total = sols.reduce((a, x) => a + x.cantidad, 0);
    const porRancho = new Map();
    for (const x of sols) porRancho.set(x.rancho_id, (porRancho.get(x.rancho_id) || 0) + r.get(x.id));
    const ped = new Map();
    for (const x of sols) ped.set(x.rancho_id, (ped.get(x.rancho_id) || 0) + x.cantidad);
    const aviso = v < total ? ` <span style="color:var(--ambar)">Llegó menos de lo pedido (${esc(total)}): se reparte proporcional.</span>` : v > total ? ` <span class="suave">Sobran ${esc(v - total)}: quedan en la asociación.</span>` : '';
    return `<b>${esc(ins.nombre)}</b>:${aviso}<br>${[...porRancho.entries()].map(([rid, n]) => `${esc(nombreRancho(rid))} ${esc(n)} de ${esc(ped.get(rid))}`).join(' · ')}`;
  }).join('<br>');
}

function lineaEntregaVet(o) {
  if (o.destinatario_tipo !== 'veterinario') return '';
  const f = fechaEntregaVet(o.creada_en);
  return f ? `Entrega estimada: ${fechaCorta(f)} (${DIAS_ENTREGA_VET} días después de la orden)` : '';
}

function tarjetaOrden(o) {
  const A = S.asoc;
  const [cls, txt] = ESTADOS_ORDEN[o.estado] || ['gris', o.estado];
  const items = itemsDeOrden(o.id);
  let accion = '';
  if (o.estado === 'borrador') accion = `<button class="btn chico" data-accion="orden-estado" data-id="${esc(o.id)}" data-estado="enviada">Marcar como enviada</button>`;
  if (o.estado === 'enviada' && !(A.recep && A.recep.ordenId === o.id)) accion = `<button class="btn chico primario" data-accion="orden-recibir" data-id="${esc(o.id)}">Registrar recepción</button>`;
  let recepcion = '';
  if (A.recep && A.recep.ordenId === o.id) {
    recepcion = `<div class="card" style="margin-top:8px"><b>¿Cuánto llegó?</b>
      ${Object.keys(A.recep.valores).map((id) => {
        const ins = A.insumos.find((q) => q.id === id) || { nombre: 'Insumo', unidad: '' };
        const pedido = A.solicitudes.filter((x) => x.orden_id === o.id && x.insumo_id === id).reduce((t, x) => t + x.cantidad, 0);
        return `<label for="rec-${esc(id)}">${esc(ins.nombre)} (pedido: ${esc(pedido)} ${esc(ins.unidad)})</label><input id="rec-${esc(id)}" data-rec="${esc(id)}" type="text" inputmode="numeric" value="${esc(A.recep.valores[id] ?? '')}">`;
      }).join('')}
      <p class="suave" id="repartoPrev" style="margin:10px 0 0">${textoReparto(o.id, A.recep.valores)}</p>
      ${A.recep.error ? `<div class="aviso mal" style="margin-top:10px">${esc(A.recep.error)}</div>` : ''}
      <button class="btn primario" style="margin-top:12px" data-accion="recep-confirmar" data-id="${esc(o.id)}">Registrar recepción y repartir</button>
      <button class="btn" data-accion="recep-cancelar">Cancelar</button></div>`;
  }
  const codigoDe = (id) => { const x = A.ordenes.find((q) => q.id === id); return x ? x.codigo : 'otra compra'; };
  const vetCtl = o.destinatario_tipo !== 'veterinario' || o.estado === 'cancelada' ? '' : (o.veterinario_correo
    ? `<div class="aviso info" style="margin-top:8px">El doctor la ve en su app con la cuenta <b>${esc(o.veterinario_correo)}</b>${o.estado === 'borrador' ? ' cuando la marques como enviada' : ''}.
        <div><button class="btn chico" style="margin:8px 0 0" data-accion="vet-quitar" data-id="${esc(o.id)}">Quitar acceso</button></div></div>`
    : `<div class="card" style="margin-top:8px"><b>¿El doctor usa HATO?</b>
        <p class="suave" style="margin:4px 0 6px">Escribe el correo con el que entra a la app y le aparecerá esta compra${o.estado === 'borrador' ? ' en cuanto la marques como enviada' : ''}.</p>
        <input id="vetc-${esc(o.id)}" type="email" inputmode="email" autocomplete="off" placeholder="correo@del-doctor.com" aria-label="Correo del doctor">
        <button class="btn chico" style="margin:8px 0 0" data-accion="vet-asignar" data-id="${esc(o.id)}">Mostrar al doctor</button></div>`);
  const origen = o.origen_orden_id ? `<div class="aviso info" style="margin-top:8px">Procede de <b>${esc(codigoDe(o.origen_orden_id))}</b>: es lo que faltó por llegar de esa compra.</div>` : '';
  let pendiente = '';
  if (o.estado === 'recibida') {
    const falt = new Map();
    for (const x of A.solicitudes) {
      if (x.orden_id !== o.id || x.cantidad_asignada === null || x.cantidad_asignada === undefined || x.cantidad_asignada >= x.cantidad) continue;
      falt.set(x.insumo_id, (falt.get(x.insumo_id) || 0) + (x.cantidad - x.cantidad_asignada));
    }
    if (falt.size) {
      const lista = [...falt.entries()].map(([id, n]) => { const i = A.insumos.find((q) => q.id === id) || { nombre: 'Insumo', unidad: '' }; return `${esc(i.nombre)}: ${esc(n)} ${esc(i.unidad)}`; }).join(' · ');
      if (!o.pendiente) pendiente = `<div class="card" style="margin-top:8px"><b>Falta por llegar</b><p style="margin:6px 0">${lista}</p>
        <p class="suave" style="margin:0 0 8px">Puedes pedir lo que faltó en una compra nueva (con su propio código y entregas por rancho, marcada como procedente de ${esc(o.codigo)}) o cerrarlo sin reponer.</p>
        <button class="btn primario" style="margin:0 0 8px" data-accion="pend-generar" data-id="${esc(o.id)}">Generar compra con lo pendiente</button>
        <button class="btn chico" style="margin:0" data-accion="pend-cerrar" data-id="${esc(o.id)}">Cerrar sin reponer</button></div>`;
      else if (o.pendiente === 'repuesta') pendiente = `<div class="aviso info" style="margin-top:8px">Lo que faltó (${lista}) se pidió en <b>${esc(codigoDe(o.pendiente_orden_id))}</b>.</div>`;
      else pendiente = `<div class="aviso" style="margin-top:8px">Lo que faltó (${lista}) se cerró sin reponer.</div>`;
    }
  }
  let reparto = '';
  if (o.estado === 'recibida') {
    const rec = (A.recepciones || []).filter((r) => r.orden_id === o.id);
    const falta = rec.filter((r) => r.cantidad_recibida < r.cantidad_solicitada);
    reparto = `${falta.length ? `<div class="aviso warn" style="margin-top:8px">Llegó menos de lo pedido: ${falta.map((r) => { const i = A.insumos.find((x) => x.id === r.insumo_id) || { nombre: 'Insumo', unidad: '' }; return `${esc(i.nombre)} ${esc(r.cantidad_recibida)} de ${esc(r.cantidad_solicitada)}`; }).join(', ')}.</div>` : ''}
      <div style="margin-top:8px"><b>Reparto por rancho</b></div>
      ${entregasDeOrden(o.id).map((e) => {
        const [ec, et] = ESTADOS_ENTREGA[e.estado] || ['gris', e.estado];
        const lineas = lineasDeEntrega(A.solicitudes, A.insumos, o.id, e.rancho_id);
        return `<div class="ev"><div class="fila"><b>${esc(e.codigo)}</b><span class="estado ${ec}">${esc(et)}</span></div>
          <span>${esc(nombreRancho(e.rancho_id))}</span><br>
          <span class="suave">${lineas.map((l) => `${esc(l.nombre)}: ${esc(l.asignada ?? '?')} de ${esc(l.pedida)} ${esc(l.unidad)}`).join(' · ')}</span>
          ${e.estado === 'por_entregar' ? `<div><button class="btn chico" style="margin-top:6px" data-accion="entrega-marcar" data-id="${esc(e.id)}">Marcar entregada</button></div>` : ''}</div>`;
      }).join('')}`;
  } else if (o.estado !== 'borrador') {
    reparto = `<p class="suave" style="margin:8px 0 0">El reparto por rancho aparece al registrar la recepción.</p>`;
  }
  return `<div class="ev"><div class="fila"><b>${esc(o.codigo || '')}</b><span class="estado ${cls}">${esc(txt)}</span></div>
    <span>${esc(TIPOS_DEST[o.destinatario_tipo] || '')}: ${esc(o.destinatario)}</span><br>
    <span class="suave">${esc(fechaCorta(String(o.creada_en).slice(0, 10)))}${o.nota ? ` · ${esc(o.nota)}` : ''}</span>
    ${lineaEntregaVet(o) ? `<div style="margin-top:4px"><b>${esc(lineaEntregaVet(o))}</b></div>` : ''}
    <div>${items.map((i) => `${esc(i.nombre)}: ${esc(i.total)} ${esc(i.unidad)}`).join('<br>')}</div>
    <div style="margin-top:6px"><button class="btn chico" data-accion="orden-copiar" data-id="${esc(o.id)}">Copiar texto</button>${accion}</div>
    ${vetCtl}${origen}${recepcion}${reparto}${pendiente}</div>`;
}

function tarjetaCorte() {
  const A = S.asoc;
  if (!A.corte) return '';
  const ahora = new Date();
  const r = resumenCorte(A.solicitudes, ahora, A.corte.dia, A.corte.hora);
  const abierto = A.corteAbierto || !!A.corteError;
  const dias = DIAS_SEMANA.map((d, i) => `<option value="${i}" ${A.corte.dia === i ? 'selected' : ''}>${d}</option>`).join('');
  const horas = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${A.corte.hora === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  return `<div class="card"><b>Corte semanal</b>
    <p style="margin:6px 0 0">Próximo corte: <b>${esc(textoCorte(A.corte.dia, A.corte.hora))}</b> · ${esc(textoFalta(ahora, r.proximo))}</p>
    <p class="suave" style="margin:4px 0 0">Pendientes recibidas después del último corte: ${esc(r.nuevas)}.</p>
    ${r.rezagadas ? `<div class="aviso warn" style="margin-top:8px">${esc(r.rezagadas)} solicitud(es) pendiente(s) llegaron <b>antes del último corte</b> y siguen sin consolidar.</div>` : ''}
    ${abierto ? `<label for="corteDia">Cambiar día y hora del corte</label>
    <select id="corteDia" class="campo">${dias}</select>
    <select id="corteHora" class="campo" style="margin-top:8px">${horas}</select>
    ${A.corteError ? `<div class="aviso mal" style="margin-top:10px">${esc(A.corteError)}</div>` : ''}
    <button class="btn" style="margin-top:10px" data-accion="corte-guardar">Guardar corte</button>
    <button class="btn chico" style="margin-top:8px" data-accion="corte-toggle">Cerrar</button>` : `<button class="btn chico" style="margin-top:10px" data-accion="corte-toggle" aria-expanded="false">Cambiar día y hora ▾</button>`}</div>`;
}

async function guardarCorte() {
  const A = S.asoc;
  const dia = Number(document.getElementById('corteDia').value), hora = Number(document.getElementById('corteHora').value);
  try {
    await api.rest('POST', '/rpc/configurar_corte', { p_coop: A.coop.id, p_dia: dia, p_hora: hora });
    A.corteError = null; A.corteAbierto = false;
    toast('Corte guardado');
    await cargarAsoc();
  } catch (e) { A.corteError = msgError(e); render(); }
}


function vistaAsoc() {
  const A = S.asoc;
  if (!A) return vistaInicio();
  const grupos = agruparSolicitudes(A.solicitudes, A.insumos, A.ranchos);
  const demanda = grupos.map((g) => `<label class="fila" style="font-weight:400;margin:0;padding:10px 0;border-top:1px solid var(--linea);align-items:flex-start">
      <input type="checkbox" data-grupo="${esc(g.insumo_id)}" ${A.sel && A.sel.has(g.insumo_id) ? 'checked' : ''} style="width:26px;height:26px;margin-top:2px">
      <span style="flex:1"><b>${esc(g.nombre)}</b> · ${esc(g.total)} ${esc(g.unidad)}<br><span class="suave">${g.ranchos.map((r) => `${esc(r.rancho)}: ${esc(r.cantidad)}`).join(' · ')}</span></span></label>`).join('');
  const f = A.form;
  const ordenes = A.ordenes.map((o) => tarjetaOrden(o)).join('');
  const catalogo = A.insumos.map((i) => `<div class="ev"><span>${esc(i.nombre)}</span> <span class="suave">· ${esc(i.unidad)}${i.activo ? '' : ' · inactivo'}</span></div>`).join('');
  return marco(`
    <button class="atras" data-accion="ir" data-vista="inicio">‹ Inicio</button>
    <h2>Panel de la asociación</h2>
    <p class="suave">${esc(A.coop ? A.coop.nombre : '')}. Aquí ves lo que piden los ranchos para comprar en conjunto. No ves sus vacas ni sus registros. Necesita internet.</p>
    ${A.error ? `<div class="aviso mal">${esc(A.error)}</div>` : ''}
    ${A.cargando ? '<p class="suave">Cargando…</p>' : `
    ${tarjetaCorte()}
    <div class="card"><b>Demanda pendiente</b>${demanda || '<p class="suave">No hay solicitudes pendientes.</p>'}</div>
    ${grupos.length ? `<div class="card"><b>Crear compra consolidada</b>
      <p class="suave" style="margin:4px 0 0">Incluye los insumos marcados arriba.</p>
      <label for="tipoDest">Se compra a</label>
      <select id="tipoDest" class="campo">${Object.entries(TIPOS_DEST).map(([k, v]) => `<option value="${k}" ${f.tipo === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label for="destinatario">Nombre</label>
      <input id="destinatario" type="text" value="${esc(f.destinatario)}" placeholder="Dr. Nombre o proveedor">
      <label for="notaOrden">Nota (opcional)</label>
      <input id="notaOrden" type="text" value="${esc(f.nota)}">
      ${A.formError ? `<div class="aviso mal" style="margin-top:10px">${esc(A.formError)}</div>` : ''}
      <button class="btn primario" style="margin-top:12px" data-accion="asoc-consolidar">Crear compra consolidada</button></div>` : ''}
    <div class="card"><b>Compras consolidadas</b>${ordenes || '<p class="suave">Aún no hay compras.</p>'}<p class="suave">Una compra no se puede deshacer desde aquí.</p></div>
    <div class="card"><b>Catálogo de insumos</b>${catalogo || '<p class="suave">Vacío.</p>'}
      <label for="insNombre">Agregar insumo</label><input id="insNombre" type="text" value="${esc(A.insForm.nombre)}" placeholder="Nombre">
      <input id="insUnidad" type="text" style="margin-top:8px" value="${esc(A.insForm.unidad)}" placeholder="Unidad (caja, dosis, litro…)">
      ${A.insError ? `<div class="aviso mal" style="margin-top:10px">${esc(A.insError)}</div>` : ''}
      <button class="btn" style="margin-top:10px" data-accion="insumo-crear">Agregar al catálogo</button></div>`}
    ${pie()}`);
}

function capturarFormAsoc() {
  const A = S.asoc;
  if (!A) return;
  const g = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
  if (g('tipoDest') !== null) A.form = { tipo: g('tipoDest'), destinatario: g('destinatario') || '', nota: g('notaOrden') || '' };
  if (g('insNombre') !== null) A.insForm = { nombre: g('insNombre') || '', unidad: g('insUnidad') || '' };
}

async function consolidar() {
  const A = S.asoc;
  capturarFormAsoc();
  const f = A.form;
  const ids = [...(A.sel || [])];
  if (!ids.length) { A.formError = 'Marca al menos un insumo.'; render(); return; }
  if (!f.destinatario.trim() || f.destinatario.trim().length < 2) { A.formError = 'Escribe a quién se compra.'; render(); return; }
  const grupos = agruparSolicitudes(A.solicitudes, A.insumos, A.ranchos).filter((g) => A.sel.has(g.insumo_id));
  if (!window.confirm(`Se creará una compra a ${f.destinatario.trim()} con ${grupos.map((g) => `${g.total} ${g.unidad} de ${g.nombre}`).join(', ')}. Los ranchos ya no podrán cancelar esas solicitudes. ¿Continuar?`)) return;
  try {
    await api.rest('POST', '/rpc/consolidar_solicitudes', { p_cooperativa: A.coop.id, p_tipo: f.tipo, p_destinatario: f.destinatario.trim(), p_nota: f.nota.trim() || null, p_insumo_ids: ids });
    A.form = { tipo: f.tipo, destinatario: '', nota: '' };
    A.formError = null;
    A.sel = null;
    limpiarCampos('destinatario', 'notaOrden');
    toast('Compra consolidada creada');
    await cargarAsoc();
  } catch (e) { A.formError = e.status === 404 ? 'No hay solicitudes pendientes para esos insumos.' : msgError(e); render(); }
}

async function cambiarEstadoOrden(id, estado) {
  try {
    const filas = await api.rest('PATCH', `/ordenes_consolidadas?id=eq.${encodeURIComponent(id)}`, { estado }, { Prefer: 'return=representation' });
    if (!Array.isArray(filas) || !filas.length) toast('No se pudo actualizar.');
  } catch (e) { toast(msgError(e)); }
  await cargarAsoc();
}

async function copiarOrden(id) {
  const o = S.asoc.ordenes.find((x) => x.id === id);
  if (!o) return;
  const lineas = itemsDeOrden(id).map((i) => `- ${i.nombre}: ${i.total} ${i.unidad}`);
  const ents = entregasDeOrden(id).map((e) => `${e.codigo} · ${nombreRancho(e.rancho_id)}: ${lineasDeEntrega(S.asoc.solicitudes, S.asoc.insumos, id, e.rancho_id).map((l) => `${l.nombre} ${l.asignada ?? l.pedida} ${l.unidad}`).join(', ')}`);
  const procede = o.origen_orden_id ? `\nProcede de ${(S.asoc.ordenes.find((q) => q.id === o.origen_orden_id) || {}).codigo || 'otra compra'} (lo que faltó por llegar)` : '';
  const texto = `Compra consolidada ${o.codigo || ''} · ${S.asoc.coop ? S.asoc.coop.nombre : ''}${procede}\nPara: ${o.destinatario}${lineaEntregaVet(o) ? `\n${lineaEntregaVet(o)}` : ''}\n${lineas.join('\n')}${ents.length ? `\nReparto:\n${ents.join('\n')}` : ''}${o.nota ? `\nNota: ${o.nota}` : ''}`;
  try { await navigator.clipboard.writeText(texto); toast('Texto copiado'); } catch { window.prompt('Copia este texto:', texto); }
}

function abrirRecepcion(ordenId) {
  const valores = {};
  for (const x of S.asoc.solicitudes) if (x.orden_id === ordenId) valores[x.insumo_id] = String((Number(valores[x.insumo_id]) || 0) + x.cantidad);
  S.asoc.recep = { ordenId, valores, error: null };
  render();
}

async function confirmarRecepcion(ordenId) {
  const R = S.asoc.recep;
  const recibido = {};
  for (const [id, v] of Object.entries(R.valores)) {
    const n = Number(v);
    if (String(v).trim() === '' || !Number.isInteger(n) || n < 0) { R.error = 'Escribe cuánto llegó de cada insumo (número entero, 0 si no llegó).'; render(); return; }
    recibido[id] = n;
  }
  const resumen = itemsDeOrden(ordenId).length;
  if (!window.confirm(`Se registrará la recepción de ${resumen} insumo(s) y se repartirá entre los ranchos. No se puede deshacer desde aquí. ¿Continuar?`)) return;
  try {
    await api.rest('POST', '/rpc/recibir_orden', { p_orden: ordenId, p_recibido: recibido });
    S.asoc.recep = null;
    toast('Recepción registrada y repartida');
    await cargarAsoc();
  } catch (e) { R.error = msgError(e); render(); }
}

async function asignarVet(id, quitar) {
  const campo = document.getElementById(`vetc-${id}`);
  const correo = quitar ? '' : (campo ? campo.value.trim() : '');
  if (!quitar && !/^\S+@\S+\.\S+$/.test(correo)) { toast('Escribe un correo válido.'); return; }
  try {
    await api.rest('POST', '/rpc/asignar_veterinario_orden', { p_orden: id, p_correo: correo });
    toast(quitar ? 'Acceso quitado' : 'Listo: el doctor la verá en su app');
  } catch (e) { toast(msgError(e)); }
  await cargarAsoc();
}

async function generarPendiente(id) {
  const o = S.asoc.ordenes.find((x) => x.id === id);
  if (!window.confirm(`Se creará una compra nueva con lo que faltó de ${o ? o.codigo : 'esta compra'}, con su propio código y entregas por rancho. No se puede deshacer desde aquí. ¿Continuar?`)) return;
  try {
    const nueva = await api.rest('POST', '/rpc/generar_orden_pendiente', { p_orden: id });
    await cargarAsoc();
    const n = S.asoc.ordenes.find((x) => x.id === nueva);
    toast(`Compra ${n ? n.codigo : 'nueva'} creada con lo pendiente`);
  } catch (e) { toast(msgError(e)); await cargarAsoc(); }
}

async function cerrarPendiente(id) {
  if (!window.confirm('Lo que faltó por llegar se dará por cerrado y no se volverá a pedir desde aquí. ¿Continuar?')) return;
  try { await api.rest('POST', '/rpc/cerrar_pendiente', { p_orden: id }); toast('Pendiente cerrado'); }
  catch (e) { toast(msgError(e)); }
  await cargarAsoc();
}

async function marcarEntrega(id) {
  try { await api.rest('POST', '/rpc/marcar_entrega', { p_entrega: id }); toast('Entrega marcada'); }
  catch (e) { toast(msgError(e)); }
  await cargarAsoc();
}

async function crearInsumo() {
  const A = S.asoc;
  capturarFormAsoc();
  const nombre = A.insForm.nombre.trim();
  const unidad = A.insForm.unidad.trim();
  if (nombre.length < 2 || !unidad) { A.insError = 'Escribe el nombre y la unidad.'; render(); return; }
  try {
    await api.rest('POST', '/insumos', { cooperativa_id: A.coop.id, nombre, unidad }, { Prefer: 'return=minimal' });
    A.insForm = { nombre: '', unidad: '' };
    A.insError = null;
    limpiarCampos('insNombre', 'insUnidad');
    toast('Insumo agregado');
    await cargarAsoc();
  } catch (e) { A.insError = e.status === 409 ? 'Ese insumo ya existe.' : msgError(e); render(); }
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
    case 'ficha': S.fichaId = el.dataset.id; S.fichaDesde = S.vista === 'atender' ? 'atender' : 'vacas'; ir('ficha'); break;
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
    case 'panel-grupo': { const r = S.ranchos.find((x) => x.id === el.dataset.id); if (r) { S.rancho = r; S.tabAtender = 'ver'; S.grupoAtender = el.dataset.grupo; await store.setMeta('ranchoActivo', r.id); await refrescar(); ir('atender', true); } break; }
    case 'atender-todas': S.grupoAtender = null; render(); break;
    case 'panel-abrir': { const r = S.ranchos.find((x) => x.id === el.dataset.id); if (r) { S.rancho = r; S.tabAtender = 'ver'; S.grupoAtender = null; await store.setMeta('ranchoActivo', r.id); await refrescar(); ir('atender'); } break; }
    case 'abrir-insumos': await abrirInsumos(); break;
    case 'sol-enviar': await enviarSolicitud(); break;
    case 'sol-cancelar': await cancelarSolicitud(el.dataset.id); break;
    case 'abrir-asoc': await abrirAsoc(); break;
    case 'asoc-consolidar': await consolidar(); break;
    case 'orden-estado': await cambiarEstadoOrden(el.dataset.id, el.dataset.estado); break;
    case 'tab-atender': S.tabAtender = el.dataset.tab; render(); break;
    case 'orden-vacas': S.ordenVacas = el.dataset.orden; pintarResultados(); break;
    case 'ins-elegir': {
      const it = S.ped.form.items; const id = el.dataset.id;
      if (Object.prototype.hasOwnProperty.call(it, id)) delete it[id]; else it[id] = '';
      S.ped.formError = null; render();
      const campo = document.getElementById(`cant-${id}`); if (campo) campo.focus();
      break;
    }
    case 'sug-usar': S.ped.form.items[el.dataset.id] = el.dataset.cant; S.ped.formError = null; render(); { const c = document.getElementById(`cant-${el.dataset.id}`); if (c) c.scrollIntoView({ block: 'center' }); } break;
    case 'corte-guardar': await guardarCorte(); break;
    case 'est-guardar': await guardarEstimacion(el.dataset.id); break;
    case 'corte-toggle': S.asoc.corteAbierto = !S.asoc.corteAbierto; S.asoc.corteError = null; render(); break;
    case 'est-abrir': S.ped.configAbierta = true; S.ped.estError = null; render(); break;
    case 'est-cerrar': S.ped.configAbierta = false; render(); break;
    case 'orden-copiar': await copiarOrden(el.dataset.id); break;
    case 'orden-recibir': abrirRecepcion(el.dataset.id); break;
    case 'recep-confirmar': await confirmarRecepcion(el.dataset.id); break;
    case 'recep-cancelar': S.asoc.recep = null; render(); break;
    case 'vet-asignar': await asignarVet(el.dataset.id, false); break;
    case 'vet-quitar': await asignarVet(el.dataset.id, true); break;
    case 'pend-generar': await generarPendiente(el.dataset.id); break;
    case 'pend-cerrar': await cerrarPendiente(el.dataset.id); break;
    case 'entrega-marcar': await marcarEntrega(el.dataset.id); break;
    case 'entrega-confirmar': await confirmarEntrega(el.dataset.id); break;
    case 'insumo-crear': await crearInsumo(); break;
    default: break;
  }
});

$app.addEventListener('input', (ev) => {
  if (ev.target.dataset && ev.target.dataset.rec && S.asoc && S.asoc.recep) {
    S.asoc.recep.valores[ev.target.dataset.rec] = ev.target.value;
    const prev = document.getElementById('repartoPrev');
    if (prev) prev.innerHTML = textoReparto(S.asoc.recep.ordenId, S.asoc.recep.valores);
    return;
  }
  if (ev.target.dataset && ev.target.dataset.cant && S.ped) {
    if (Object.prototype.hasOwnProperty.call(S.ped.form.items, ev.target.dataset.cant)) S.ped.form.items[ev.target.dataset.cant] = ev.target.value;
    const r = document.getElementById('resumenPedido'); if (r) r.outerHTML = htmlResumenPedido();
    const bt = document.querySelector('[data-accion="sol-enviar"]'); if (bt) bt.textContent = textoBotonEnviar();
    return;
  }
  if (ev.target.id === 'arete') { S.reg.arete = ev.target.value; pintarResultados(); }
  else if (ev.target.id === 'filtro') {
    S.filtro = ev.target.value;
    document.getElementById('lista').innerHTML = htmlVacasAgrupadas();
  }
});

$app.addEventListener('change', async (ev) => {
  if (ev.target.dataset && ev.target.dataset.grupo && S.asoc) {
    if (ev.target.checked) S.asoc.sel.add(ev.target.dataset.grupo); else S.asoc.sel.delete(ev.target.dataset.grupo);
    return;
  }
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
  S.rancho = null; S.ranchos = []; S.admin = []; S.panel = []; S.comprasVet = []; S.ped = null; S.asoc = null; S.animales = []; S.eventos = []; S.reg = null; S.vista = 'inicio';
  render();
}

// ---------- Arranque ----------

async function abrirUsuario(primeraVez = false) {
  if (store) store.close();
  store = await openIdbStore(user.id);
  sync = createSync({ store, api });
  S.ranchos = (await store.getMeta('ranchos')) || [];
  S.admin = (await store.getMeta('admin')) || [];
  S.comprasVet = (await store.getMeta('comprasVet')) || [];
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
