// Lógica de excedentes de avance de obra, compartida por las rutas.
//
// Vive acá y no en una ruta porque hay DOS caminos que crean avances
// (routes/obras.js y routes/avanceObra.js) y ya pasó en este proyecto que la
// misma regla escrita dos veces terminara diciendo cosas distintas.
//
// ── La regla ─────────────────────────────────────────────────────────────
//
//   CERTIFICACIÓN  topada al 100% del pliego. Es lo que se factura y no se
//                  puede facturar más de lo contratado.
//
//   AVANCE DE OBRA sin tope. Es lo que se ejecutó de verdad: el pliego decía
//                  50 m3 de excavación y se excavaron 200. Eso pasa.
//
// Lo ejecutado de más se llama EXCEDENTE. No se le pone precio acá: se negocia
// después con el comitente y recién ahí se convierte en un ítem del pliego.

import { Op } from "sequelize";
import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";

export const TOLERANCIA = 0.01;   // 100.004% es 100%, no un excedente

export const aNumero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const r5 = (n) => Math.round((Number(n) || 0) * 100000) / 100000;

/**
 * Normaliza un ítem del avance.
 *
 * Se puede mandar la cantidad ejecutada o el porcentaje; lo que falte se
 * deriva del pliego. La cantidad manda cuando viene, porque es lo que se mide
 * en obra: nadie sale a medir "porcentaje de excavación".
 */
export function normalizarItem(entrada, pliego) {
  const cantidadPliego = aNumero(pliego?.cantidad);
  const vieneCantidad =
    entrada.cantidad_ejecutada !== undefined &&
    entrada.cantidad_ejecutada !== null &&
    entrada.cantidad_ejecutada !== "";

  let porcentaje;
  let cantidadFinal;

  if (vieneCantidad) {
    cantidadFinal = Math.max(0, aNumero(entrada.cantidad_ejecutada));
    // Un ítem del pliego con cantidad 0 no permite derivar el porcentaje: se
    // usa el que hayan mandado en vez de dividir por cero.
    porcentaje =
      cantidadPliego > 0
        ? (cantidadFinal / cantidadPliego) * 100
        : aNumero(entrada.avance_porcentaje);
  } else {
    porcentaje = Math.max(0, aNumero(entrada.avance_porcentaje));
    cantidadFinal = cantidadPliego > 0 ? (cantidadPliego * porcentaje) / 100 : null;
  }

  return {
    pliego_item_id: Number(pliego.id),
    avance_porcentaje: r2(porcentaje),
    cantidad_ejecutada: cantidadFinal === null ? null : r5(cantidadFinal),
  };
}

/**
 * Lo acumulado por ítem en los avances ya guardados de una obra.
 * Devuelve un Map pliego_item_id → { porcentaje, cantidad }.
 *
 * `excluirAvanceId` sirve al editar: el avance que se está editando no cuenta
 * como acumulado previo, o se sumaría dos veces.
 */
export async function acumuladoPorItem(obraId, transaction = null, excluirAvanceId = null) {
  const where = { obra_id: obraId };
  if (excluirAvanceId) where.id = { [Op.ne]: Number(excluirAvanceId) };

  const avances = await AvanceObra.findAll({ where, attributes: ["id"], transaction });
  const ids = avances.map((a) => a.id);
  if (ids.length === 0) return new Map();

  const items = await AvanceObraItem.findAll({
    where: { avance_obra_id: { [Op.in]: ids } },
    transaction,
  });

  const acumulado = new Map();
  for (const i of items) {
    const previo = acumulado.get(i.pliego_item_id) || { porcentaje: 0, cantidad: 0 };
    previo.porcentaje += aNumero(i.avance_porcentaje);
    previo.cantidad += aNumero(i.cantidad_ejecutada);
    acumulado.set(i.pliego_item_id, previo);
  }
  return acumulado;
}

/**
 * Los avisos de excedente de un conjunto de ítems que se está por guardar.
 *
 * Son AVISOS, no errores: el avance se guarda igual. Quien carga tiene que
 * enterarse de que se pasó del pliego; impedírselo no cambia lo que ya se hizo
 * en la obra, solo hace que el dato no quede en ningún lado.
 */
export function avisosDeExcedente(itemsNormalizados, pliegoPorId, acumulado) {
  const avisos = [];
  for (const i of itemsNormalizados) {
    const pliego = pliegoPorId.get(i.pliego_item_id);
    if (!pliego) continue;

    const previo = acumulado.get(i.pliego_item_id) || { porcentaje: 0, cantidad: 0 };
    const totalPct = previo.porcentaje + aNumero(i.avance_porcentaje);
    if (totalPct <= 100 + TOLERANCIA) continue;

    const cantidadPliego = aNumero(pliego.cantidad);
    const totalCantidad = previo.cantidad + aNumero(i.cantidad_ejecutada);
    const excedente = cantidadPliego > 0 ? totalCantidad - cantidadPliego : null;
    const unidad = pliego.unidadMedida || "";

    avisos.push({
      pliego_item_id: i.pliego_item_id,
      numero_item: pliego.numeroItem,
      descripcion: pliego.descripcionItem,
      unidad,
      cantidad_pliego: r5(cantidadPliego),
      cantidad_ejecutada: r5(totalCantidad),
      excedente: excedente === null ? null : r5(excedente),
      acumulado_porcentaje: r2(totalPct),
      mensaje:
        excedente !== null && cantidadPliego > 0
          ? `El ítem ${pliego.numeroItem} (${pliego.descripcionItem}) queda en ${r2(totalPct)}%: ` +
            `${r5(totalCantidad)} ${unidad} ejecutados contra ${r5(cantidadPliego)} ${unidad} del pliego. ` +
            `Excedente: ${r5(excedente)} ${unidad}.`
          : `El ítem ${pliego.numeroItem} (${pliego.descripcionItem}) queda en ${r2(totalPct)}%, por encima del pliego.`,
    });
  }
  return avisos;
}

/**
 * El excedente de cada ítem del pliego, ya descontando lo que se convirtió en
 * ítems nuevos. En cantidad y sin precio.
 */
export function calcularExcedentes(pliego, acumulado) {
  // Lo que ya se reconoció en ítems nuevos, sumado por ítem de origen. Un
  // excedente puede reconocerse en partes: 100 de 150 m3 en el replanteo de
  // junio y el resto en un adicional al final.
  const convertido = new Map();
  for (const p of pliego) {
    if (p.origen !== "excedente" || !p.item_origen_id) continue;
    convertido.set(p.item_origen_id, aNumero(convertido.get(p.item_origen_id)) + aNumero(p.cantidad));
  }

  const excedentes = [];
  let conAvance = 0;

  for (const p of pliego) {
    // Un ítem que YA es un excedente convertido no genera excedente propio.
    if (p.origen === "excedente") continue;
    const acu = acumulado.get(p.id);
    if (!acu) continue;
    conAvance++;
    if (acu.porcentaje <= 100 + TOLERANCIA) continue;

    const cantidadPliego = aNumero(p.cantidad);
    const total = r5(Math.max(0, acu.cantidad - cantidadPliego));
    const yaConvertido = r5(convertido.get(p.id) || 0);

    excedentes.push({
      pliego_item_id: p.id,
      numero_item: p.numeroItem,
      descripcion: p.descripcionItem,
      unidad: p.unidadMedida || "",
      origen: p.origen,
      cantidad_pliego: r5(cantidadPliego),
      cantidad_ejecutada: r5(acu.cantidad),
      excedente: total,
      ya_convertido: yaConvertido,
      pendiente: r5(Math.max(0, total - yaConvertido)),
      acumulado_porcentaje: r2(acu.porcentaje),
      excedente_porcentaje: r2(acu.porcentaje - 100),
    });
  }

  return { excedentes, conAvance };
}
