// utils/planVersiones.js
//
// El plan de trabajos de una obra tiene VERSIONES:
//
//   versión 0   el plan original, un registro por mes.
//   versión 1+  cada replanteo. Rige desde el día siguiente a su fecha de
//               corte: hasta el corte manda el avance real, que ya pasó y no
//               se replanifica; desde ahí, los meses de esa versión.
//
// Antes de esto el replanteo era una planificación suelta más. El sistema no
// podía saber qué meses formaban un mismo replanteo ni qué parte del plan
// quedaba reemplazada, y eso producía tres errores a la vez: el disponible no
// descontaba lo ya replanteado, la curva pasaba del 100%, y la curva
// "planificado" sumaba el original encima del replanteo.

export const r2 = (n) => Number(Number(n || 0).toFixed(2));

export const norm = (x) => {
  if (!x) return "";
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  return String(x).slice(0, 10);
};

const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));
export { esFecha };

/** Agrupa planificaciones por versión, ordenadas de la más vieja a la vigente. */
export function agruparVersiones(planificaciones) {
  const mapa = new Map();
  for (const p of planificaciones) {
    const version = Number(p.version || 0);
    if (!mapa.has(version)) {
      mapa.set(version, {
        version,
        tipo: version === 0 ? "original" : "replanteo",
        motivo: null,
        fecha_corte: null,
        filas: [],
      });
    }
    const grupo = mapa.get(version);
    grupo.filas.push(p);
    if (version > 0) {
      grupo.motivo = grupo.motivo || p.motivo || null;
      grupo.fecha_corte = grupo.fecha_corte || norm(p.fecha_corte) || null;
    }
  }
  const versiones = [...mapa.values()].sort((a, b) => a.version - b.version);
  for (const v of versiones) {
    v.filas.sort((a, b) => (norm(a.fecha_desde) < norm(b.fecha_desde) ? -1 : 1));
    v.fecha_desde = norm(v.filas[0]?.fecha_desde) || null;
    v.fecha_hasta = norm(v.filas[v.filas.length - 1]?.fecha_hasta) || null;
  }
  return versiones;
}

/** Fecha en la que cierra un avance: fin de su período, o la del avance. */
export const cierreDeAvance = (a) => norm(a.periodo_hasta) || norm(a.fecha_avance);

/** Última fecha con avance real cargado. Es el corte que se sugiere. */
export function ultimoCorte(avances) {
  let max = "";
  for (const a of avances) {
    const f = cierreDeAvance(a);
    if (f > max) max = f;
  }
  return max || null;
}

/** Porcentaje real acumulado por ítem, contando solo avances cerrados hasta el corte. */
export function avancePorItemHasta(avances, avanceItems, fechaCorte) {
  const incluidos = new Set(
    avances.filter((a) => !fechaCorte || cierreDeAvance(a) <= fechaCorte).map((a) => a.id)
  );
  const acumulado = {};
  for (const ai of avanceItems) {
    if (!incluidos.has(ai.avance_obra_id)) continue;
    acumulado[ai.pliego_item_id] = (acumulado[ai.pliego_item_id] || 0) + Number(ai.avance_porcentaje || 0);
  }
  return acumulado;
}

/** Lo que queda por planificar de un ítem: 100% menos lo ejecutado (topado en 100). */
export const disponibleDeItem = (acumulado) => Math.max(0, r2(100 - Math.min(100, Number(acumulado || 0))));

/** Índice del período de la curva en el que cae el corte (-1 si es anterior al eje). */
export function indiceDeCorte(periodos, fechaCorte) {
  const f = norm(fechaCorte);
  if (!f) return -1;
  let indice = -1;
  periodos.forEach((p, i) => { if (p.fecha_desde <= f) indice = i; });
  return indice;
}

/**
 * Serie de un replanteo sobre el eje de la curva.
 *
 * Arranca en el período del corte con el avance REAL acumulado a esa fecha, y
 * desde ahí suma lo que la versión planifica. Entre un mes y otro queda plana
 * (la curva es acumulada), así que no se corta en las quincenas sin datos.
 * Antes del corte y después de su último mes no tiene valor.
 *
 * @param curvaAvance  acumulado real con "Inicio" en la posición 0
 * @param largo        cantidad total de etiquetas del eje
 */
export function serieDeReplanteo({ version, periodos, curvaAvance, largo, itemsPorPlanificacion, costoPorItem, total }) {
  const ids = new Set(version.filas.map((f) => f.id));
  const corte = indiceDeCorte(periodos, version.fecha_corte);

  let ultimo = -1;
  periodos.forEach((p, i) => { if (p.planifIds.some((id) => ids.has(id))) ultimo = i; });

  const datos = new Array(largo).fill(null);
  let acumulado = corte >= 0 ? Number(curvaAvance[corte + 1] || 0) : 0;
  datos[corte + 1] = r2(acumulado);

  for (let i = corte + 1; i <= ultimo; i++) {
    for (const id of periodos[i].planifIds) {
      if (!ids.has(id)) continue;
      for (const item of itemsPorPlanificacion[id] || []) {
        const costo = costoPorItem[item.pliego_item_id] || 0;
        acumulado += total > 0 ? (Number(item.porcentaje_planificado) / 100) * (costo / total) * 100 : 0;
      }
    }
    datos[i + 1] = r2(acumulado);
  }

  return { datos, corte, ultimo };
}

/**
 * El plan que rige en cada período: el original hasta el primer corte, y
 * desde cada corte, la versión que lo reemplazó.
 *
 * Es contra esto que se mide el desvío. Un replanteo aprobado es el nuevo plan
 * de trabajos: desde su corte la obra se compara con él, no con lo que se había
 * prometido antes.
 */
export function planVigente({ planOriginal, series, cantidadPeriodos }) {
  const vigente = [...planOriginal];
  for (let i = 0; i < cantidadPeriodos; i++) {
    let serie = null;
    for (const s of series) if (s.corte < i) serie = s;
    if (!serie) continue;

    let valor = serie.datos[i + 1];
    if (valor == null) {
      // Pasado el último mes de la versión, el plan ya está cumplido: se
      // sostiene su valor final.
      for (let j = i; j >= 0 && valor == null; j--) valor = serie.datos[j];
    }
    vigente[i + 1] = valor ?? vigente[i + 1];
  }
  return vigente;
}
