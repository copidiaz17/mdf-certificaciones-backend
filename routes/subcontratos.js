import express from "express";
import { Op } from "sequelize";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";
import Subcontrato from "../models/Subcontrato.js";
import SubcontratoItem from "../models/SubcontratoItem.js";
import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

const ESTADOS = ["vigente", "finalizado", "anulado"];

// ── Quincenas ────────────────────────────────────────────────────────────
// Al subcontratista se le certifica por quincena: del 1 al 15, y del 16 al
// último día del mes. Como ninguna quincena cruza de mes, cada una cae entera
// dentro de un mes de certificación: no hay períodos a caballo que repartir.
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const partes = (f) => {
  if (!f) return null;
  const [a, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return { anio: a, mes: m, dia: d };
};

const ultimoDiaDelMes = (anio, mes) => new Date(anio, mes, 0).getDate();

// ¿El período es una quincena bien formada?
function analizarQuincena(desde, hasta) {
  const d = partes(desde);
  const h = partes(hasta);
  if (!d || !h) return { valida: false, numero: null, etiqueta: null, motivo: "faltan las fechas del período" };
  if (d.anio !== h.anio || d.mes !== h.mes) {
    return { valida: false, numero: null, etiqueta: null, motivo: "el período cruza de mes" };
  }

  const ultimo = ultimoDiaDelMes(d.anio, d.mes);
  const nombreMes = `${MESES[d.mes - 1]} ${d.anio}`;

  if (d.dia === 1 && h.dia === 15) {
    return { valida: true, numero: 1, etiqueta: `1ª quincena de ${nombreMes}`, motivo: null };
  }
  if (d.dia === 16 && h.dia === ultimo) {
    return { valida: true, numero: 2, etiqueta: `2ª quincena de ${nombreMes}`, motivo: null };
  }

  const numero = d.dia <= 15 ? 1 : 2;
  return {
    valida: false,
    numero,
    etiqueta: `${numero}ª quincena de ${nombreMes} (fechas irregulares)`,
    motivo: `debería ir del ${numero === 1 ? "1 al 15" : `16 al ${ultimo}`}`,
  };
}

/* ======================================================
   LISTAR los subcontratos de una obra
====================================================== */
router.get(
  "/:obraId/subcontratos",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const subs = await Subcontrato.findAll({
        where: { obra_id: req.params.obraId },
        include: [{
          model: SubcontratoItem, as: "items",
          include: [{ model: PliegoItem, as: "pliegoItem", attributes: ["id", "numeroItem", "descripcionItem", "unidadMedida", "cantidad", "costoParcial"] }],
        }],
        order: [["id", "ASC"]],
      });

      const salida = subs.map((s) => {
        const j = s.toJSON();
        j.monto_contrato = Number(
          (j.items || []).reduce((acc, i) => acc + Number(i.precio_acordado || 0), 0).toFixed(2)
        );
        return j;
      });

      return res.json(salida);
    } catch (error) {
      console.error("Error listando subcontratos:", error);
      return res.status(500).json({ message: "Error al listar subcontratos" });
    }
  }
);

/* ======================================================
   ÍTEMS DEL PLIEGO disponibles para subcontratar
   Marca los que ya están tomados por otro subcontrato de la obra.
====================================================== */
router.get(
  "/:obraId/subcontratos-items-disponibles",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    try {
      const { obraId } = req.params;
      const excluir = Number(req.query.excluir_subcontrato) || 0; // al editar, no contarse a sí mismo

      const items = await PliegoItem.findAll({ where: { obraId }, order: [["numeroItem", "ASC"]] });

      const subs = await Subcontrato.findAll({ where: { obra_id: obraId }, attributes: ["id", "subcontratista"], raw: true });
      const subsPorId = Object.fromEntries(subs.map((s) => [s.id, s.subcontratista]));
      const tomados = subs.length
        ? await SubcontratoItem.findAll({ where: { subcontrato_id: subs.map((s) => s.id) }, raw: true })
        : [];

      const tomadoPor = {};
      tomados.forEach((t) => {
        if (t.subcontrato_id === excluir) return;
        tomadoPor[t.pliego_item_id] = subsPorId[t.subcontrato_id];
      });

      return res.json(items.map((i) => ({
        ...i.toJSON(),
        tomado_por: tomadoPor[i.id] || null,
      })));
    } catch (error) {
      console.error("Error ítems disponibles subcontrato:", error);
      return res.status(500).json({ message: "Error al cargar los ítems del pliego" });
    }
  }
);

/* ======================================================
   CREAR un subcontrato con sus ítems
====================================================== */
router.post(
  "/:obraId/subcontratos",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId } = req.params;
      const { subcontratista, cuit, fecha_contrato, estado, observaciones, items } = req.body;

      if (!subcontratista || !String(subcontratista).trim()) {
        await t.rollback();
        return res.status(400).json({ message: "Falta el nombre del subcontratista" });
      }
      if (!Array.isArray(items) || items.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: "Hay que indicar al menos un ítem a cargo del subcontratista" });
      }
      if (estado && !ESTADOS.includes(estado)) {
        await t.rollback();
        return res.status(400).json({ message: "Estado inválido" });
      }

      const obra = await Obra.findByPk(obraId);
      if (!obra) { await t.rollback(); return res.status(404).json({ message: "Obra no encontrada" }); }

      // Los ítems tienen que ser del pliego de ESTA obra.
      const idsPliego = (await PliegoItem.findAll({ where: { obraId }, attributes: ["id"], raw: true })).map((i) => i.id);
      for (const it of items) {
        if (!idsPliego.includes(Number(it.pliego_item_id))) {
          await t.rollback();
          return res.status(400).json({ message: `El ítem ${it.pliego_item_id} no pertenece al pliego de esta obra` });
        }
        if (Number(it.precio_acordado) < 0 || Number.isNaN(Number(it.precio_acordado))) {
          await t.rollback();
          return res.status(400).json({ message: "El precio acordado debe ser un número válido" });
        }
      }

      const sub = await Subcontrato.create({
        obra_id: obraId,
        subcontratista: String(subcontratista).trim(),
        cuit: cuit || null,
        fecha_contrato: fecha_contrato || null,
        estado: estado || "vigente",
        observaciones: observaciones || null,
      }, { transaction: t });

      await SubcontratoItem.bulkCreate(
        items.map((i) => ({
          subcontrato_id: sub.id,
          pliego_item_id: Number(i.pliego_item_id),
          precio_acordado: Number(i.precio_acordado || 0),
        })),
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({ ok: true, subcontrato_id: sub.id, items: items.length });
    } catch (error) {
      await t.rollback();
      console.error("Error creando subcontrato:", error);
      return res.status(500).json({ message: "Error al crear el subcontrato", error: error.message });
    }
  }
);

/* ======================================================
   EDITAR un subcontrato (reemplaza sus ítems)
====================================================== */
router.put(
  "/:obraId/subcontratos/:subId",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId, subId } = req.params;
      const sub = await Subcontrato.findOne({ where: { id: subId, obra_id: obraId } });
      if (!sub) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }

      const { subcontratista, cuit, fecha_contrato, estado, observaciones, items } = req.body;
      if (estado && !ESTADOS.includes(estado)) {
        await t.rollback();
        return res.status(400).json({ message: "Estado inválido" });
      }

      await sub.update({
        subcontratista: subcontratista !== undefined ? String(subcontratista).trim() : sub.subcontratista,
        cuit: cuit !== undefined ? cuit : sub.cuit,
        fecha_contrato: fecha_contrato !== undefined ? (fecha_contrato || null) : sub.fecha_contrato,
        estado: estado || sub.estado,
        observaciones: observaciones !== undefined ? observaciones : sub.observaciones,
      }, { transaction: t });

      if (Array.isArray(items)) {
        await SubcontratoItem.destroy({ where: { subcontrato_id: sub.id }, transaction: t });
        await SubcontratoItem.bulkCreate(
          items.map((i) => ({
            subcontrato_id: sub.id,
            pliego_item_id: Number(i.pliego_item_id),
            precio_acordado: Number(i.precio_acordado || 0),
          })),
          { transaction: t }
        );
      }

      await t.commit();
      return res.json({ ok: true, message: "Subcontrato actualizado" });
    } catch (error) {
      await t.rollback();
      console.error("Error actualizando subcontrato:", error);
      return res.status(500).json({ message: "Error al actualizar el subcontrato" });
    }
  }
);

/* ======================================================
   BORRAR un subcontrato
====================================================== */
router.delete(
  "/:obraId/subcontratos/:subId",
  authMiddleware,
  hasRole([ROLES.ADMIN]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const sub = await Subcontrato.findOne({ where: { id: req.params.subId, obra_id: req.params.obraId } });
      if (!sub) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }
      await SubcontratoItem.destroy({ where: { subcontrato_id: sub.id }, transaction: t });
      await sub.destroy({ transaction: t });
      await t.commit();
      return res.json({ ok: true, message: "Subcontrato eliminado" });
    } catch (error) {
      await t.rollback();
      console.error("Error borrando subcontrato:", error);
      return res.status(500).json({ message: "Error al borrar el subcontrato" });
    }
  }
);

/* ======================================================
   LIQUIDACIÓN — cuánto le corresponde cobrar, quincena por quincena
   Cada avance de obra es una quincena. Por cada ítem avanzado que esté
   en el subcontrato:   a pagar = precio_acordado × (% avanzado / 100)
====================================================== */
router.get(
  "/:obraId/subcontratos/:subId/liquidacion",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId, subId } = req.params;

      const sub = await Subcontrato.findOne({
        where: { id: subId, obra_id: obraId },
        include: [{
          model: SubcontratoItem, as: "items",
          include: [{ model: PliegoItem, as: "pliegoItem", attributes: ["id", "numeroItem", "descripcionItem", "unidadMedida"] }],
        }],
      });
      if (!sub) return res.status(404).json({ message: "Subcontrato no encontrado" });

      // Precio acordado por ítem, para cruzar contra los avances.
      const precioPorItem = {};
      const datosItem = {};
      (sub.items || []).forEach((i) => {
        precioPorItem[i.pliego_item_id] = Number(i.precio_acordado || 0);
        datosItem[i.pliego_item_id] = i.pliegoItem ? i.pliegoItem.toJSON() : null;
      });
      const idsDelSub = Object.keys(precioPorItem).map(Number);

      // Solo se liquida lo ejecutado DESDE la fecha del contrato en adelante.
      // Sin este filtro, un subcontrato firmado en septiembre se llevaría el
      // avance que otro hizo en junio sobre esos mismos ítems.
      const where = { obra_id: obraId };
      if (sub.fecha_contrato) {
        where.periodo_hasta = { [Op.gte]: sub.fecha_contrato };
      }

      const avances = await AvanceObra.findAll({
        where,
        order: [["periodo_desde", "ASC"], ["fecha_avance", "ASC"], ["id", "ASC"]],
        raw: true,
      });

      const avanceItems = avances.length
        ? await AvanceObraItem.findAll({ where: { avance_obra_id: avances.map((a) => a.id) }, raw: true })
        : [];
      const itemsPorAvance = {};
      avanceItems.forEach((ai) => {
        (itemsPorAvance[ai.avance_obra_id] ||= []).push(ai);
      });

      let acumulado = 0;
      const quincenas = [];

      for (const a of avances) {
        const detalle = [];
        let subtotal = 0;

        for (const ai of itemsPorAvance[a.id] || []) {
          if (!idsDelSub.includes(ai.pliego_item_id)) continue;   // ítem que no es del subcontratista
          const porc = Number(ai.avance_porcentaje || 0);
          const monto = Number(((precioPorItem[ai.pliego_item_id] * porc) / 100).toFixed(2));
          subtotal += monto;
          detalle.push({
            pliego_item_id: ai.pliego_item_id,
            numeroItem: datosItem[ai.pliego_item_id]?.numeroItem,
            descripcion: datosItem[ai.pliego_item_id]?.descripcionItem,
            avance_porcentaje: porc,
            precio_acordado: precioPorItem[ai.pliego_item_id],
            a_pagar: monto,
          });
        }

        if (detalle.length === 0) continue;   // esa quincena el sub no tocó ítems suyos

        subtotal = Number(subtotal.toFixed(2));
        acumulado = Number((acumulado + subtotal).toFixed(2));

        const q = analizarQuincena(a.periodo_desde, a.periodo_hasta);

        quincenas.push({
          avance_id: a.id,
          numero_avance: a.numero_avance,
          desde: a.periodo_desde,
          hasta: a.periodo_hasta,
          fecha_avance: a.fecha_avance,
          // Debería ir del 1 al 15 o del 16 a fin de mes. Si no, se avisa
          // (pero se liquida igual: en la obra puede haber pasado así).
          quincena: q.numero,
          etiqueta: q.etiqueta,
          quincena_correcta: q.valida,
          observacion_periodo: q.motivo,
          items: detalle,
          a_pagar: subtotal,
          acumulado,
        });
      }

      const montoContrato = Number(
        Object.values(precioPorItem).reduce((s, v) => s + v, 0).toFixed(2)
      );

      return res.json({
        subcontrato: {
          id: sub.id,
          subcontratista: sub.subcontratista,
          cuit: sub.cuit,
          estado: sub.estado,
          fecha_contrato: sub.fecha_contrato,
          monto_contrato: montoContrato,
          cantidad_items: idsDelSub.length,
        },
        quincenas,
        total_liquidado: acumulado,
        saldo_contrato: Number((montoContrato - acumulado).toFixed(2)),
        avance_pct: montoContrato > 0 ? Number(((acumulado / montoContrato) * 100).toFixed(2)) : 0,
      });
    } catch (error) {
      console.error("Error liquidación subcontrato:", error);
      return res.status(500).json({ message: "Error al calcular la liquidación" });
    }
  }
);

export default router;
