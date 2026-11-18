// HATO · lógica pura (sin DOM, sin red). Se prueba en Node.

export const PARAMS = {
  diasDiagnostico: 30,   // días tras el servicio para sugerir diagnóstico (a validar con el MVZ)
  gestacion: 283,        // días de gestación bovina típica (a validar con el MVZ)
  esperaServicio: 45,    // días posparto antes de marcar "lista para servicio" (a validar con el MVZ)
  avisoParto: 15,        // días antes del parto esperado para avisar
};

export const TIPOS = [
  { id: 'celo',         icono: '👀', texto: 'Celo' },
  { id: 'inseminacion', icono: '💉', texto: 'Inseminación' },
  { id: 'monta',        icono: '🐂', texto: 'Monta natural' },
  { id: 'diagnostico',  icono: '🔍', texto: 'Diagnóstico' },
  { id: 'parto',        icono: '🐄', texto: 'Parto' },
  { id: 'aborto',       icono: '⚠️', texto: 'Aborto' },
  { id: 'secado',       icono: '🥛', texto: 'Secado' },
  { id: 'descarte',     icono: '🚫', texto: 'Descarte' },
  { id: 'tratamiento',  icono: '💊', texto: 'Tratamiento' },
  { id: 'nota',         icono: '📝', texto: 'Nota' },
];

export function textoTipo(id) {
  if (id === 'anulacion') return 'Registro anulado';
  return (TIPOS.find((t) => t.id === id) || { texto: id }).texto;
}

/** UUID v4 (usa crypto si existe). */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

/** Fecha local del dispositivo como YYYY-MM-DD (nunca UTC). */
export function hoyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function aUTC(fecha) {
  const [y, m, d] = String(fecha).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Días de a hasta b (b - a). */
export function diasEntre(a, b) {
  return Math.round((aUTC(b) - aUTC(a)) / 86400000);
}

export function sumarDias(fecha, n) {
  const d = new Date(aUTC(fecha) + n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function fechaCorta(fecha) {
  if (!fecha) return '';
  const [y, m, d] = fecha.split('-');
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(d)} ${meses[Number(m) - 1]} ${y}`;
}

export function normArete(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Valida un evento antes de guardarlo. Devuelve texto de error o null. */
export function validarEvento({ tipo, datos = {}, fecha }, hoy) {
  if (!TIPOS.some((t) => t.id === tipo)) return 'Elige qué pasó con la vaca.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return 'La fecha no es válida.';
  if (fecha < '2000-01-01') return 'La fecha es demasiado antigua.';
  if (diasEntre(hoy, fecha) > 0) return 'La fecha no puede ser futura.';
  if (tipo === 'diagnostico' && !['prenada', 'vacia', 'dudosa'].includes(datos.resultado)) return 'Elige el resultado del diagnóstico.';
  if (tipo === 'parto' && !['hembra', 'macho', 'mellizos', 'nacio_muerta'].includes(datos.cria)) return 'Elige qué nació.';
  if (tipo === 'nota' && !String(datos.texto || '').trim()) return 'Escribe la nota.';
  if (tipo === 'tratamiento' && !String(datos.descripcion || '').trim()) return 'Escribe el tratamiento.';
  return null;
}

/** Eventos vigentes: sin las anulaciones ni los eventos anulados, ordenados. */
export function eventosVigentes(eventos) {
  const anulados = new Set(eventos.filter((e) => e.tipo === 'anulacion' && e.anula_a).map((e) => e.anula_a));
  return eventos
    .filter((e) => e.tipo !== 'anulacion' && !anulados.has(e.id))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : String(a.dispositivo_ts || '').localeCompare(String(b.dispositivo_ts || '')) || String(a.id).localeCompare(String(b.id))));
}

/**
 * Estado reproductivo derivado de los eventos (nunca se guarda).
 * Reglas v1: simples y pendientes de validar con un MVZ.
 */
export function estadoVaca(eventos, hoy, P = PARAMS) {
  const evs = eventosVigentes(eventos);
  if (!evs.length) {
    return { codigo: 'sin_datos', texto: 'Sin registros', dias: null, alerta: false, prioridad: 9, detalle: '', partoEsperado: null, diasAbiertos: null, ultimoParto: null };
  }
  let gestante = false, secada = false, descartada = false, servida = false, enCelo = false, abierta = false;
  let ultimoServicio = null, ultimoParto = null, dxDudoso = false;
  for (const e of evs) {
    const d = e.datos || {};
    switch (e.tipo) {
      case 'parto': ultimoParto = e.fecha; gestante = false; secada = false; servida = false; enCelo = false; abierta = false; ultimoServicio = null; dxDudoso = false; break;
      case 'aborto': gestante = false; secada = false; servida = false; enCelo = false; abierta = true; ultimoServicio = null; dxDudoso = false; break;
      case 'inseminacion':
      case 'monta': ultimoServicio = e.fecha; servida = true; enCelo = false; abierta = false; gestante = false; dxDudoso = false; break;
      case 'diagnostico':
        if (d.resultado === 'prenada') { gestante = true; servida = false; abierta = false; enCelo = false; dxDudoso = false; }
        else if (d.resultado === 'vacia') { gestante = false; servida = false; abierta = true; enCelo = false; dxDudoso = false; }
        else if (d.resultado === 'dudosa') { dxDudoso = true; }
        break;
      case 'celo':
        if (!gestante) { enCelo = true; servida = false; abierta = false; }
        break;
      case 'secado': secada = true; break;
      case 'descarte': descartada = true; break;
      default: break;
    }
  }
  const diasAbiertos = !gestante && ultimoParto ? diasEntre(ultimoParto, hoy) : null;
  const base = { partoEsperado: null, diasAbiertos, ultimoParto };

  if (descartada) return { ...base, codigo: 'descartada', texto: 'Descartada', dias: null, alerta: false, prioridad: 9, detalle: '' };

  if (gestante) {
    const partoEsperado = ultimoServicio ? sumarDias(ultimoServicio, P.gestacion) : null;
    const dias = ultimoServicio ? diasEntre(ultimoServicio, hoy) : null;
    const faltan = partoEsperado ? diasEntre(hoy, partoEsperado) : null;
    const proximo = faltan !== null && faltan <= P.avisoParto;
    const texto = secada ? 'Seca y gestante' : 'Gestante';
    let detalle = dias !== null ? `${dias} días de gestación` : 'Sin fecha de servicio';
    if (partoEsperado) detalle += ` · parto esperado ${fechaCorta(partoEsperado)}`;
    return { ...base, partoEsperado, codigo: proximo ? 'parto_proximo' : 'gestante', texto: proximo ? `${texto} · parto próximo` : texto, dias, alerta: proximo, prioridad: proximo ? 2 : 8, detalle };
  }
  if (servida && ultimoServicio) {
    const dias = diasEntre(ultimoServicio, hoy);
    const toca = dias >= P.diasDiagnostico;
    return { ...base, codigo: toca ? 'diagnosticar' : 'servida', texto: toca ? 'Servida · toca diagnóstico' : 'Servida · esperando diagnóstico', dias, alerta: toca, prioridad: toca ? 1 : 7, detalle: `Servicio hace ${dias} días${dxDudoso ? ' · diagnóstico dudoso' : ''}` };
  }
  if (enCelo) return { ...base, codigo: 'celo', texto: 'En celo · inseminar', dias: null, alerta: true, prioridad: 3, detalle: '' };
  if (abierta) return { ...base, codigo: 'abierta', texto: 'Vacía · abierta', dias: diasAbiertos, alerta: true, prioridad: 4, detalle: diasAbiertos !== null ? `${diasAbiertos} días abiertos` : '' };
  if (ultimoParto) {
    const toca = diasAbiertos >= P.esperaServicio;
    return { ...base, codigo: toca ? 'lista' : 'posparto', texto: toca ? 'Lista para servicio' : 'Posparto', dias: diasAbiertos, alerta: toca, prioridad: toca ? 5 : 6, detalle: `${diasAbiertos} días posparto` };
  }
  return { ...base, codigo: 'sin_estado', texto: 'Sin estado reproductivo', dias: null, alerta: false, prioridad: 9, detalle: '' };
}

/** Qué tipo de registro suele tocar según el estado (para mostrarlo primero). */
export function tipoSugerido(estado) {
  switch (estado.codigo) {
    case 'diagnosticar': case 'servida': return 'diagnostico';
    case 'celo': case 'abierta': case 'lista': return 'inseminacion';
    case 'parto_proximo': return 'parto';
    case 'posparto': return 'celo';
    default: return null;
  }
}

export function ordenarTipos(sugerido) {
  if (!sugerido) return TIPOS;
  return [TIPOS.find((t) => t.id === sugerido), ...TIPOS.filter((t) => t.id !== sugerido)];
}

/** Texto humano de un error del servidor para un registro pendiente. */
export function textoError(e) {
  if (!e) return '';
  if (e.code === '42501' || e.status === 403) return 'Sin permiso en este rancho.';
  if (e.code === '23503') return 'La vaca de este registro no existe en el servidor.';
  if (e.code === '23514' || e.code === '22P02' || e.status === 400 || e.status === 422) return 'El servidor rechazó un dato.';
  return e.message || 'No se pudo enviar.';
}

// ---------- Panel del veterinario ----------
// Umbrales PROVISIONALES: pendientes de validar con un MVZ.
export const UMBRALES = { visitaMin: 5, diasSinDatos: 14 };

/** Último dato que el servidor recibió de un rancho (ISO) o null. Ignora lo que aún está solo en el teléfono. */
export function ultimoDatoTs(animales, eventos) {
  let max = null;
  for (const x of [...animales, ...eventos]) {
    if (x._sync && x._sync !== 'ok') continue;
    if (x.recibido_en && (!max || x.recibido_en > max)) max = x.recibido_en;
  }
  return max;
}

/** Resumen de pendientes de un rancho a partir de sus vacas y eventos. */
export function resumenRancho(animales, eventos, hoy, ahoraMs = Date.now(), P = PARAMS) {
  const porVaca = new Map();
  for (const e of eventos) {
    if (!porVaca.has(e.animal_id)) porVaca.set(e.animal_id, []);
    porVaca.get(e.animal_id).push(e);
  }
  const r = { vacas: animales.length, diagnosticar: 0, partoProximo: 0, celo: 0, abiertas: 0, listas: 0, alertas: 0, proxima: null, ultimoDato: ultimoDatoTs(animales, eventos), diasSinDatos: null };
  let proxima = null;
  const candidata = (fecha, texto) => { if (!proxima || fecha < proxima.fecha) proxima = { fecha, texto }; };
  for (const a of animales) {
    const est = estadoVaca(porVaca.get(a.id) || [], hoy, P);
    if (est.alerta) r.alertas++;
    switch (est.codigo) {
      case 'diagnosticar': r.diagnosticar++; break;
      case 'parto_proximo': r.partoProximo++; break;
      case 'celo': r.celo++; break;
      case 'abierta': r.abiertas++; break;
      case 'lista': r.listas++; break;
      case 'servida': candidata(sumarDias(hoy, P.diasDiagnostico - est.dias), 'diagnósticos'); break;
      case 'gestante': if (est.partoEsperado) candidata(sumarDias(est.partoEsperado, -P.avisoParto), 'partos próximos'); break;
      case 'posparto': candidata(sumarDias(hoy, P.esperaServicio - est.dias), 'vacas listas para servicio'); break;
      default: break;
    }
  }
  r.proxima = proxima;
  if (r.ultimoDato) r.diasSinDatos = Math.max(0, Math.floor((ahoraMs - new Date(r.ultimoDato).getTime()) / 86400000));
  return r;
}

/** Recomendación de visita/llamada. Reglas simples y explícitas; no sustituyen el criterio del veterinario. */
export function recomendarVisita(res, U = UMBRALES) {
  const enSitio = res.diagnosticar + res.partoProximo;
  const sinDatos = res.vacas > 0 && res.diasSinDatos !== null && res.diasSinDatos > U.diasSinDatos;
  const motivos = [];
  if (enSitio) motivos.push(`${res.diagnosticar} por diagnosticar y ${res.partoProximo} con parto próximo`);
  if (sinDatos) motivos.push(`${res.diasSinDatos} días sin datos`);
  if (res.vacas === 0) return { codigo: 'sin_vacas', texto: 'Sin vacas registradas', prioridad: 5, motivo: 'Aún no hay vacas capturadas en este rancho.' };
  if (enSitio >= U.visitaMin) {
    return { codigo: 'visitar', texto: 'Visitar esta semana', prioridad: 1, motivo: motivos.join(' · ') };
  }
  if (sinDatos) {
    return { codigo: 'sin_datos', texto: 'Llamar: sin datos recientes', prioridad: 3, motivo: `${motivos.join(' · ')}. Cero pendientes puede significar que nadie está capturando.` };
  }
  if (res.alertas > 0) {
    return { codigo: 'llamar', texto: 'Llamar primero', prioridad: 2, motivo: `${res.alertas} vaca(s) por atender; pocas para justificar el viaje.` };
  }
  return { codigo: 'sin_urgencia', texto: 'Sin urgencia', prioridad: 4, motivo: res.proxima ? `Próximos pendientes: ${res.proxima.texto} desde el ${fechaCorta(res.proxima.fecha)}.` : 'Sin pendientes a la vista.' };
}

// ---------- Panel de la asociación ----------

/** Agrupa solicitudes pendientes por insumo, con el desglose por rancho. */
export function agruparSolicitudes(solicitudes, insumos, ranchos) {
  const insumoPor = new Map(insumos.map((i) => [i.id, i]));
  const ranchoPor = new Map(ranchos.map((r) => [r.id, r]));
  const grupos = new Map();
  for (const s of solicitudes) {
    if (s.estado !== 'pendiente') continue;
    const ins = insumoPor.get(s.insumo_id);
    if (!ins) continue;
    if (!grupos.has(ins.id)) grupos.set(ins.id, { insumo_id: ins.id, nombre: ins.nombre, unidad: ins.unidad, total: 0, ranchos: new Map() });
    const g = grupos.get(ins.id);
    g.total += s.cantidad;
    const nombre = ranchoPor.get(s.rancho_id)?.nombre || 'Rancho';
    g.ranchos.set(nombre, (g.ranchos.get(nombre) || 0) + s.cantidad);
  }
  return [...grupos.values()]
    .map((g) => ({ ...g, ranchos: [...g.ranchos.entries()].map(([rancho, cantidad]) => ({ rancho, cantidad })).sort((a, b) => b.cantidad - a.cantidad) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

export function validarSolicitud({ insumo_id, cantidad }) {
  if (!insumo_id) return 'Elige el insumo.';
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 1 || n > 100000) return 'La cantidad debe ser un número entero mayor que cero.';
  return null;
}

/** Reparto de lo recibido entre las solicitudes de un insumo. Espejo de public.recibir_orden (SQL):
 * si llegó todo o más, cada una recibe lo pedido; si llegó menos, reparto proporcional y los residuos van al mayor decimal
 * (empate: la solicitud más antigua; luego por id). Devuelve Map id -> cantidad asignada. */
export function repartir(solicitudes, recibido) {
  const total = solicitudes.reduce((a, s) => a + s.cantidad, 0);
  const out = new Map();
  if (recibido >= total) { for (const s of solicitudes) out.set(s.id, s.cantidad); return out; }
  let asignado = 0;
  const filas = solicitudes.map((s) => {
    const base = Math.floor((s.cantidad * recibido) / total);
    asignado += base;
    return { s, base, resto: (s.cantidad * recibido) % total };
  });
  filas.sort((a, b) => b.resto - a.resto || String(a.s.creado_en).localeCompare(String(b.s.creado_en)) || String(a.s.id).localeCompare(String(b.s.id)));
  let sobran = recibido - asignado;
  for (const f of filas) { out.set(f.s.id, f.base + (sobran > 0 ? 1 : 0)); if (sobran > 0) sobran--; }
  return out;
}

/** Líneas de una entrega (un rancho dentro de una compra): pedido vs asignado por insumo. */
export function lineasDeEntrega(solicitudes, insumos, ordenId, ranchoId) {
  const porInsumo = new Map();
  for (const s of solicitudes) {
    if (s.orden_id !== ordenId || s.rancho_id !== ranchoId) continue;
    const l = porInsumo.get(s.insumo_id) || { pedida: 0, asignada: 0, conAsignacion: false };
    l.pedida += s.cantidad;
    if (s.cantidad_asignada !== null && s.cantidad_asignada !== undefined) { l.asignada += s.cantidad_asignada; l.conAsignacion = true; }
    porInsumo.set(s.insumo_id, l);
  }
  return [...porInsumo.entries()].map(([id, l]) => {
    const i = insumos.find((x) => x.id === id) || { nombre: 'Insumo', unidad: '' };
    return { nombre: i.nombre, unidad: i.unidad, pedida: l.pedida, asignada: l.conAsignacion ? l.asignada : null };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
