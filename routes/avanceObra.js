import express from "express";
import { sequelize } from "../database.js";

import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

/**
 * CREAR AVANCE DE OBRA (POR PORCENTAJE)
 * POST /avances-obra/:obraId   (depende de dónde montes este router)
 *
 * Body:
 * {
 *   numero_avance, fecha_avance, periodo_desde, periodo_hasta,
 *   items: [{ pliego_item_id, avance_porcentaje }]
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

      // Crear encabezado
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

      // Preparar ítems (porcentaje)
      const avanceItems = items.map((i) => {
        const porc = Number(i.avance_porcentaje || 0);
        return {
          avance_obra_id: avance.id,
          pliego_item_id: i.pliego_item_id,
          avance_porcentaje: Math.max(0, Math.min(100, porc)),
        };
      });

      // Insert masivo
      await AvanceObraItem.bulkCreate(avanceItems, { transaction: t });

      await t.commit();

      return res.status(201).json({
        message: "Avance de obra guardado correctamente",
        id: avance.id,
        items_insertados: avanceItems.length,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error guardando avance de obra:", error);
      return res.status(500).json({ error: "Error al guardar avance de obra" });
    }
  }
);

export default router;
