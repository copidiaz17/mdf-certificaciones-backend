// Informes de avance de obra.
//
// El jefe de obra elige un rango de fechas y el sistema arma el informe con
// todo lo que se ejecutó en ese período: ítem por ítem, con la cantidad en su
// unidad, el porcentaje del período y el acumulado a esa fecha.
//
// El informe queda GUARDADO con sus números congelados. Ver models/
// InformeAvance.js para por qué.

import express from "express";
import { Op } from "sequelize";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";
import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";
import InformeAvance from "../models/InformeAvance.js";
import Usuario from "../models/Usuario.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
const r5 = (v) => Math.round((n(v) + Number.EPSILON) * 100000) / 100000;

const ES_FECHA = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/**
 * Arma el informe. No guarda nada: lo usan la previsualización y el alta, y
 * tienen que dar exactamente lo mismo — si la vista previa dijera una cosa y
 * lo guardado otra, el informe no sirve para nada.
 *
 * Un avance entra al período por su FECHA: la del avance si la tiene, y si no
 * el fin de su período. Un avance se reconoce cuando cierra.
 */
async function armarInforme(obraId, desde, hasta) {
  const obra = await Obra.findByPk(obraId);
  if (!obra) throw { status: 404, message: "Obra no encontrada" };

  const pliego = await PliegoItem.findAll({ where: { obraId }, raw: true });
  if (pliego.length === 0) {
    throw { status: 400, message: "La obra no tiene pliego cargado: no hay contra qué medir el avance." };
  }
  const porId = new Map(pliego.map((p) => [p.id, p]));
  const totalProyecto = pliego.reduce((s, p) => s + n(p.costoParcial), 0);

  // Todos los avances de la obra, para separar los del período de los previos.
  const avances = await AvanceObra.findAll({
    where: { obra_id: obraId },
    order: [["fecha_avance", "ASC"], ["numero_avance", "ASC"]],
    raw: true,
  });

  const fechaDe = (a) => String(a.fecha_avance || a.periodo_hasta || "").slice(0, 10);

  const delPeriodo = avances.filter((a) => {
    const f = fechaDe(a);
    return f && f >= desde && f <= hasta;
  });
  // "Previos" es todo lo anterior al inicio del rango: sirve para saber de
  // dónde venía cada ítem, que es lo que convierte una cifra en una lectura.
  const previos = avances.filter((a) => {
    const f = fechaDe(a);
    return f && f < desde;
  });

  const idsPeriodo = delPeriodo.map((a) => a.id);
  const idsPrevios = previos.map((a) => a.id);

  const traerItems = async (ids) =>
    ids.length ? AvanceObraItem.findAll({ where: { avance_obra_id: ids }, raw: true }) : [];

  const itemsPeriodo = await traerItems(idsPeriodo);
  const itemsPrevios = await traerItems(idsPrevios);

  const sumarPorItem = (filas) => {
    const m = new Map();
    for (const f of filas) {
      const k = Number(f.pliego_item_id);
      const a = m.get(k) || { porcentaje: 0, cantidad: 0 };
      a.porcentaje += n(f.avance_porcentaje);
      a.cantidad += n(f.cantidad_ejecutada);
      m.set(k, a);
    }
    return m;
  };

  const enPeriodo = sumarPorItem(itemsPeriodo);
  const antes = sumarPorItem(itemsPrevios);

  const items = [];
  let ejecutadoPeriodo = 0;
  let ejecutadoAcumulado = 0;

  for (const p of pliego) {
    const per = enPeriodo.get(p.id) || { porcentaje: 0, cantidad: 0 };
    const pre = antes.get(p.id) || { porcentaje: 0, cantidad: 0 };

    const acumPct = pre.porcentaje + per.porcentaje;
    const acumCant = pre.cantidad + per.cantidad;
    const cantPliego = n(p.cantidad);

    const costo = n(p.costoParcial);
    ejecutadoPeriodo += (costo * per.porcentaje) / 100;
    // Para el acumulado, el ponderado se topa al 100%: lo ejecutado de más no
    // vale más plata hasta que se reconozca. El excedente se informa aparte.
    ejecutadoAcumulado += (costo * Math.min(100, acumPct)) / 100;

    // Solo van al detalle los ítems que se tocaron alguna vez. Un pliego de
    // 85 ítems con 3 movidos hace un informe de 85 renglones vacíos.
    if (per.porcentaje === 0 && pre.porcentaje === 0) continue;

    items.push({
      pliego_item_id: p.id,
      numero: p.numeroItem,
      descripcion: p.descripcionItem,
      unidad: p.unidadMedida || "",
      origen: p.origen || "original",
      cantidad_pliego: r5(cantPliego),
      // Lo del período, que es de lo que habla el informe.
      cantidad_periodo: r5(per.cantidad),
      porcentaje_periodo: r2(per.porcentaje),
      // Y de dónde venía y adónde llegó.
      porcentaje_previo: r2(pre.porcentaje),
      porcentaje_acumulado: r2(acumPct),
      cantidad_acumulada: r5(acumCant),
      // Lo ejecutado por encima del pliego, en la unidad del ítem.
      excedente: cantPliego > 0 ? r5(Math.max(0, acumCant - cantPliego)) : 0,
    });
  }

  const pond = (x) => (totalProyecto ? r2((x / totalProyecto) * 100) : 0);

  return {
    obra: {
      id: obra.id,
      nombre: obra.nombre,
      ubicacion: obra.ubicacion || "",
      reparticion: obra.reparticion || null,
    },
    periodo: { desde, hasta },
    items,
    totales: {
      items_del_pliego: pliego.length,
      items_con_movimiento: items.length,
      precio_contrato: r2(totalProyecto),
      ejecutado_periodo_importe: r2(ejecutadoPeriodo),
      ejecutado_acumulado_importe: r2(ejecutadoAcumulado),
      avance_periodo_porcentaje: pond(ejecutadoPeriodo),
      avance_acumulado_porcentaje: pond(ejecutadoAcumulado),
      items_con_excedente: items.filter((i) => i.excedente > 0).length,
    },
    // Qué avances entraron: es lo que permite reconstruir de dónde salió cada
    // número si alguien lo discute.
    avances_incluidos: delPeriodo.map((a) => ({
      id: a.id,
      numero_avance: a.numero_avance,
      fecha_avance: a.fecha_avance,
      periodo_desde: a.periodo_desde,
      periodo_hasta: a.periodo_hasta,
    })),
    nota:
      "El avance del período se mide sobre el precio de contrato. Lo ejecutado " +
      "por encima del pliego se informa como excedente y no suma al porcentaje: " +
      "no vale más hasta que el comitente lo reconozca.",
  };
}

function validarRango(req) {
  const { fecha_desde, fecha_hasta } = req.body || {};
  if (!ES_FECHA(fecha_desde) || !ES_FECHA(fecha_hasta)) {
    throw { status: 400, message: "Hacen falta la fecha desde y la fecha hasta (AAAA-MM-DD)." };
  }
  if (fecha_desde > fecha_hasta) {
    throw { status: 400, message: "La fecha desde no puede ser posterior a la fecha hasta." };
  }
  return { desde: fecha_desde, hasta: fecha_hasta };
}

/* ==========================================================
   VISTA PREVIA — no guarda nada
   POST /api/obras/:obraId/informes-avance/previsualizar
   ========================================================== */
router.post(
  "/:obraId/informes-avance/previsualizar",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { desde, hasta } = validarRango(req);
      const informe = await armarInforme(req.params.obraId, desde, hasta);
      return res.json({ ok: true, informe });
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ ok: false, error: e.message });
      console.error("Error previsualizando el informe:", e);
      return res.status(500).json({ ok: false, error: "Error al armar el informe" });
    }
  }
);

/* ==========================================================
   GENERAR Y GUARDAR
   POST /api/obras/:obraId/informes-avance
   ========================================================== */
router.post(
  "/:obraId/informes-avance",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { desde, hasta } = validarRango(req);
      const { titulo, observaciones, fecha_informe } = req.body || {};

      const informe = await armarInforme(req.params.obraId, desde, hasta);

      const guardado = await InformeAvance.create(
        {
          obra_id: Number(req.params.obraId),
          fecha_desde: desde,
          fecha_hasta: hasta,
          fecha_informe: ES_FECHA(fecha_informe)
            ? fecha_informe
            : new Date().toISOString().slice(0, 10),
          titulo: (titulo || "").trim() || null,
          observaciones: (observaciones || "").trim() || null,
          datos: JSON.stringify(informe),
          creado_por_id: req.user?.id || null,
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({
        ok: true,
        id: guardado.id,
        message:
          informe.items.length === 0
            ? "Informe guardado, pero no hubo avances cargados en ese período."
            : `Informe guardado: ${informe.items.length} ítem(s) con movimiento.`,
        informe,
      });
    } catch (e) {
      await t.rollback();
      if (e?.status) return res.status(e.status).json({ ok: false, error: e.message });
      console.error("Error guardando el informe:", e);
      return res.status(500).json({ ok: false, error: "Error al guardar el informe" });
    }
  }
);

/* ==========================================================
   LISTAR LOS INFORMES DE UNA OBRA
   GET /api/obras/:obraId/informes-avance
   ========================================================== */
router.get(
  "/:obraId/informes-avance",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const informes = await InformeAvance.findAll({
        where: { obra_id: req.params.obraId },
        // Los datos NO se traen en el listado: son varios kB por informe y en
        // la lista no se muestran.
        attributes: [
          "id", "fecha_desde", "fecha_hasta", "fecha_informe",
          "titulo", "observaciones", "createdAt",
        ],
        include: [{ model: Usuario, as: "autor", attributes: ["id", "nombre"] }],
        order: [["fecha_hasta", "DESC"], ["id", "DESC"]],
      });
      return res.json(informes);
    } catch (e) {
      console.error("Error listando informes:", e);
      return res.status(500).json({ message: "Error al listar los informes" });
    }
  }
);

/* ==========================================================
   VER UN INFORME GUARDADO
   GET /api/obras/:obraId/informes-avance/:informeId
   ========================================================== */
router.get(
  "/:obraId/informes-avance/:informeId",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const informe = await InformeAvance.findOne({
        where: { id: req.params.informeId, obra_id: req.params.obraId },
        include: [{ model: Usuario, as: "autor", attributes: ["id", "nombre"] }],
      });
      if (!informe) return res.status(404).json({ message: "Informe no encontrado" });

      let datos = null;
      try {
        datos = JSON.parse(informe.datos);
      } catch {
        // Un informe ilegible es un problema, pero devolver 500 esconde el
        // resto —fechas, observaciones, autor— que sí sirve.
        return res.status(200).json({
          id: informe.id,
          fecha_desde: informe.fecha_desde,
          fecha_hasta: informe.fecha_hasta,
          fecha_informe: informe.fecha_informe,
          titulo: informe.titulo,
          observaciones: informe.observaciones,
          autor: informe.autor,
          datos: null,
          error: "Los datos guardados de este informe no se pudieron leer.",
        });
      }

      return res.json({
        id: informe.id,
        fecha_desde: informe.fecha_desde,
        fecha_hasta: informe.fecha_hasta,
        fecha_informe: informe.fecha_informe,
        titulo: informe.titulo,
        observaciones: informe.observaciones,
        autor: informe.autor,
        creado_en: informe.createdAt,
        datos,
      });
    } catch (e) {
      console.error("Error obteniendo el informe:", e);
      return res.status(500).json({ message: "Error al obtener el informe" });
    }
  }
);

/* ==========================================================
   BORRAR UN INFORME
   DELETE /api/obras/:obraId/informes-avance/:informeId

   Solo administrador. Un informe no es un registro contable —es un documento
   que alguien produjo— pero borrarlo se lleva la foto que ya no se puede
   reconstruir, así que no lo hace cualquiera.
   ========================================================== */
router.delete(
  "/:obraId/informes-avance/:informeId",
  authMiddleware,
  hasRole([ROLES.ADMIN]),
  async (req, res) => {
    try {
      const informe = await InformeAvance.findOne({
        where: { id: req.params.informeId, obra_id: req.params.obraId },
      });
      if (!informe) return res.status(404).json({ message: "Informe no encontrado" });
      await informe.destroy();
      return res.json({ ok: true, message: "Informe eliminado." });
    } catch (e) {
      console.error("Error borrando el informe:", e);
      return res.status(500).json({ message: "Error al borrar el informe" });
    }
  }
);

export default router;
