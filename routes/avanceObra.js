import express from "express";
import { Op } from "sequelize";
import { sequelize } from "../database.js";

import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";
import PliegoItem from "../models/PliegoItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

// ── Avance de obra vs. certificación ───────────────────────────────────────
//
// No son lo mismo y por eso se validan distinto.
//
//   CERTIFICACIÓN  es lo que se factura. Está topada al 100% de cada ítem del
//                  pliego: no se puede certificar más de lo contratado. Eso ya
//                  lo valida routes/certificaciones.js.
//
//   AVANCE DE OBRA es lo que se ejecutó de verdad. NO tiene tope. El pliego
//                  decía 50 m3 de excavación y se excavaron 200: eso pasa, y
//                  el sistema tiene que poder registrarlo.
//
// Hasta ahora el avance hacía Math.min(100, porcentaje) y truncaba en silencio.
// El excedente —que es justamente lo que después se negocia en el replanteo—
// desaparecía sin que nadie se enterara.
//
// El excedente se registra en CANTIDAD y SIN PRECIO. Cuánto vale lo ejecutado
// de más no lo decide quien carga el avance: se define después, en la
// redeterminación o el replanteo, y recién ahí entra la plata.

const aNumero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r5 = (n) => Math.round((Number(n) || 0) * 100000) / 100000;

// Un centésimo de tolerancia: 100.004% es 100%, no un excedente.
const TOLERANCIA = 0.01;

/**
 * Normaliza un ítem del avance.
 *
 * Se puede mandar la cantidad ejecutada o el porcentaje; lo que falte se
 * deriva. La cantidad manda cuando viene, porque es lo que se mide en obra.
 */
function normalizarItem(entrada, pliego) {
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
 * Lo acumulado por ítem en los avances YA guardados de una obra.
 * Devuelve un Map pliego_item_id → { porcentaje, cantidad }.
 */
async function acumuladoPorItem(obraId, transaction = null, excluirAvanceId = null) {
  const where = { obra_id: obraId };
  if (excluirAvanceId) where.id = { [Op.ne]: excluirAvanceId };

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
 * en la obra, solo hace que el dato no quede registrado.
 */
function avisosDeExcedente(itemsNormalizados, pliegoPorId, acumulado) {
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
 * PREVISUALIZAR — qué avisos saldrían, sin guardar nada.
 * POST /avances-obra/:obraId/previsualizar
 *
 * Para que la pantalla avise MIENTRAS se carga, no después de guardar.
 */
router.post("/:obraId/previsualizar", authMiddleware, async (req, res) => {
  try {
    const { obraId } = req.params;
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.json({ avisos: [], items: [] });

    const pliego = await PliegoItem.findAll({ where: { obraId } });
    const pliegoPorId = new Map(pliego.map((p) => [p.id, p]));

    const normalizados = items
      .filter((i) => pliegoPorId.has(Number(i.pliego_item_id)))
      .map((i) => normalizarItem(i, pliegoPorId.get(Number(i.pliego_item_id))));

    const acumulado = await acumuladoPorItem(obraId, null, req.body.excluir_avance_id || null);
    return res.json({
      avisos: avisosDeExcedente(normalizados, pliegoPorId, acumulado),
      items: normalizados,
    });
  } catch (error) {
    console.error("Error previsualizando el avance:", error);
    return res.status(500).json({ error: "Error al previsualizar el avance" });
  }
});

/**
 * EXCEDENTES DE LA OBRA
 * GET /avances-obra/:obraId/excedentes
 *
 * Lo ejecutado por encima del pliego, por ítem, EN CANTIDAD Y SIN PRECIO.
 * Es la lista que después se lleva al replanteo o a la redeterminación, que es
 * donde recién se le pone precio.
 */
router.get("/:obraId/excedentes", authMiddleware, async (req, res) => {
  try {
    const { obraId } = req.params;

    const pliego = await PliegoItem.findAll({ where: { obraId }, order: [["numeroItem", "ASC"]] });
    if (pliego.length === 0) {
      return res.json({ excedentes: [], items_con_avance: 0, items_pliego: 0 });
    }

    const acumulado = await acumuladoPorItem(obraId);

    // Lo que ya se convirtió en ítem nuevo se descuenta del pendiente. Un
    // excedente puede reconocerse en partes —100 de 150 m3 en el replanteo de
    // junio y el resto en un adicional al final— así que se suma por ítem origen.
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
        // Lo que se hizo de más. SIN PRECIO a propósito: cuánto vale se define
        // en el replanteo, no lo decide quien carga el avance.
        excedente: total,
        // Lo que todavía no se reconoció en ningún ítem nuevo.
        ya_convertido: yaConvertido,
        pendiente: r5(Math.max(0, total - yaConvertido)),
        acumulado_porcentaje: r2(acu.porcentaje),
        excedente_porcentaje: r2(acu.porcentaje - 100),
      });
    }

    return res.json({
      excedentes,
      items_con_avance: conAvance,
      items_pliego: pliego.length,
      nota:
        "El excedente va en cantidad, no en pesos. Cuánto vale lo ejecutado por " +
        "encima del pliego se define en el replanteo o la redeterminación de obra.",
    });
  } catch (error) {
    console.error("Error obteniendo excedentes:", error);
    return res.status(500).json({ error: "Error al obtener los excedentes" });
  }
});

/**
 * CONVERTIR UN EXCEDENTE EN ÍTEM DEL PLIEGO
 * POST /avances-obra/:obraId/excedentes/:pliegoItemId/convertir
 *
 * Body: { cantidad, numero_item?, descripcion?, fecha? }
 *
 * El excedente NO se resuelve agrandándole la cantidad al ítem original: se
 * crea un ítem NUEVO, sin precio. La razón es simple: cuánto vale lo ejecutado
 * de más todavía no se sabe —se negocia en el replanteo o en un adicional— y
 * meterlo dentro del ítem original mezclaría cantidad contratada con cantidad
 * todavía sin precio.
 *
 * Se puede convertir en partes: si el comitente reconoce 100 de los 150 m3, se
 * convierten 100 y quedan 50 pendientes esperando el adicional del final.
 */
router.post(
  "/:obraId/excedentes/:pliegoItemId/convertir",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId, pliegoItemId } = req.params;
      const cantidad = aNumero(req.body.cantidad);

      const original = await PliegoItem.findOne({
        where: { id: pliegoItemId, obraId },
        transaction: t,
      });
      if (!original) {
        await t.rollback();
        return res.status(404).json({ message: "El ítem no pertenece al pliego de esta obra" });
      }
      if (original.origen === "excedente") {
        await t.rollback();
        return res.status(400).json({ message: "Ese ítem ya es un excedente convertido: no genera otro." });
      }
      if (!(cantidad > 0)) {
        await t.rollback();
        return res.status(400).json({ message: "Decí qué cantidad del excedente se reconoce." });
      }

      // Cuánto excedente hay, y cuánto queda sin convertir.
      const acumulado = await acumuladoPorItem(obraId, t);
      const acu = acumulado.get(original.id) || { porcentaje: 0, cantidad: 0 };
      const cantidadPliego = aNumero(original.cantidad);
      const total = Math.max(0, acu.cantidad - cantidadPliego);

      const hermanos = await PliegoItem.findAll({
        where: { obraId, origen: "excedente", item_origen_id: original.id },
        transaction: t,
      });
      const yaConvertido = hermanos.reduce((s, h) => s + aNumero(h.cantidad), 0);
      const pendiente = r5(total - yaConvertido);

      if (cantidad > pendiente + 0.00001) {
        await t.rollback();
        return res.status(400).json({
          message:
            `No se puede reconocer ${r5(cantidad)} ${original.unidadMedida || ""}: ` +
            `del excedente de ${r5(total)} quedan ${pendiente} sin convertir.`,
        });
      }

      // El número lo hace reconocible de un vistazo en el listado del pliego.
      const numero = String(req.body.numero_item || `${original.numeroItem} EXC`).trim();

      const nuevo = await PliegoItem.create(
        {
          obraId: Number(obraId),
          ItemGeneralId: original.ItemGeneralId,
          numeroItem: numero,
          descripcionItem: String(
            req.body.descripcion || `${original.descripcionItem} — excedente`
          ).trim(),
          unidadMedida: original.unidadMedida,
          cantidad,
          // SIN PRECIO. Queda en cero a propósito hasta que se negocie: un
          // precio inventado acá se convierte en un número que alguien después
          // toma por bueno.
          costoUnitario: 0,
          costoParcial: 0,
          origen: "excedente",
          item_origen_id: original.id,
          fecha_incorporacion: req.body.fecha || new Date().toISOString().slice(0, 10),
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({
        message:
          `Se creó el ítem ${numero} con ${r5(cantidad)} ${original.unidadMedida || ""}. ` +
          `Queda SIN PRECIO hasta que se defina en el replanteo o el adicional.`,
        item: nuevo,
        pendiente_restante: r5(pendiente - cantidad),
      });
    } catch (error) {
      await t.rollback();
      console.error("Error convirtiendo el excedente:", error);
      return res.status(500).json({ error: "Error al convertir el excedente" });
    }
  }
);

/**
 * CREAR AVANCE DE OBRA
 * POST /avances-obra/:obraId
 *
 * Body:
 * {
 *   numero_avance, fecha_avance, periodo_desde, periodo_hasta,
 *   items: [{ pliego_item_id, avance_porcentaje }]   ← o cantidad_ejecutada
 * }
 */
router.post(
  "/:obraId",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();

    try {
      const { obraId } = req.params;
      const { numero_avance, fecha_avance, periodo_desde, periodo_hasta, items } = req.body;

      if (!numero_avance || !fecha_avance || !periodo_desde || !periodo_hasta) {
        await t.rollback();
        return res.status(400).json({ message: "Faltan datos en cabecera del avance" });
      }

      if (!Array.isArray(items) || items.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: "Debe enviar items del avance" });
      }

      // El pliego manda: define la cantidad contratada y la unidad de medida.
      const pliego = await PliegoItem.findAll({ where: { obraId }, transaction: t });
      const pliegoPorId = new Map(pliego.map((p) => [p.id, p]));

      const ajenos = items.filter((i) => !pliegoPorId.has(Number(i.pliego_item_id)));
      if (ajenos.length > 0) {
        await t.rollback();
        return res.status(400).json({
          message: `Hay ${ajenos.length} ítem(s) que no pertenecen al pliego de esta obra.`,
        });
      }

      const acumulado = await acumuladoPorItem(obraId, t);

      const avanceItems = items.map((i) =>
        normalizarItem(i, pliegoPorId.get(Number(i.pliego_item_id)))
      );

      // Los avisos se calculan ANTES de insertar, contra lo que ya había.
      const avisos = avisosDeExcedente(avanceItems, pliegoPorId, acumulado);

      const avance = await AvanceObra.create(
        {
          obra_id: obraId,
          numero_avance,
          fecha_avance,
          periodo_desde,
          periodo_hasta,
        },
        { transaction: t }
      );

      await AvanceObraItem.bulkCreate(
        avanceItems.map((i) => ({ ...i, avance_obra_id: avance.id })),
        { transaction: t }
      );

      await t.commit();

      return res.status(201).json({
        message: "Avance de obra guardado correctamente",
        id: avance.id,
        items_insertados: avanceItems.length,
        // El avance se guarda igual: son avisos, no errores. Lo que se ejecutó
        // se ejecutó, y no registrarlo no lo hace desaparecer.
        avisos,
        hay_excedentes: avisos.length > 0,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error guardando avance de obra:", error);
      return res.status(500).json({ error: "Error al guardar avance de obra" });
    }
  }
);

export default router;
