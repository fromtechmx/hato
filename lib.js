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
