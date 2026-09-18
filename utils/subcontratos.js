// utils/subcontratos.js
//
// Cálculos del circuito del subcontratista. Funciones puras: reciben filas
// planas (como vienen de la base) y devuelven números, sin tocar nada.
//
// Reglas que se respetan acá, y que la planilla de Excel no respetaba:
//
//  · El ANTERIOR de un certificado es la suma de los certificados previos. No
//    se copia a mano: en la planilla hubo hasta 5 ítems por hoja donde no
//    coincidía con el acumulado del certificado anterior.
//
//  · Lo certificado se valoriza con el precio CON EL QUE SE CERTIFICÓ. Si el
//    precio de un ítem cambia, lo ya pagado no se re-valúa. En la planilla el
//    acumulado se recalculaba con el precio nuevo y el anterior dejaba de cerrar.
//
//  · El porcentaje de avance pondera TODOS los ítems, incluidos los adicionales.
//    En la planilla la fórmula cubría un rango fijo de filas que nunca se
//    extendió: en el certificado 17 informaba 14,31% cuando el real era 23,86%.

export const r2 = (n) => Number(Number(n || 0).toFixed(2));
export const r4 = (n) => Number(Number(n || 0).toFixed(4));
const num = (n) => Number(n || 0);

export const norm = (x) => {
  if (!x) return "";
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  return String(x).slice(0, 10);
};

export const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

/** Suma días a una fecha AAAA-MM-DD, sin pasar por la zona horaria. */
export function sumarDias(fecha, dias) {
  const [a, m, d] = norm(fecha).split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + dias));
  return f.toISOString().slice(0, 10);
}

export const diasDe = (periodicidad) => (periodicidad === "semanal" ? 7 : 14);

/**
 * Períodos consecutivos de 7 o 14 días desde `inicio`. Una quincena de obra
 * va de lunes a domingo de la semana siguiente; si el certificado cierra el
 * viernes, igual cae dentro.
 */
export function generarPeriodos({ inicio, periodicidad, cantidad }) {
  const largo = diasDe(periodicidad);
  const periodos = [];
  let desde = norm(inicio);
  for (let i = 1; i <= cantidad; i++) {
    const hasta = sumarDias(desde, largo - 1);
    periodos.push({ numero: i, desde, hasta });
    desde = sumarDias(hasta, 1);
  }
  return periodos;
}

/** El próximo período a certificar: arranca el día después del último. */
export function sugerirPeriodo({ ultimoHasta, inicio, periodicidad }) {
  const desde = ultimoHasta ? sumarDias(ultimoHasta, 1) : norm(inicio) || null;
  if (!desde) return { desde: null, hasta: null };
  return { desde, hasta: sumarDias(desde, diasDe(periodicidad) - 1) };
}

export const totalItem = (it) => r2(num(it.cantidad) * num(it.precio_unitario));
export const totalContrato = (items) => r2(items.reduce((s, it) => s + totalItem(it), 0));

/** Cantidades e importes certificados por ítem, sumando una lista de certificados. */
function sumarCertificados(certs, certItemsPorCert) {
  const cantidad = {};
  const importe = {};
  for (const c of certs) {
    for (const ci of certItemsPorCert[c.id] || []) {
      const q = num(ci.cantidad);
      cantidad[ci.subcontrato_item_id] = (cantidad[ci.subcontrato_item_id] || 0) + q;
      importe[ci.subcontrato_item_id] = (importe[ci.subcontrato_item_id] || 0) + q * num(ci.precio_unitario);
    }
  }
  return { cantidad, importe };
}

/**
 * Avance físico ponderado de la obra del sub: cada ítem aporta su incidencia
 * por la fracción ejecutada, topada en 1. Lo que se ejecuta de más es
 * EXCEDENTE y se informa aparte: no infla el avance.
 */
export function avanceFisico(items, cantidadPorItem) {
  const total = totalContrato(items);
  if (!total) return 0;
  let avance = 0;
  for (const it of items) {
    const contratado = num(it.cantidad);
    if (!contratado) continue;
    const fraccion = Math.min(1, num(cantidadPorItem[it.id]) / contratado);
    avance += (totalItem(it) / total) * fraccion;
  }
  return r2(avance * 100);
}

/**
 * La planilla de UN certificado, con el mismo desglose que la de Excel:
 * contratado, precio, total, incidencia, y cantidades e importes anterior,
 * actual, acumulado y pendiente. Además el excedente de cada ítem.
 *
 * @param certificados  todos los certificados NO anulados, ordenados por número
 */
export function planillaDe({ items, certificados, certItemsPorCert, descuentos, certificado }) {
  const previos = certificados.filter((c) => c.numero < certificado.numero);
  const anterior = sumarCertificados(previos, certItemsPorCert);
  const actual = sumarCertificados([certificado], certItemsPorCert);
  const total = totalContrato(items);

  const filas = items.map((it) => {
    const contratado = num(it.cantidad);
    const totalIt = totalItem(it);
    const qAnt = num(anterior.cantidad[it.id]);
    const qAct = num(actual.cantidad[it.id]);
    const qAcum = qAnt + qAct;
    const qPend = contratado - qAcum;
    const $ant = num(anterior.importe[it.id]);
    const $act = num(actual.importe[it.id]);
    const precioActual = actual.cantidad[it.id]
      ? (certItemsPorCert[certificado.id] || []).find((ci) => ci.subcontrato_item_id === it.id)?.precio_unitario
      : it.precio_unitario;
    return {
      id: it.id,
      numero: it.numero,
      descripcion: it.descripcion,
      unidad: it.unidad,
      origen: it.origen,
      pliego_item_id: it.pliego_item_id,
      contratado: r4(contratado),
      precio_unitario: r2(precioActual),
      total: totalIt,
      incidencia: total ? r4((totalIt / total) * 100) : 0,
      cantidad: { anterior: r4(qAnt), actual: r4(qAct), acumulado: r4(qAcum), pendiente: r4(Math.max(0, qPend)) },
      excedente: r4(Math.max(0, -qPend)),
      importe: {
        anterior: r2($ant),
        actual: r2($act),
        acumulado: r2($ant + $act),
        pendiente: r2(Math.max(0, qPend) * num(it.precio_unitario)),
      },
      porcentaje: {
        anterior: totalIt ? r2(($ant / totalIt) * 100) : 0,
        actual: totalIt ? r2(($act / totalIt) * 100) : 0,
        acumulado: totalIt ? r2((($ant + $act) / totalIt) * 100) : 0,
      },
    };
  });

  const suma = (fn) => r2(filas.reduce((s, f) => s + fn(f), 0));
  const totalDescuentos = r2(descuentos.reduce((s, d) => s + num(d.importe), 0));
  const importeActual = suma((f) => f.importe.actual);

  const acumuladoCantidades = {};
  const anteriorCantidades = {};
  for (const f of filas) {
    acumuladoCantidades[f.id] = f.cantidad.acumulado;
    anteriorCantidades[f.id] = f.cantidad.anterior;
  }

  return {
    filas,
    totales: {
      contrato: total,
      importe: {
        anterior: suma((f) => f.importe.anterior),
        actual: importeActual,
        acumulado: suma((f) => f.importe.acumulado),
        pendiente: suma((f) => f.importe.pendiente),
      },
      avance: {
        anterior: avanceFisico(items, anteriorCantidades),
        actual: r2(avanceFisico(items, acumuladoCantidades) - avanceFisico(items, anteriorCantidades)),
        acumulado: avanceFisico(items, acumuladoCantidades),
      },
      excedentes: r2(filas.reduce((s, f) => s + f.excedente * f.precio_unitario, 0)),
      descuentos: totalDescuentos,
      a_pagar: r2(importeActual - totalDescuentos),
    },
  };
}

/**
 * Estadísticas del subcontrato: acordado, avanzado, pendiente, excedentes y
 * la comparación contra su plan de trabajo.
 */
export function resumenSubcontrato({ items, certificados, certItemsPorCert, descuentos, planPeriodos, planItemsPorPeriodo, hoy }) {
  const hoyISO = norm(hoy);
  const { cantidad, importe } = sumarCertificados(certificados, certItemsPorCert);
  const total = totalContrato(items);

  // Plan acumulado por ítem hasta hoy (períodos ya cerrados o en curso).
  const planHoy = {};
  for (const p of planPeriodos) {
    if (norm(p.desde) > hoyISO) continue;
    for (const pi of planItemsPorPeriodo[p.id] || []) {
      planHoy[pi.subcontrato_item_id] = (planHoy[pi.subcontrato_item_id] || 0) + num(pi.cantidad);
    }
  }

  const porItem = items.map((it) => {
    const contratado = num(it.cantidad);
    const acum = num(cantidad[it.id]);
    const exced = Math.max(0, acum - contratado);
    return {
      id: it.id,
      numero: it.numero,
      descripcion: it.descripcion,
      unidad: it.unidad,
      origen: it.origen,
      contratado: r4(contratado),
      precio_unitario: r2(it.precio_unitario),
      total: totalItem(it),
      certificado: r4(acum),
      certificado_importe: r2(importe[it.id]),
      pendiente: r4(Math.max(0, contratado - acum)),
      pendiente_importe: r2(Math.max(0, contratado - acum) * num(it.precio_unitario)),
      excedente: r4(exced),
      excedente_importe: r2(exced * num(it.precio_unitario)),
      avance: contratado ? r2(Math.min(1, acum / contratado) * 100) : 0,
      planificado_hoy: r4(planHoy[it.id] || 0),
      desvio: r4(acum - (planHoy[it.id] || 0)),
    };
  });

  // Curva: plan contra certificado, al cierre de cada período del plan.
  const curva = planPeriodos.map((p) => {
    const planAcum = {};
    for (const q of planPeriodos) {
      if (q.numero > p.numero) continue;
      for (const pi of planItemsPorPeriodo[q.id] || []) {
        planAcum[pi.subcontrato_item_id] = (planAcum[pi.subcontrato_item_id] || 0) + num(pi.cantidad);
      }
    }
    const certHasta = certificados.filter((c) => norm(c.hasta) <= norm(p.hasta));
    const certAcum = sumarCertificados(certHasta, certItemsPorCert).cantidad;
    return {
      periodo: p.numero,
      desde: norm(p.desde),
      hasta: norm(p.hasta),
      planificado: avanceFisico(items, planAcum),
      // Un período que todavía no empezó no tiene certificado: queda vacío.
      certificado: norm(p.desde) <= hoyISO ? avanceFisico(items, certAcum) : null,
    };
  });

  const certificadoImporte = r2(Object.values(importe).reduce((s, v) => s + v, 0));
  const totalDescuentos = r2(descuentos.reduce((s, d) => s + num(d.importe), 0));
  const avance = avanceFisico(items, cantidad);
  const planificadoHoy = avanceFisico(items, planHoy);

  return {
    totales: {
      contrato: total,
      contrato_original: totalContrato(items.filter((i) => i.origen !== "adicional")),
      adicionales: totalContrato(items.filter((i) => i.origen === "adicional")),
      certificado: certificadoImporte,
      pendiente: r2(porItem.reduce((s, i) => s + i.pendiente_importe, 0)),
      excedentes: r2(porItem.reduce((s, i) => s + i.excedente_importe, 0)),
      descuentos: totalDescuentos,
      neto_pagado: r2(certificadoImporte - totalDescuentos),
      avance,
      planificado_hoy: planPeriodos.length ? planificadoHoy : null,
      desvio: planPeriodos.length ? r2(avance - planificadoHoy) : null,
      certificados: certificados.length,
      ultimo_certificado: certificados.length ? norm(certificados[certificados.length - 1].hasta) : null,
      items_con_excedente: porItem.filter((i) => i.excedente > 0).length,
    },
    items: porItem,
    curva,
  };
}
