// utils/subcontratos.js
//
// Cálculos del circuito del subcontratista. Funciones puras: reciben filas
// planas (como vienen de la base) y devuelven números, sin tocar nada.
//
// El subcontratista NO tiene plan de trabajo: su avance se mide directamente
// contra la orden de compra.
//
// Reglas que se respetan acá, y que la planilla de Excel no respetaba:
//
//  · El ANTERIOR de un certificado es la suma de los certificados previos. No
//    se copia a mano: en la planilla hubo hasta 5 ítems por hoja donde no
//    coincidía con el acumulado del certificado anterior.
//
//  · Lo certificado se valoriza con el precio CON EL QUE SE CERTIFICÓ. Si el
//    precio de un ítem cambia, lo ya pagado no se re-valúa.
//
//  · El avance pondera TODOS los ítems. En la planilla la fórmula cubría un
//    rango fijo de filas que nunca se extendió: en el certificado 17
//    informaba 14,31% cuando el real era 23,86%.
//
// ADICIONALES. Todo trabajo extra es un adicional, y se dice de qué clase:
//   · "cargado de más": más cantidad de un rubro que ya estaba en la OC. Puede
//     estar cargado como ítem propio (tipo_adicional = de_mas) o surgir al
//     certificar por encima de lo contratado: en ese caso la planilla lo
//     DESDOBLA — lo contratado queda en el renglón del rubro y el excedente
//     aparece como su propio renglón de adicional.
//   · "ítem nuevo": un rubro que no existía (tipo_adicional = nuevo).

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
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

export const diasDe = (periodicidad) => (periodicidad === "semanal" ? 7 : 14);

/** El próximo período a certificar: arranca el día después del último. */
export function sugerirPeriodo({ ultimoHasta, inicio, periodicidad }) {
  const desde = ultimoHasta ? sumarDias(ultimoHasta, 1) : norm(inicio) || null;
  if (!desde) return { desde: null, hasta: null };
  return { desde, hasta: sumarDias(desde, diasDe(periodicidad) - 1) };
}

export const totalItem = (it) => r2(num(it.cantidad) * num(it.precio_unitario));

/* ── Actualizaciones de precio ──────────────────────────────────────────────
 * El precio de la OC es el ORIGINAL del contrato. Cada actualización dice
 * desde qué fecha rigen los precios nuevos de algunos ítems, y un certificado
 * va con los de la última actualización vigente al FIN de su período.
 */

/**
 * Ordena las actualizaciones por fecha y les arma el mapa de precios por ítem.
 * @param actualizaciones  filas de subcontrato_actualizaciones
 * @param renglones        filas de subcontrato_actualizacion_items
 */
export function armarActualizaciones(actualizaciones, renglones) {
  const precios = {};
  for (const r of renglones) (precios[r.actualizacion_id] ||= {})[r.subcontrato_item_id] = num(r.precio_unitario);
  return actualizaciones
    .map((a) => ({
      id: a.id, numero: a.numero, fecha_vigencia: norm(a.fecha_vigencia), motivo: a.motivo || null,
      precios: precios[a.id] || {},
    }))
    .sort((a, b) => (a.fecha_vigencia < b.fecha_vigencia ? -1 : a.fecha_vigencia > b.fecha_vigencia ? 1 : a.numero - b.numero));
}

/** La actualización que rige a una fecha (la última con vigencia hasta ese día). Sin fecha, la última. */
export function actualizacionEn(actualizaciones, fecha) {
  let rige = null;
  for (const a of actualizaciones) {
    if (fecha && a.fecha_vigencia > norm(fecha)) break;
    rige = a;
  }
  return rige;
}

/**
 * El precio de un ítem a una fecha: el de la última actualización vigente ese
 * día que lo incluye; si ninguna lo tocó, el de la OC. Sin fecha, el último
 * acordado (aunque todavía no rija).
 */
export function precioEn(item, fecha, actualizaciones = []) {
  let precio = num(item.precio_original ?? item.precio_unitario);
  for (const a of actualizaciones) {
    if (fecha && a.fecha_vigencia > norm(fecha)) break;
    if (a.precios[item.id] !== undefined) precio = a.precios[item.id];
  }
  return r2(precio);
}

/** Los precios que tuvo un ítem: el de la OC y uno por cada actualización que lo tocó. */
export function historiaDePrecios(item, actualizaciones = []) {
  const historia = [{ desde: null, numero: 0, precio: r2(item.precio_original ?? item.precio_unitario) }];
  for (const a of actualizaciones) {
    if (a.precios[item.id] !== undefined) historia.push({ desde: a.fecha_vigencia, numero: a.numero, precio: r2(a.precios[item.id]) });
  }
  return historia;
}

/**
 * Los ítems con el precio que rige a una fecha. Conserva el de la OC en
 * `precio_original`, así los cálculos de siempre (totales, pendiente, avance)
 * trabajan sin saber que hubo actualizaciones.
 */
export function conPreciosA(items, fecha, actualizaciones = []) {
  return items.map((it) => ({
    ...it,
    precio_original: r2(it.precio_original ?? it.precio_unitario),
    precio_unitario: precioEn(it, fecha, actualizaciones),
  }));
}

/** contrato · de_mas · nuevo */
export const claseDe = (it) =>
  it.origen !== "adicional" ? "contrato" : it.tipo_adicional === "de_mas" ? "de_mas" : "nuevo";

export const ETIQUETAS = {
  contrato: "Contrato",
  // "Mayor cantidad" y no "cargado de más": eso sonaba a un error del técnico
  // que cargó, y es trabajo que se hizo por encima de lo contratado.
  de_mas: "Adicional · mayor cantidad",
  nuevo: "Adicional · ítem nuevo",
};

/** Cantidades e importes certificados por ítem, sumando una lista de certificados. */
export function sumarCertificados(certs, certItemsPorCert) {
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
 * Desdobla un ítem en lo contratado y la mayor cantidad (lo que lo pasa).
 *
 * `ant` y `act` son las cantidades e importes TOTALES (anterior y actual). Lo
 * que supera lo contratado se corta y pasa a ser el renglón de adicional.
 * Los importes se reparten con el precio de cada tramo (anterior o actual).
 */
export function desglosar({ contratado, precioVigente, ant, act }) {
  const c = num(contratado);
  const qAnt = num(ant.cantidad), qAct = num(act.cantidad);
  const qAcum = qAnt + qAct;
  const pAnt = qAnt ? num(ant.importe) / qAnt : num(precioVigente);
  const pAct = qAct ? num(act.importe) / qAct : num(precioVigente);

  const capAnt = Math.min(qAnt, c), capAcum = Math.min(qAcum, c);
  const capAct = capAcum - capAnt;
  const excAnt = qAnt - capAnt, excAcum = qAcum - capAcum;
  const excAct = excAcum - excAnt;

  const principal = {
    cantidad: { anterior: r4(capAnt), actual: r4(capAct), acumulado: r4(capAcum), pendiente: r4(Math.max(0, c - qAcum)) },
    importe: {
      anterior: r2(capAnt * pAnt),
      actual: r2(capAct * pAct),
      acumulado: r2(capAnt * pAnt + capAct * pAct),
      pendiente: r2(Math.max(0, c - qAcum) * num(precioVigente)),
    },
  };
  const deMas = excAcum > 0.00005 ? {
    cantidad: { anterior: r4(excAnt), actual: r4(excAct), acumulado: r4(excAcum), pendiente: 0 },
    importe: {
      anterior: r2(excAnt * pAnt),
      actual: r2(excAct * pAct),
      acumulado: r2(excAnt * pAnt + excAct * pAct),
      pendiente: 0,
    },
    // Lo acordado de este adicional es lo que se hizo: se valoriza al precio vigente.
    total: r2(excAcum * num(precioVigente)),
  } : null;
  return { principal, deMas };
}

/**
 * Totales de la OC a partir de cantidades acumuladas. Sirve para el total de
 * un certificado y para las estadísticas.
 *
 *   original  lo que decía la OC
 *   de_mas    adicionales de más (ítems cargados así + lo certificado por encima)
 *   nuevo     adicionales de rubros que no existían
 *   contrato  la suma de los tres: lo acordado a la fecha
 *   avance    (contrato − pendiente) / contrato
 */
export function totalesOC(items, cantidadAcum) {
  let original = 0, deMas = 0, nuevo = 0, pendiente = 0;
  for (const it of items) {
    const total = totalItem(it);
    const clase = claseDe(it);
    if (clase === "contrato") original += total;
    else if (clase === "de_mas") deMas += total;
    else nuevo += total;
    const acum = num(cantidadAcum[it.id]);
    const exced = Math.max(0, acum - num(it.cantidad));
    deMas += exced * num(it.precio_unitario);
    pendiente += Math.max(0, num(it.cantidad) - acum) * num(it.precio_unitario);
  }
  const contrato = original + deMas + nuevo;
  return {
    original: r2(original),
    de_mas: r2(deMas),
    nuevo: r2(nuevo),
    contrato: r2(contrato),
    pendiente: r2(pendiente),
    avance: contrato ? r2(((contrato - pendiente) / contrato) * 100) : 0,
  };
}

/**
 * La planilla de UN certificado, con el mismo desglose que la de Excel.
 *
 * Devuelve las filas CRUDAS (cantidades e importes totales, sin desdoblar)
 * para que la pantalla recalcule mientras se escribe, y los totales ya
 * calculados.
 *
 * @param items           con el precio que rige al fin del período (conPreciosA)
 * @param certificados    todos los certificados NO anulados, ordenados por número
 * @param actualizaciones para mandar la historia de precios de cada ítem: si en
 *                        pantalla se cambia la fecha "hasta", el precio cambia
 */
export function planillaDe({ items, certificados, certItemsPorCert, descuentos, certificado, actualizaciones = [] }) {
  const previos = certificados.filter((c) => c.numero < certificado.numero);
  const anterior = sumarCertificados(previos, certItemsPorCert);
  const actual = sumarCertificados(certificado.id ? [certificado] : [], certItemsPorCert);

  const filas = items.map((it) => {
    const lineaCert = (certItemsPorCert[certificado.id] || []).find((ci) => ci.subcontrato_item_id === it.id);
    return {
      id: it.id,
      numero: it.numero,
      descripcion: it.descripcion,
      unidad: it.unidad,
      clase: claseDe(it),
      origen: it.origen,
      tipo_adicional: it.tipo_adicional || null,
      item_origen_id: it.item_origen_id || null,
      pliego_item_id: it.pliego_item_id || null,
      creado_en_certificado_id: it.creado_en_certificado_id || null,
      contratado: r4(it.cantidad),
      precio_vigente: r2(it.precio_unitario),
      precio_original: r2(it.precio_original ?? it.precio_unitario),
      precios: historiaDePrecios(it, actualizaciones),
      // El precio de ESTE certificado: el congelado si ya tiene línea.
      precio: r2(lineaCert ? lineaCert.precio_unitario : it.precio_unitario),
      congelado: !!lineaCert,
      total: totalItem(it),
      anterior: { cantidad: r4(anterior.cantidad[it.id]), importe: r2(anterior.importe[it.id]) },
      actual: { cantidad: r4(actual.cantidad[it.id]), importe: r2(actual.importe[it.id]) },
    };
  });

  const acumAnt = {}, acumTot = {};
  for (const f of filas) {
    acumAnt[f.id] = f.anterior.cantidad;
    acumTot[f.id] = f.anterior.cantidad + f.actual.cantidad;
  }
  const antes = totalesOC(items, acumAnt);
  const ahora = totalesOC(items, acumTot);
  const importeActual = r2(filas.reduce((s, f) => s + f.actual.importe, 0));
  const importeAnterior = r2(filas.reduce((s, f) => s + f.anterior.importe, 0));
  const totalDescuentos = r2(descuentos.reduce((s, d) => s + num(d.importe), 0));

  return {
    filas,
    totales: {
      ...ahora,
      importe: {
        anterior: importeAnterior,
        actual: importeActual,
        acumulado: r2(importeAnterior + importeActual),
        pendiente: ahora.pendiente,
      },
      avance: { anterior: antes.avance, actual: r2(ahora.avance - antes.avance), acumulado: ahora.avance },
      descuentos: totalDescuentos,
      a_pagar: r2(importeActual - totalDescuentos),
    },
  };
}

/**
 * Estadísticas del subcontrato: acordado, avanzado, pendiente, y los
 * adicionales separados en "mayor cantidad" e "ítem nuevo".
 */
export function resumenSubcontrato({ items, certificados, certItemsPorCert, descuentos }) {
  const { cantidad, importe } = sumarCertificados(certificados, certItemsPorCert);
  const tot = totalesOC(items, cantidad);
  const porId = new Map(items.map((i) => [i.id, i]));

  const filas = [];
  for (const it of items) {
    const contratado = num(it.cantidad);
    const acum = num(cantidad[it.id]);
    const precio = num(it.precio_unitario);
    const clase = claseDe(it);
    const exced = Math.max(0, acum - contratado);
    const origen = it.item_origen_id ? porId.get(it.item_origen_id) : null;
    filas.push({
      id: it.id,
      numero: it.numero,
      descripcion: it.descripcion,
      unidad: it.unidad,
      clase,
      etiqueta: ETIQUETAS[clase],
      rubro_origen: origen ? origen.descripcion : null,
      contratado: r4(contratado),
      precio_unitario: r2(precio),
      precio_original: r2(it.precio_original ?? precio),
      total: totalItem(it),
      certificado: r4(Math.min(acum, contratado)),
      certificado_importe: r2(acum ? (num(importe[it.id]) * Math.min(acum, contratado)) / acum : 0),
      pendiente: r4(Math.max(0, contratado - acum)),
      pendiente_importe: r2(Math.max(0, contratado - acum) * precio),
      avance: contratado ? r2(Math.min(1, acum / contratado) * 100) : 0,
    });
    // Lo certificado por encima de lo contratado: su propio renglón.
    if (exced > 0.00005) {
      filas.push({
        id: `de-mas-${it.id}`,
        virtual: true,
        numero: it.numero,
        descripcion: it.descripcion,
        unidad: it.unidad,
        clase: "de_mas",
        etiqueta: ETIQUETAS.de_mas,
        rubro_origen: it.descripcion,
        contratado: r4(exced),
        precio_unitario: r2(precio),
        total: r2(exced * precio),
        certificado: r4(exced),
        certificado_importe: r2(acum ? (num(importe[it.id]) * exced) / acum : 0),
        pendiente: 0,
        pendiente_importe: 0,
        avance: 100,
      });
    }
  }

  // Curva: avance acumulado del contrato después de cada certificado.
  const curva = [];
  let pagado = 0;
  for (let k = 0; k < certificados.length; k++) {
    const hasta = sumarCertificados(certificados.slice(0, k + 1), certItemsPorCert);
    const delCert = sumarCertificados([certificados[k]], certItemsPorCert);
    const importeCert = Object.values(delCert.importe).reduce((s, v) => s + v, 0);
    pagado += importeCert;
    curva.push({
      numero: certificados[k].numero,
      desde: norm(certificados[k].desde),
      hasta: norm(certificados[k].hasta),
      avance: totalesOC(items, hasta.cantidad).avance,
      importe: r2(importeCert),
      acumulado: r2(pagado),
    });
  }

  const certificadoImporte = r2(Object.values(importe).reduce((s, v) => s + v, 0));
  const totalDescuentos = r2(descuentos.reduce((s, d) => s + num(d.importe), 0));

  // Lo que decía la OC a los precios originales: con actualizaciones, `original`
  // ya viene a los precios nuevos y sin esto no se ve cuánto subió.
  const originalOC = r2(items
    .filter((it) => claseDe(it) === "contrato")
    .reduce((s, it) => s + num(it.cantidad) * num(it.precio_original ?? it.precio_unitario), 0));

  return {
    totales: {
      ...tot,
      original_oc: originalOC,
      certificado: certificadoImporte,
      descuentos: totalDescuentos,
      neto_pagado: r2(certificadoImporte - totalDescuentos),
      certificados: certificados.length,
      ultimo_certificado: certificados.length ? norm(certificados[certificados.length - 1].hasta) : null,
      renglones_de_mas: filas.filter((f) => f.clase === "de_mas").length,
      renglones_nuevos: filas.filter((f) => f.clase === "nuevo").length,
    },
    items: filas,
    curva,
  };
}
