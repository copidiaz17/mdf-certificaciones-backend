// backend/routes/certificaciones.js
import express from "express";
import { sequelize } from "../database.js";

import Certificacion from "../models/Certificacion.js";
import CertificacionItem from "../models/CertificacionItem.js";
import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();


/*==========================================================
   🔹 LISTAR CERTIFICACIONES DE UNA OBRA
   GET /obras/:obraId/certificaciones
   (usado por ObraDetalleView para el historial)
========================================================== */
router.get(
  "/obras/:obraId/certificaciones",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const certs = await Certificacion.findAll({
        where: { obra_id: obraId }, // 👈 importante: obra_id como en la DB
        order: [
          ["fecha_certificacion", "ASC"],
          ["id", "ASC"],
        ],
        attributes: [
          "id",
          "numero_certificado",
          "periodo_desde",
          "periodo_hasta",
          "fecha_certificacion",
          "subtotal",
          "total_neto",
        ],
      });

      return res.json(certs);
    } catch (error) {
      console.error("Error listando certificaciones:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al obtener las certificaciones de la obra",
      });
    }
  }
);

/* ==========================================================
   🔹 ACUMULADO CERTIFICADO POR ÍTEM
   GET /obras/:obraId/certificaciones/acumulado
========================================================== */
router.get(
  "/obras/:obraId/certificaciones/acumulado",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      // 1️⃣ Traer todas las certificaciones de esa obra
      const certs = await Certificacion.findAll({
        where: { obra_id: obraId },   // usamos el nombre de columna/atributo que tenés en el modelo
        attributes: ["id"],
        raw: true,
      });

      const certIds = certs.map((c) => c.id);

      if (certIds.length === 0) {
        return res.json({ ok: true, data: {} });
      }

      // 2️⃣ Agrupar por ítem sumando el avance_porcentaje
      const rows = await CertificacionItem.findAll({
        attributes: [
          "PliegoItemId",
          [
            sequelize.fn("SUM", sequelize.col("avance_porcentaje")),
            "acumulado",
          ],
        ],
        where: {
          CertificacionId: certIds, // IN (...)
        },
        group: ["PliegoItemId"],
        raw: true,
      });

      const acumulados = {};
      rows.forEach((r) => {
        acumulados[r.PliegoItemId] = Number(r.acumulado);
      });

      res.json({ ok: true, data: acumulados });
    } catch (error) {
      console.error("Error acumulado certificaciones:", error);
      res.status(500).json({
        ok: false,
        error: "Error al calcular acumulados certificados",
      });
    }
  }
);




/* ==========================================================
   🔹 CREAR CERTIFICACIÓN
   POST /obras/:obraId/certificaciones
========================================================== */
router.post(
  "/obras/:obraId/certificaciones",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
      const { obraId } = req.params;
      const {
        numero_certificado,
        fecha_certificacion,
        periodo_desde,
        periodo_hasta,
        items,
        totales, // 🔹 viene del front con todo el desglose financiero
      } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("La certificación debe contener ítems");
      }

      const t = totales || {};
      const subtotal = Number(t.subtotal || 0);
      const totalNeto = Number(t.totalNeto || 0);

      /* =========================================
         🔒 Validación de acumulados por ÍTEM
         (no puede superar 100% en total)
      ========================================== */

      // 1️⃣ Traer todas las certificaciones existentes de esa obra
      const certs = await Certificacion.findAll({
        where: { obra_id: obraId },
        attributes: ["id"],
        raw: true,
        transaction,
      });

      const certIds = certs.map((c) => c.id);

      for (const item of items) {
        const { pliego_item_id, avance_porcentaje } = item;

        if (!avance_porcentaje || avance_porcentaje <= 0) {
          throw new Error(
            `El avance del ítem ${pliego_item_id} debe ser mayor a 0`
          );
        }

        let totalCertificado = 0;

        if (certIds.length > 0) {
          totalCertificado = await CertificacionItem.sum(
            "avance_porcentaje",
            {
              where: {
                PliegoItemId: pliego_item_id,
                CertificacionId: certIds, // IN (...) sobre certificaciones de esa obra
              },
              transaction,
            }
          );
        }

        const acumuladoPrevio = Number(totalCertificado || 0);

        if (acumuladoPrevio + Number(avance_porcentaje) > 100) {
          throw new Error(
            `El ítem ${pliego_item_id} supera el 100% certificado (acumulado previo ${acumuladoPrevio}%, nuevo ${avance_porcentaje}%).`
          );
        }
      }

      /* =========================================
         1️⃣ Crear CABECERA de certificación
         Usando los nombres que tenés en la tabla:
         obra_id, periodo_desde, periodo_hasta, etc.
      ========================================== */
      const certificacion = await Certificacion.create(
        {
          obra_id: obraId,
          periodo_desde,
          periodo_hasta,
          numero_certificado,
          fecha_certificacion,

          // 🔹 Datos financieros que EXISTEN en la tabla
          subtotal: subtotal,
          total_neto: totalNeto,
          deduccion_anticipo: Number(t.deduccionAnticipo || 0),
          fondo_reparo: Number(t.fondoReparo || 0),
          tasa_inspeccion: Number(t.tasaInspeccion || 0),
          sustitucion_fondo_reparo: Number(
            t.sustitucionFondoReparo || 0
          ),
          gastos_generales: Number(t.gastosGenerales || 0),
          beneficios: Number(t.beneficios || 0),
          iva: Number(t.iva || 0),
          ingresos_brutos: Number(t.ingresosBrutos || 0),
          // Si luego agregás columnas subtotal1, subtotal2, avance_financiero, etc.,
          // se mapean acá también.
        },
        { transaction }
      );

      /* =========================================
         2️⃣ Crear ÍTEMS de certificación
         Usar SIEMPRE los nombres de atributo
         del modelo: CertificacionId / PliegoItemId
      ========================================== */
      for (const item of items) {
        await CertificacionItem.create(
          {
            CertificacionId: certificacion.id,     // 👈 atributo de modelo
            PliegoItemId: item.pliego_item_id,     // 👈 atributo de modelo
            avance_porcentaje: item.avance_porcentaje,
            importe: item.importe,
          },
          { transaction }
        );
      }

      await transaction.commit();

      res.status(201).json({
        ok: true,
        certificacion_id: certificacion.id,
      });
    } catch (error) {
      await transaction.rollback();
      console.error("Error creando certificación:", error);
      res.status(400).json({ ok: false, error: error.message });
    }
  }
);

/* ==========================================================
   🔹 DETALLE DE UNA CERTIFICACIÓN
   GET /api/certificaciones/:id/detalle
   ========================================================== */
router.get(
  "/:id/detalle",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const certificacion = await Certificacion.findByPk(id, {
        include: [
          {
            model: Obra,
            as: "obra",
            attributes: ["id", "nombre", "reparticion"],
          },
          {
            model: CertificacionItem,
            as: "items",
            include: [
              {
                model: PliegoItem,
                as: "pliegoItem",
                attributes: [
                  "id",
                  "numeroItem",
                  "descripcionItem",
                  "unidadMedida",
                  "cantidad",
                  "costoUnitario",
                  "costoParcial",
                ],
              },
            ],
          },
        ],
      });

      if (!certificacion) {
        return res.status(404).json({
          ok: false,
          error: "Certificación no encontrada",
        });
      }

      // Total del proyecto para calcular % del certificado
      const pliegoItems = await PliegoItem.findAll({
        where: { obraId: certificacion.obra_id },
        attributes: ["costoParcial"],
        raw: true,
      });

      const totalProyecto = pliegoItems.reduce(
        (acc, i) => acc + Number(i.costoParcial || 0),
        0
      );

      const subtotal = Number(certificacion.subtotal || 0);
      const porcentajeFinanciero = totalProyecto
        ? Number(((subtotal / totalProyecto) * 100).toFixed(2))
        : 0;

      // Normalizamos respuesta
      const certificadoDTO = {
        id: certificacion.id,
        obraId: certificacion.obra_id,
        obraNombre: certificacion.obra?.nombre || "",
        reparticion: certificacion.obra?.reparticion || null,

        numero_certificado: certificacion.numero_certificado,
        fecha_certificacion: certificacion.fecha_certificacion,
        periodo_desde: certificacion.periodo_desde,
        periodo_hasta: certificacion.periodo_hasta,

        subtotal,
        total_neto: Number(certificacion.total_neto || 0),

        deduccion_anticipo: Number(
          certificacion.deduccion_anticipo || 0
        ),
        fondo_reparo: Number(certificacion.fondo_reparo || 0),
        tasa_inspeccion: Number(certificacion.tasa_inspeccion || 0),
        sustitucion_fondo_reparo: Number(
          certificacion.sustitucion_fondo_reparo || 0
        ),

        gastos_generales: Number(certificacion.gastos_generales || 0),
        beneficios: Number(certificacion.beneficios || 0),
        iva: Number(certificacion.iva || 0),
        ingresos_brutos: Number(certificacion.ingresos_brutos || 0),

        totalProyecto,
        porcentajeFinanciero,
      };

      const itemsDTO = certificacion.items.map((ci) => ({
        id: ci.id,
        pliego_item_id: ci.PliegoItemId,
        numeroItem: ci.pliegoItem?.numeroItem || "",
        descripcion:
          ci.pliegoItem?.descripcionItem || "(sin descripción)",
        unidad: ci.pliegoItem?.unidadMedida || "",
        cantidad_total: Number(ci.pliegoItem?.cantidad || 0),
        avance_porcentaje: Number(ci.avance_porcentaje || 0),
        importe: Number(ci.importe || 0),
      }));

      return res.json({
        ok: true,
        certificado: certificadoDTO,
        items: itemsDTO,
      });
    } catch (error) {
      console.error("Error obteniendo detalle de certificación:", error);
      return res.status(500).json({
        ok: false,
        error: "Error al obtener detalle de certificación",
      });
    }
  }
);


/* ==========================================================
   🔹 EDITAR CABECERA DE UNA CERTIFICACIÓN
   PUT /api/certificaciones/:certId
   ========================================================== */
router.put(
  "/:certId",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    try {
      const { certId } = req.params;
      const { numero_certificado, fecha_certificacion, periodo_desde, periodo_hasta } = req.body;

      if (!numero_certificado || !fecha_certificacion || !periodo_desde || !periodo_hasta) {
        return res.status(400).json({ ok: false, error: "Todos los campos de cabecera son requeridos." });
      }

      const cert = await Certificacion.findByPk(certId);
      if (!cert) {
        return res.status(404).json({ ok: false, error: "Certificación no encontrada." });
      }

      await cert.update({ numero_certificado, fecha_certificacion, periodo_desde, periodo_hasta });

      return res.json({ ok: true, message: "Certificación actualizada correctamente." });
    } catch (error) {
      console.error("Error editando certificación:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);

export default router;
