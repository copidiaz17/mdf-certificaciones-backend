import express from "express";
import { Op, col } from "sequelize";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";

import Planificacion from "../models/planificacion.js";
import PlanificacionItem from "../models/planificacionItem.js";

import Certificacion from "../models/Certificacion.js";
import CertificacionItem from "../models/CertificacionItem.js";

import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

/* ======================================================
   🔹 OBRAS
====================================================== */
router.post(
  "/",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    try {
      const { nombre, ubicacion, reparticion } = req.body;
      if (!nombre) return res.status(400).json({ message: "El nombre es obligatorio" });

      const reparticionesPermitidas = ["municipalidad_sgo", "direccion_arquitectura"];
      if (reparticion && !reparticionesPermitidas.includes(reparticion)) {
        return res.status(400).json({ message: "Repartición no válida" });
      }

      const obra = await Obra.create({ nombre, ubicacion, reparticion: reparticion || null });
      return res.status(201).json(obra);
    } catch (e) {
      return res.status(500).json({ error: "Error interno" });
    }
  }
);

router.get(
  "/",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    const obras = await Obra.findAll();
    return res.json(obras);
  }
);

router.get(
  "/:obraId",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    const obra = await Obra.findByPk(req.params.obraId);
    if (!obra) return res.status(404).json({ message: "Obra no encontrada" });
    return res.json(obra);
  }
);

/* ======================================================
   🔹 PLIEGO
====================================================== */
router.get(
  "/:obraId/pliego",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    const items = await PliegoItem.findAll({
      where: { obraId: req.params.obraId },
      order: [[sequelize.cast(col("numeroItem"), "UNSIGNED"), "ASC"]],
    });
    return res.json(items);
  }
);

/* ======================================================
   🔹 PLANIFICACIONES
====================================================== */
router.post(
  "/:obraId/planificacion",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();

    try {
      const { obraId } = req.params;
      const { fecha_desde, fecha_hasta, items } = req.body;

      if (!fecha_desde || !fecha_hasta || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ message: "Datos incompletos para la planificación" });
      }

      if (new Date(fecha_desde) > new Date(fecha_hasta)) {
        return res.status(400).json({ message: "La fecha desde no puede ser mayor que la fecha hasta" });
      }

      const existe = await Planificacion.findOne({
        where: {
          obraId,
          [Op.or]: [
            { fecha_desde: { [Op.between]: [fecha_desde, fecha_hasta] } },
            { fecha_hasta: { [Op.between]: [fecha_desde, fecha_hasta] } },
            {
              [Op.and]: [
                { fecha_desde: { [Op.lte]: fecha_desde } },
                { fecha_hasta: { [Op.gte]: fecha_hasta } },
              ],
            },
          ],
        },
      });

      if (existe) return res.status(400).json({ message: "Ya existe una planificación en ese período" });

      const planificacion = await Planificacion.create(
        {
          obraId,
          nombre: `Planificación ${fecha_desde} → ${fecha_hasta}`,
          fecha_desde,
          fecha_hasta,
          estado: "abierta",
        },
        { transaction: t }
      );

      for (const item of items) {
        const { pliego_item_id, porcentaje_planificado } = item;

        const pliego = await PliegoItem.findByPk(pliego_item_id);
        if (!pliego) throw new Error(`Ítem de pliego no encontrado: ${pliego_item_id}`);

        await PlanificacionItem.create(
          {
            planificacion_id: planificacion.id,
            pliego_item_id,
            porcentaje_planificado: porcentaje_planificado || 0,
          },
          { transaction: t }
        );
      }

      await t.commit();
      return res.status(201).json({
        ok: true,
        message: "Planificación creada correctamente",
        planificacion_id: planificacion.id,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error creando planificación:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);

/* ======================================================
   📈 CURVA DE AVANCE (AVANCE REAL POR % PONDERADO)
====================================================== */
router.get(
  "/:obraId/curva-avance",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const empty = {
        labels: [],
        planificado: [],
        certificado: [],
        avance: [],
        certNumerosPorPeriodo: [],
        financiero: [],
        financieroMontos: [],
      };

      const obra = await Obra.findByPk(obraId);
      if (!obra) return res.json(empty);

      const reparticion = obra.reparticion;
      const anticipoPorc =
        reparticion === "municipalidad_sgo"
          ? 40
          : reparticion === "direccion_arquitectura"
          ? 20
          : 0;

      // 1) Pliego -> costo total
      const pliegoItems = await PliegoItem.findAll({
        where: { obraId },
        attributes: ["id", "costoParcial"],
        raw: true,
      });
      if (!pliegoItems.length) return res.json(empty);

      const totalProyecto = pliegoItems.reduce(
        (acc, i) => acc + Number(i.costoParcial || 0),
        0
      );
      if (totalProyecto === 0) return res.json(empty);

      const costoItemMap = {};
      pliegoItems.forEach((i) => {
        costoItemMap[i.id] = Number(i.costoParcial || 0);
      });

      // 2) Planificaciones
      const planificaciones = await Planificacion.findAll({
        where: { obraId },
        order: [["fecha_desde", "ASC"]],
      });

      if (!planificaciones.length) {
        const anticipoMonto = (anticipoPorc / 100) * totalProyecto;
        return res.json({
          labels: ["Inicio"],
          planificado: [0],
          certificado: [0],
          avance: [0],
          certNumerosPorPeriodo: [[]],
          financiero: [Number(((anticipoMonto / totalProyecto) * 100).toFixed(2))],
          financieroMontos: [Number(anticipoMonto.toFixed(2))],
        });
      }

      // 2.1) Agrupar períodos únicos
      const periodosMap = {};
      const periodos = [];
      planificaciones.forEach((p) => {
        const key = `${String(p.fecha_desde).slice(0, 10)}__${String(p.fecha_hasta).slice(0, 10)}`;
        if (!periodosMap[key]) {
          periodosMap[key] = {
            fecha_desde: String(p.fecha_desde).slice(0, 10),
            fecha_hasta: String(p.fecha_hasta).slice(0, 10),
            planifIds: [],
          };
          periodos.push(periodosMap[key]);
        }
        periodosMap[key].planifIds.push(p.id);
      });

      // 3) Items de planificacion
      const planifIdsAll = planificaciones.map((p) => p.id);
      const planifItems = await PlanificacionItem.findAll({
        where: { planificacion_id: planifIdsAll },
        raw: true,
      });

      const planifItemsByPlanif = {};
      planifItems.forEach((pi) => {
        if (!planifItemsByPlanif[pi.planificacion_id]) planifItemsByPlanif[pi.planificacion_id] = [];
        planifItemsByPlanif[pi.planificacion_id].push(pi);
      });

      // 4) Certificaciones + items
      const certificaciones = await Certificacion.findAll({
        where: { obra_id: obraId },
        order: [["periodo_desde", "ASC"], ["id", "ASC"]],
        attributes: ["id", "numero_certificado", "total_neto", "periodo_desde", "periodo_hasta"],
        raw: true,
      });

      const certIds = certificaciones.map((c) => c.id);
      let certItemsByCert = {};
      if (certIds.length > 0) {
        const certItems = await CertificacionItem.findAll({
          where: { CertificacionId: certIds },
          raw: true,
        });
        certItems.forEach((ci) => {
          if (!certItemsByCert[ci.CertificacionId]) certItemsByCert[ci.CertificacionId] = [];
          certItemsByCert[ci.CertificacionId].push(ci);
        });
      }

      // 5) Avances + items (%)
      const avances = await AvanceObra.findAll({
        where: { obra_id: obraId },
        raw: true,
      });

      const avanceIds = avances.map((a) => a.id);
      let avanceItemsByAvance = {};
      if (avanceIds.length > 0) {
        const avanceItems = await AvanceObraItem.findAll({
          where: { avance_obra_id: avanceIds },
          raw: true,
        });

        avanceItems.forEach((ai) => {
          if (!avanceItemsByAvance[ai.avance_obra_id]) avanceItemsByAvance[ai.avance_obra_id] = [];
          avanceItemsByAvance[ai.avance_obra_id].push(ai);
        });
      }

      // Helpers
      const norm = (x) => (x ? String(x).slice(0, 10) : "");
      const toTime = (d) => {
        const t = new Date(d).getTime();
        return Number.isFinite(t) ? t : null;
      };
      const inRange = (d, desde, hasta) => {
        const td = toTime(d);
        const t1 = toTime(desde);
        const t2 = toTime(hasta);
        if (td == null || t1 == null || t2 == null) return false;
        return td >= t1 && td <= t2;
      };

      // ✅ PRE-CÁLCULO: porcentaje ponderado POR AVANCE (una sola vez)
      // Y lo mapeamos por clave de período exacto: "YYYY-MM-DD__YYYY-MM-DD"
      const avancePorPeriodoKey = {}; // keyPeriodo -> suma % (si hay varios avances en mismo período)
      const avancesSinPeriodo = []; // fallback

      avances.forEach((a) => {
        const itemsAv = avanceItemsByAvance[a.id] || [];

        // % ponderado del avance (idéntico criterio a certificaciones)
        let porcAvancePonderado = 0;
        itemsAv.forEach((i) => {
          const costo = costoItemMap[i.pliego_item_id] || 0;
          porcAvancePonderado +=
            (Number(i.avance_porcentaje || 0) / 100) *
            (costo / totalProyecto) *
            100;
        });

        porcAvancePonderado = Number(porcAvancePonderado.toFixed(2));

        const keyExacta = `${norm(a.periodo_desde)}__${norm(a.periodo_hasta)}`;

        // Si tiene período válido -> lo imputamos SOLO ahí
        if (norm(a.periodo_desde) && norm(a.periodo_hasta)) {
          avancePorPeriodoKey[keyExacta] = Number(
            ((avancePorPeriodoKey[keyExacta] || 0) + porcAvancePonderado).toFixed(2)
          );
        } else {
          // fallback: si algún avance viejo no tiene periodo, lo guardamos para imputarlo por fecha
          avancesSinPeriodo.push({ ...a, porc: porcAvancePonderado });
        }
      });

      // 6) Construcción curva (acumulados)
      let acumuladoPlan = 0;
      let acumuladoCert = 0;
      let acumuladoAvance = 0;

      const labels = [];
      const curvaPlan = [];
      const curvaCert = [];
      const curvaAvance = [];
      const certNumerosPorPeriodo = [];

      const curvaFinanciera = [];
      const curvaFinancieraMontos = [];

      // Inicio
      labels.push("Inicio");
      curvaPlan.push(0);
      curvaCert.push(0);
      curvaAvance.push(0);
      certNumerosPorPeriodo.push([]);

      const anticipoMonto = (anticipoPorc / 100) * totalProyecto;
      let montoFinAcum = anticipoMonto;

      curvaFinanciera.push(Number(((montoFinAcum / totalProyecto) * 100).toFixed(2)));
      curvaFinancieraMontos.push(Number(montoFinAcum.toFixed(2)));

      for (let idxPeriodo = 0; idxPeriodo < periodos.length; idxPeriodo++) {
        const { fecha_desde, fecha_hasta, planifIds } = periodos[idxPeriodo];
        const keyPeriodo = `${fecha_desde}__${fecha_hasta}`;

        labels.push(`${fecha_desde} → ${fecha_hasta}`);

        // 🔵 PLANIFICADO
        let planPeriodo = 0;
        planifIds.forEach((planifId) => {
          const itemsPlanif = planifItemsByPlanif[planifId] || [];
          itemsPlanif.forEach((i) => {
            const costo = costoItemMap[i.pliego_item_id] || 0;
            planPeriodo +=
              (Number(i.porcentaje_planificado) / 100) *
              (costo / totalProyecto) *
              100;
          });
        });
        acumuladoPlan += planPeriodo;

        // 🟢 CERTIFICADO (por índice como venías)
        let certPeriodoPorc = 0;
        const numerosCertPeriodo = [];

        const cert = certificaciones[idxPeriodo];
        if (cert) {
          const itemsCert = certItemsByCert[cert.id] || [];
          itemsCert.forEach((i) => {
            const costo = costoItemMap[i.PliegoItemId] || 0;
            certPeriodoPorc +=
              (Number(i.avance_porcentaje) / 100) *
              (costo / totalProyecto) *
              100;
          });

          if (cert.numero_certificado) numerosCertPeriodo.push(cert.numero_certificado);
          montoFinAcum += Number(cert.total_neto || 0);
        }
        acumuladoCert += certPeriodoPorc;

        // 🔴 AVANCE REAL
        // 1) imputación exacta por período (NO duplica nunca)
        let avancePeriodo = Number(avancePorPeriodoKey[keyPeriodo] || 0);

        // 2) fallback: avances sin período -> imputar por fecha_avance
        if (avancesSinPeriodo.length) {
          avancesSinPeriodo.forEach((a) => {
            if (inRange(a.fecha_avance, fecha_desde, fecha_hasta)) {
              avancePeriodo += Number(a.porc || 0);
            }
          });
        }

        avancePeriodo = Number(avancePeriodo.toFixed(2));
        acumuladoAvance += avancePeriodo;

        curvaPlan.push(Number(acumuladoPlan.toFixed(2)));
        curvaCert.push(Number(acumuladoCert.toFixed(2)));
        curvaAvance.push(Number(acumuladoAvance.toFixed(2)));
        certNumerosPorPeriodo.push(numerosCertPeriodo);

        // 🟡 FINANCIERO
        const financieroPorc = (montoFinAcum / totalProyecto) * 100;
        curvaFinanciera.push(Number(financieroPorc.toFixed(2)));
        curvaFinancieraMontos.push(Number(montoFinAcum.toFixed(2)));
      }

      return res.json({
        labels,
        planificado: curvaPlan,
        certificado: curvaCert,
        avance: curvaAvance,
        certNumerosPorPeriodo,
        financiero: curvaFinanciera,
        financieroMontos: curvaFinancieraMontos,
      });
    } catch (error) {
      console.error("Error curva-avance:", error);
      return res.status(500).json({ message: "Error al calcular curva de avance" });
    }
  }
);


/* ======================================================
   🏗️ AVANCE DE OBRA (GUARDA % + DEVUELVE % PONDERADO PERIODO)
====================================================== */
router.post(
  "/:obraId/avances",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();

    try {
      const { obraId } = req.params;
      const { numero_avance, fecha_avance, periodo_desde, periodo_hasta, items } = req.body;

      if (!numero_avance || !fecha_avance || !Array.isArray(items) || items.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: "Datos de avance incompletos" });
      }

      // Pliego para ponderación del período (como certificaciones)
      const pliegoItems = await PliegoItem.findAll({
        where: { obraId },
        attributes: ["id", "costoParcial"],
        raw: true,
        transaction: t,
      });

      const totalProyecto = pliegoItems.reduce((acc, i) => acc + Number(i.costoParcial || 0), 0);
      const costoMap = {};
      pliegoItems.forEach((p) => (costoMap[p.id] = Number(p.costoParcial || 0)));

      // ✅ Validar que ningún ítem supere el 100% de avance acumulado
      const avancesExistentes = await AvanceObra.findAll({
        where: { obra_id: obraId },
        attributes: ["id"],
        raw: true,
        transaction: t,
      });
      if (avancesExistentes.length > 0) {
        const avanceIds = avancesExistentes.map((a) => a.id);
        for (const item of items) {
          if (!item.avance_porcentaje || item.avance_porcentaje <= 0) continue;
          const totalPrevio = await AvanceObraItem.sum("avance_porcentaje", {
            where: { avance_obra_id: avanceIds, pliego_item_id: item.pliego_item_id },
            transaction: t,
          });
          const acumuladoPrevio = Number(totalPrevio || 0);
          if (acumuladoPrevio + Number(item.avance_porcentaje) > 100) {
            await t.rollback();
            return res.status(400).json({
              message: `El ítem ${item.pliego_item_id} supera el 100% de avance (acumulado ${acumuladoPrevio}%, nuevo ${item.avance_porcentaje}%).`,
            });
          }
        }
      }

      const avance = await AvanceObra.create(
        {
          obra_id: obraId,
          numero_avance,
          fecha_avance,
          periodo_desde: periodo_desde || null,
          periodo_hasta: periodo_hasta || null,
        },
        { transaction: t }
      );

      // ✅ guardar % por item
      const avanceItems = items.map((i) => ({
        avance_obra_id: avance.id,
        pliego_item_id: i.pliego_item_id,
        avance_porcentaje: Number(i.avance_porcentaje || 0),
      }));

      await AvanceObraItem.bulkCreate(avanceItems, { transaction: t });

      // ✅ calcular % ponderado del período (igual criterio que certificados)
      let ejecutado = 0;
      avanceItems.forEach((i) => {
        const costo = costoMap[i.pliego_item_id] || 0;
        const porc = Math.max(0, Math.min(100, Number(i.avance_porcentaje || 0)));
        ejecutado += (costo * porc) / 100;
      });

      const avancePeriodoPonderado = totalProyecto ? (ejecutado / totalProyecto) * 100 : 0;

      await t.commit();

      return res.status(201).json({
        message: "Avance de obra guardado correctamente",
        id: avance.id,
        avance_periodo_ponderado: Number(avancePeriodoPonderado.toFixed(2)),
        items_insertados: avanceItems.length,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error guardando avance de obra:", error);
      return res.status(500).json({ message: "Error al guardar avance de obra" });
    }
  }
);

/* ======================================================
   🏗️ AVANCE DE OBRA - ITEMS (PARA LA VISTA)
   OJO: este endpoint está pensado para importe/cantidad.
   Si querés, lo migramos a % también.
====================================================== */
router.get(
  "/:obraId/avance-items",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const items = await PliegoItem.findAll({
        where: { obraId },
        order: [["numeroItem", "ASC"]],
        include: [
          {
            model: AvanceObraItem,
            as: "avances",
            required: false,
          },
        ],
      });

      const resultado = items.map((item) => {
        const importeTotal = Number(item.costoParcial || 0);

        // Si migrás a % puro, esto se debe reescribir
        const importeAvanzado = item.avances.reduce(
          (sum, a) => sum + Number(a.importe || 0),
          0
        );

        const avance =
          importeTotal > 0 ? Number(((importeAvanzado / importeTotal) * 100).toFixed(2)) : 0;

        return {
          pliego_item_id: item.id,
          numeroItem: item.numeroItem,
          descripcion: item.descripcionItem,
          unidadMedida: item.unidadMedida,
          importe_total: importeTotal,
          importe_avanzado: importeAvanzado,
          avance,
        };
      });

      return res.json(resultado);
    } catch (error) {
      console.error("Error obteniendo avance-items:", error);
      return res.status(500).json({ message: "Error al obtener avance de obra por ítems" });
    }
  }
);

/* ======================================================
   items-disponible-planificacion
====================================================== */
router.get(
  "/:obraId/items-disponible-planificacion",
  authMiddleware,
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const items = await PliegoItem.findAll({
        where: { obraId },
        include: [
          {
            model: PlanificacionItem,
            as: "planificaciones",
            attributes: ["porcentaje_planificado"],
            include: [
              {
                model: Planificacion,
                as: "planificacion",
                attributes: [],
                where: { obraId },
              },
            ],
          },
        ],
      });

      const itemsDisponibles = items
        .map((item) => {
          const totalPlanificado = item.planificaciones.reduce(
            (sum, p) => sum + Number(p.porcentaje_planificado),
            0
          );

          return { ...item.toJSON(), porcentajeDisponible: 100 - totalPlanificado };
        })
        .filter((item) => item.porcentajeDisponible > 0);

      return res.json(itemsDisponibles);
    } catch (error) {
      console.error("Error items disponibles planificación:", error);
      return res.status(500).json({ error: "Error al cargar items disponibles para planificar" });
    }
  }
);

/* ======================================================
   CERTIFICACIONES (sin cambios)
====================================================== */
router.get(
  "/:obraId/certificaciones",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const pliegoItems = await PliegoItem.findAll({
        where: { obraId },
        attributes: ["id", "costoParcial"],
        raw: true,
      });
      if (!pliegoItems.length) return res.json([]);

      const totalProyecto = pliegoItems.reduce((acc, i) => acc + Number(i.costoParcial || 0), 0);
      if (totalProyecto === 0) return res.json([]);

      const costoItemMap = {};
      pliegoItems.forEach((i) => (costoItemMap[i.id] = Number(i.costoParcial || 0)));

      const certificaciones = await Certificacion.findAll({
        where: { obra_id: obraId },
        order: [["fecha_certificacion", "ASC"], ["id", "ASC"]],
        raw: true,
      });
      if (!certificaciones.length) return res.json([]);

      const certIds = certificaciones.map((c) => c.id);
      const certItems = await CertificacionItem.findAll({
        where: { CertificacionId: certIds },
        raw: true,
      });

      const itemsByCert = {};
      certItems.forEach((ci) => {
        if (!itemsByCert[ci.CertificacionId]) itemsByCert[ci.CertificacionId] = [];
        itemsByCert[ci.CertificacionId].push(ci);
      });

      let acumulado = 0;

      const resultado = certificaciones.map((c) => {
        const items = itemsByCert[c.id] || [];
        let avanceMensual = 0;

        items.forEach((i) => {
          const costo = costoItemMap[i.PliegoItemId] || 0;
          avanceMensual += (Number(i.avance_porcentaje) / 100) * (costo / totalProyecto) * 100;
        });

        acumulado += avanceMensual;

        return {
          id: c.id,
          numero_certificado: c.numero_certificado,
          periodo_desde: c.periodo_desde,
          periodo_hasta: c.periodo_hasta,
          fecha_certificacion: c.fecha_certificacion,
          avance_mensual: Number(avanceMensual.toFixed(2)),
          avance_acumulado: Number(acumulado.toFixed(2)),
        };
      });

      return res.json(resultado);
    } catch (error) {
      console.error("Error listando certificaciones:", error);
      return res.status(500).json({
        ok: false,
        message: "Error al obtener las certificaciones de la obra",
      });
    }
  }
);

router.get(
  "/:obraId/items-certificados",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;

      const pliegoItems = await PliegoItem.findAll({
        where: { obraId },
        attributes: ["id", "numeroItem", "descripcionItem", "unidadMedida"],
        order: [[sequelize.cast(col("numeroItem"), "UNSIGNED"), "ASC"]],
        raw: true,
      });
      if (!pliegoItems.length) return res.json([]);

      const certificaciones = await Certificacion.findAll({
        where: { obra_id: obraId },
        attributes: ["id"],
        raw: true,
      });

      const certIds = certificaciones.map((c) => c.id);

      let certItems = [];
      if (certIds.length > 0) {
        certItems = await CertificacionItem.findAll({
          where: { CertificacionId: certIds },
          attributes: ["PliegoItemId", "avance_porcentaje"],
          raw: true,
        });
      }

      const accMap = {};
      certItems.forEach((ci) => {
        const pid = ci.PliegoItemId;
        if (!pid) return;
        accMap[pid] = (accMap[pid] || 0) + Number(ci.avance_porcentaje || 0);
      });

      const result = pliegoItems.map((p) => ({
        pliego_item_id: p.id,
        numeroItem: p.numeroItem || null,
        descripcion: p.descripcionItem || "",
        unidad: p.unidadMedida || "",
        avance_acumulado: Math.min(100, Number((accMap[p.id] || 0).toFixed(2))),
      }));

      return res.json(result);
    } catch (error) {
      console.error("Error /:obraId/items-certificados:", error);
      return res.status(500).json({ error: "Error al calcular avance certificado por ítem" });
    }
  }
);

/* ======================================================
   📋 LISTAR PLANIFICACIONES DE UNA OBRA
====================================================== */
router.get("/:obraId/planificaciones", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { obraId } = req.params;
    const planificaciones = await Planificacion.findAll({
      where: { obraId },
      order: [["fecha_desde", "ASC"]],
    });
    const planifIds = planificaciones.map((p) => p.id);
    const todosItems = planifIds.length
      ? await PlanificacionItem.findAll({ where: { planificacion_id: planifIds }, raw: true })
      : [];
    const itemsByPlanif = {};
    todosItems.forEach((i) => {
      if (!itemsByPlanif[i.planificacion_id]) itemsByPlanif[i.planificacion_id] = [];
      itemsByPlanif[i.planificacion_id].push(i);
    });
    const result = planificaciones.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      fecha_desde: p.fecha_desde,
      fecha_hasta: p.fecha_hasta,
      estado: p.estado,
      total_porcentaje: (itemsByPlanif[p.id] || []).reduce((s, i) => s + Number(i.porcentaje_planificado || 0), 0),
    }));
    return res.json(result);
  } catch (error) {
    console.error("Error listando planificaciones:", error);
    return res.status(500).json({ message: "Error al listar planificaciones" });
  }
});

/* ======================================================
   📋 DETALLE DE UNA PLANIFICACIÓN (con ítems)
====================================================== */
router.get("/:obraId/planificaciones/:planifId", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { planifId } = req.params;
    const planif = await Planificacion.findByPk(planifId);
    if (!planif) return res.status(404).json({ message: "Planificación no encontrada" });
    const items = await PlanificacionItem.findAll({
      where: { planificacion_id: planifId },
      include: [{ model: PliegoItem, as: "pliegoItem", attributes: ["numeroItem", "descripcionItem", "unidadMedida", "cantidad", "costoParcial"] }],
    });
    return res.json({ ...planif.toJSON(), items });
  } catch (error) {
    console.error("Error detalle planificacion:", error);
    return res.status(500).json({ message: "Error al obtener planificación" });
  }
});

/* ======================================================
   ✏️ EDITAR PLANIFICACIÓN
====================================================== */
router.put("/:obraId/planificacion/:planifId", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR]), async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, planifId } = req.params;
    const { fecha_desde, fecha_hasta, items } = req.body;
    if (!fecha_desde || !fecha_hasta || !Array.isArray(items) || !items.length) {
      await t.rollback();
      return res.status(400).json({ message: "Datos incompletos para la planificación" });
    }
    const planif = await Planificacion.findByPk(planifId, { transaction: t });
    if (!planif) { await t.rollback(); return res.status(404).json({ message: "Planificación no encontrada" }); }
    const solapada = await Planificacion.findOne({
      where: { obraId, id: { [Op.ne]: planifId }, [Op.or]: [
        { fecha_desde: { [Op.between]: [fecha_desde, fecha_hasta] } },
        { fecha_hasta: { [Op.between]: [fecha_desde, fecha_hasta] } },
        { [Op.and]: [{ fecha_desde: { [Op.lte]: fecha_desde } }, { fecha_hasta: { [Op.gte]: fecha_hasta } }] },
      ]},
    });
    if (solapada) { await t.rollback(); return res.status(400).json({ message: "Ya existe una planificación en ese período" }); }
    await planif.update({ fecha_desde, fecha_hasta, nombre: `Planificación ${fecha_desde} → ${fecha_hasta}` }, { transaction: t });
    await PlanificacionItem.destroy({ where: { planificacion_id: planifId }, transaction: t });
    for (const item of items) {
      await PlanificacionItem.create({ planificacion_id: planifId, pliego_item_id: item.pliego_item_id, porcentaje_planificado: item.porcentaje_planificado || 0 }, { transaction: t });
    }
    await t.commit();
    return res.json({ ok: true, message: "Planificación actualizada" });
  } catch (error) {
    await t.rollback();
    console.error("Error editando planificacion:", error);
    return res.status(500).json({ message: error.message || "Error al editar planificación" });
  }
});

/* ======================================================
   📋 LISTAR AVANCES DE UNA OBRA
====================================================== */
router.get("/:obraId/avances", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { obraId } = req.params;
    const pliegoItems = await PliegoItem.findAll({ where: { obraId }, attributes: ["id", "costoParcial"], raw: true });
    const totalProyecto = pliegoItems.reduce((acc, i) => acc + Number(i.costoParcial || 0), 0);
    const costoMap = {};
    pliegoItems.forEach((i) => (costoMap[i.id] = Number(i.costoParcial || 0)));
    const avances = await AvanceObra.findAll({ where: { obra_id: obraId }, order: [["numero_avance", "ASC"]] });
    const avanceIds = avances.map((a) => a.id);
    const todosItems = avanceIds.length ? await AvanceObraItem.findAll({ where: { avance_obra_id: avanceIds }, raw: true }) : [];
    const itemsByAvance = {};
    todosItems.forEach((i) => {
      if (!itemsByAvance[i.avance_obra_id]) itemsByAvance[i.avance_obra_id] = [];
      itemsByAvance[i.avance_obra_id].push(i);
    });
    const result = avances.map((a) => {
      const its = itemsByAvance[a.id] || [];
      let ejecutado = 0;
      its.forEach((i) => { ejecutado += ((costoMap[i.pliego_item_id] || 0) * Number(i.avance_porcentaje || 0)) / 100; });
      const ponderado = totalProyecto ? Number(((ejecutado / totalProyecto) * 100).toFixed(2)) : 0;
      return { id: a.id, numero_avance: a.numero_avance, fecha_avance: a.fecha_avance, periodo_desde: a.periodo_desde, periodo_hasta: a.periodo_hasta, avance_ponderado: ponderado };
    });
    return res.json(result);
  } catch (error) {
    console.error("Error listando avances:", error);
    return res.status(500).json({ message: "Error al listar avances" });
  }
});

/* ======================================================
   📋 DETALLE DE UN AVANCE (con ítems)
====================================================== */
router.get("/:obraId/avances/:avanceId", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { avanceId } = req.params;
    const avance = await AvanceObra.findByPk(avanceId);
    if (!avance) return res.status(404).json({ message: "Avance no encontrado" });
    const items = await AvanceObraItem.findAll({
      where: { avance_obra_id: avanceId },
      include: [{ model: PliegoItem, as: "pliegoItem", attributes: ["numeroItem", "descripcionItem", "unidadMedida", "cantidad", "costoParcial"] }],
    });
    return res.json({ ...avance.toJSON(), items });
  } catch (error) {
    console.error("Error detalle avance:", error);
    return res.status(500).json({ message: "Error al obtener avance" });
  }
});

/* ======================================================
   ✏️ EDITAR AVANCE DE OBRA
====================================================== */
router.put("/:obraId/avances/:avanceId", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR]), async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, avanceId } = req.params;
    const { numero_avance, fecha_avance, periodo_desde, periodo_hasta, items } = req.body;
    if (!numero_avance || !fecha_avance || !Array.isArray(items) || !items.length) {
      await t.rollback();
      return res.status(400).json({ message: "Datos de avance incompletos" });
    }
    const avance = await AvanceObra.findByPk(avanceId, { transaction: t });
    if (!avance) { await t.rollback(); return res.status(404).json({ message: "Avance no encontrado" }); }
    // Validar 100% excluyendo el avance actual
    const otrosAvances = await AvanceObra.findAll({ where: { obra_id: obraId, id: { [Op.ne]: avanceId } }, attributes: ["id"], raw: true, transaction: t });
    if (otrosAvances.length > 0) {
      const otrosIds = otrosAvances.map((a) => a.id);
      for (const item of items) {
        if (!item.avance_porcentaje || item.avance_porcentaje <= 0) continue;
        const totalPrevio = await AvanceObraItem.sum("avance_porcentaje", { where: { avance_obra_id: otrosIds, pliego_item_id: item.pliego_item_id }, transaction: t });
        const acumuladoPrevio = Number(totalPrevio || 0);
        if (acumuladoPrevio + Number(item.avance_porcentaje) > 100) {
          await t.rollback();
          return res.status(400).json({ message: `El ítem ${item.pliego_item_id} supera el 100% (acumulado ${acumuladoPrevio}%, nuevo ${item.avance_porcentaje}%).` });
        }
      }
    }
    await avance.update({ numero_avance, fecha_avance, periodo_desde: periodo_desde || null, periodo_hasta: periodo_hasta || null }, { transaction: t });
    await AvanceObraItem.destroy({ where: { avance_obra_id: avanceId }, transaction: t });
    const nuevosItems = items.map((i) => ({ avance_obra_id: Number(avanceId), pliego_item_id: i.pliego_item_id, avance_porcentaje: Number(i.avance_porcentaje || 0) }));
    await AvanceObraItem.bulkCreate(nuevosItems, { transaction: t });
    await t.commit();
    return res.json({ ok: true, message: "Avance actualizado correctamente" });
  } catch (error) {
    await t.rollback();
    console.error("Error editando avance:", error);
    return res.status(500).json({ message: "Error al editar avance" });
  }
});

/* ======================================================
   📋 ÍTEMS DISPONIBLES PARA CERTIFICAR (< 100%)
====================================================== */
router.get("/:obraId/items-disponibles-certificacion", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { obraId } = req.params;
    const pliegoItems = await PliegoItem.findAll({ where: { obraId }, raw: true });
    const certs = await Certificacion.findAll({ where: { obra_id: obraId }, attributes: ["id"], raw: true });
    const accMap = {};
    if (certs.length > 0) {
      const certIds = certs.map((c) => c.id);
      const certItems = await CertificacionItem.findAll({ where: { CertificacionId: certIds }, raw: true });
      certItems.forEach((ci) => { accMap[ci.PliegoItemId] = (accMap[ci.PliegoItemId] || 0) + Number(ci.avance_porcentaje || 0); });
    }
    const result = pliegoItems
      .map((p) => ({ ...p, porcentajeDisponible: Math.max(0, Number((100 - (accMap[p.id] || 0)).toFixed(2))) }))
      .filter((p) => p.porcentajeDisponible > 0);
    return res.json(result);
  } catch (error) {
    console.error("Error items-disponibles-certificacion:", error);
    return res.status(500).json({ message: "Error al obtener ítems disponibles para certificar" });
  }
});

/* ======================================================
   📋 ÍTEMS DISPONIBLES PARA AVANCE (< 100%)
====================================================== */
router.get("/:obraId/items-disponibles-avance", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
  try {
    const { obraId } = req.params;
    const pliegoItems = await PliegoItem.findAll({ where: { obraId }, raw: true });
    const avances = await AvanceObra.findAll({ where: { obra_id: obraId }, attributes: ["id"], raw: true });
    const accMap = {};
    if (avances.length > 0) {
      const avanceIds = avances.map((a) => a.id);
      const avanceItems = await AvanceObraItem.findAll({ where: { avance_obra_id: avanceIds }, raw: true });
      avanceItems.forEach((ai) => { accMap[ai.pliego_item_id] = (accMap[ai.pliego_item_id] || 0) + Number(ai.avance_porcentaje || 0); });
    }
    const result = pliegoItems
      .map((p) => ({ ...p, porcentajeDisponible: Math.max(0, Number((100 - (accMap[p.id] || 0)).toFixed(2))) }))
      .filter((p) => p.porcentajeDisponible > 0);
    return res.json(result);
  } catch (error) {
    console.error("Error items-disponibles-avance:", error);
    return res.status(500).json({ message: "Error al obtener ítems disponibles para avance" });
  }
});

export default router;
