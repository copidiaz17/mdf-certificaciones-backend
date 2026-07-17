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

/* ==========================================================
   🔒 Cálculo financiero SERVER-SIDE (fuente de verdad).
   Réplica exacta de la fórmula del frontend (AddCertificacionView),
   elegida según la repartición de la obra.
========================================================== */
function calcularTotales(subtotal, reparticion) {
  const t = {
    subtotal,
    deduccion_anticipo: 0,
    fondo_reparo: 0,
    tasa_inspeccion: 0,
    sustitucion_fondo_reparo: 0,
    gastos_generales: 0,
    beneficios: 0,
    iva: 0,
    ingresos_brutos: 0,
    total_neto: subtotal,
  };

  if (reparticion === "municipalidad_sgo") {
    const deduccionAnticipo = subtotal * 0.4; // 40%
    const fondoReparo = subtotal * 0.05; // 5%
    const tasaInspeccion = subtotal * 0.03; // 3%
    const subtotal1 = subtotal - deduccionAnticipo;
    const subtotal2 = subtotal1 - fondoReparo - tasaInspeccion;
    const sustitucionFondoReparo = fondoReparo; // se re-suma
    t.deduccion_anticipo = deduccionAnticipo;
    t.fondo_reparo = fondoReparo;
    t.tasa_inspeccion = tasaInspeccion;
    t.sustitucion_fondo_reparo = sustitucionFondoReparo;
    t.total_neto = subtotal2 + sustitucionFondoReparo;
  } else if (reparticion === "direccion_arquitectura") {
    const gastosGenerales = subtotal * 0.15; // 15%
    const subtotal1 = subtotal + gastosGenerales;
    const beneficios = subtotal1 * 0.1; // 10%
    const subtotal2 = subtotal1 + beneficios;
    const iva = subtotal2 * 0.21; // 21%
    const ingresosBrutos = subtotal2 * 0.025; // 2.5%
    t.gastos_generales = gastosGenerales;
    t.beneficios = beneficios;
    t.iva = iva;
    t.ingresos_brutos = ingresosBrutos;
    t.total_neto = subtotal2 - iva - ingresosBrutos;
  }
  // Si la obra no tiene repartición definida → total_neto = subtotal (sin deducciones)

  return t;
}


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
      } = req.body;
      // ⚠️ Los "totales" e "importe" que manda el front YA NO se usan como verdad.
      // El servidor recalcula todo desde el pliego (fuente de verdad de la plata).

      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("La certificación debe contener ítems");
      }

      // Obra → define la repartición y por ende la fórmula financiera
      const obra = await Obra.findByPk(obraId, { transaction });
      if (!obra) throw new Error("Obra no encontrada");

      // Ítems de pliego involucrados (fuente de verdad de cantidad y costo)
      const pliegoIds = items.map((it) => it.pliego_item_id);
      const pliegoItems = await PliegoItem.findAll({
        where: { id: pliegoIds, obraId },
        transaction,
        raw: true,
      });
      const pliegoMap = {};
      pliegoItems.forEach((p) => (pliegoMap[p.id] = p));

      // Certificaciones existentes de la obra (para el acumulado del 100%)
      const certs = await Certificacion.findAll({
        where: { obra_id: obraId },
        attributes: ["id"],
        raw: true,
        transaction,
      });
      const certIds = certs.map((c) => c.id);

      /* =========================================
         🔒 Recalcular importe por ítem (server-side)
         + validar pertenencia y acumulado ≤ 100%
      ========================================== */
      const itemsCalculados = [];
      let subtotal = 0;

      for (const item of items) {
        const { pliego_item_id, avance_porcentaje } = item;
        const pct = Number(avance_porcentaje);

        if (!pct || pct <= 0) {
          throw new Error(`El avance del ítem ${pliego_item_id} debe ser mayor a 0`);
        }

        const pliego = pliegoMap[pliego_item_id];
        if (!pliego) {
          throw new Error(`El ítem ${pliego_item_id} no pertenece a esta obra`);
        }

        // Acumulado previo (no puede superar 100%)
        let totalCertificado = 0;
        if (certIds.length > 0) {
          totalCertificado = await CertificacionItem.sum("avance_porcentaje", {
            where: { PliegoItemId: pliego_item_id, CertificacionId: certIds },
            transaction,
          });
        }
        const acumuladoPrevio = Number(totalCertificado || 0);
        if (acumuladoPrevio + pct > 100) {
          throw new Error(
            `El ítem ${pliego_item_id} supera el 100% certificado (acumulado previo ${acumuladoPrevio}%, nuevo ${pct}%).`
          );
        }

        // Importe = cantidad × costo unitario × (avance% / 100) — DESDE EL PLIEGO
        const importe = (Number(pliego.cantidad) * Number(pliego.costoUnitario) * pct) / 100;
        subtotal += importe;
        itemsCalculados.push({ pliego_item_id, avance_porcentaje: pct, importe });
      }

      // 🔒 Desglose financiero calculado en el servidor según la repartición
      const tot = calcularTotales(subtotal, obra.reparticion);

      /* =========================================
         1️⃣ Crear CABECERA con los valores recalculados
      ========================================== */
      const certificacion = await Certificacion.create(
        {
          obra_id: obraId,
          periodo_desde,
          periodo_hasta,
          numero_certificado,
          fecha_certificacion,
          subtotal: tot.subtotal,
          total_neto: tot.total_neto,
          deduccion_anticipo: tot.deduccion_anticipo,
          fondo_reparo: tot.fondo_reparo,
          tasa_inspeccion: tot.tasa_inspeccion,
          sustitucion_fondo_reparo: tot.sustitucion_fondo_reparo,
          gastos_generales: tot.gastos_generales,
          beneficios: tot.beneficios,
          iva: tot.iva,
          ingresos_brutos: tot.ingresos_brutos,
        },
        { transaction }
      );

      /* =========================================
         2️⃣ Crear ÍTEMS con el importe recalculado
      ========================================== */
      for (const it of itemsCalculados) {
        await CertificacionItem.create(
          {
            CertificacionId: certificacion.id,
            PliegoItemId: it.pliego_item_id,
            avance_porcentaje: it.avance_porcentaje,
            importe: it.importe,
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
