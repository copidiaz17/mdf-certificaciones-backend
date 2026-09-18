// routes/subcontratos.js
//
// CIRCUITO DEL SUBCONTRATISTA — aparte del de la obra.
//
//   GET    /obras/:obraId/subcontratos                         lista con estadísticas
//   GET    /obras/:obraId/subcontratos-pliego                  pliego para armar la OC
//   POST   /obras/:obraId/subcontratos                         crea la OC con sus ítems
//   GET    /obras/:obraId/subcontratos/:subId                  detalle + estadísticas + curva
//   PUT    /obras/:obraId/subcontratos/:subId                  edita la OC y sus ítems
//   DELETE /obras/:obraId/subcontratos/:subId                  borra (si no tiene certificados)
//   GET    /obras/:obraId/subcontratos/:subId/plan             plan de trabajo por período
//   PUT    /obras/:obraId/subcontratos/:subId/plan             reemplaza el plan
//   GET    /obras/:obraId/subcontratos/:subId/certificados/nuevo       planilla en blanco
//   GET    /obras/:obraId/subcontratos/:subId/certificados/:certId     planilla de un certificado
//   POST   /obras/:obraId/subcontratos/:subId/certificados             certifica un período
//   PUT    /obras/:obraId/subcontratos/:subId/certificados/:certId     corrige el ÚLTIMO
//   POST   /obras/:obraId/subcontratos/:subId/certificados/:certId/anular  anula el ÚLTIMO
//
// Antes el pago al sub salía del avance de obra de la empresa, con un único
// precio "por el ítem terminado". Ahora tiene orden de compra propia, plan
// propio y certificados propios, como en la planilla de Excel que se usa hoy.
import express from "express";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";
import Subcontrato from "../models/Subcontrato.js";
import SubcontratoItem from "../models/SubcontratoItem.js";
import { SubcontratoPlanPeriodo, SubcontratoPlanItem } from "../models/SubcontratoPlan.js";
import {
  SubcontratoCertificado, SubcontratoCertificadoItem, SubcontratoDescuento,
} from "../models/SubcontratoCertificado.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";
import {
  planillaDe, resumenSubcontrato, totalContrato, generarPeriodos, sugerirPeriodo,
  esFecha, norm, r2, r4,
} from "../utils/subcontratos.js";

const router = express.Router();

const LEER = hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
const ESCRIBIR = hasRole([ROLES.ADMIN, ROLES.OPERATOR]);

const ESTADOS = ["vigente", "finalizado", "anulado"];
const PERIODICIDADES = ["quincenal", "semanal"];
const TIPOS_DESCUENTO = ["adelanto", "herramientas", "otro"];
const TOLERANCIA = 0.0001;

const hoyISO = () => {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
};

const agrupar = (filas, clave) => {
  const out = {};
  for (const f of filas) (out[f[clave]] ||= []).push(f);
  return out;
};

const porOrden = (a, b) =>
  (a.origen === b.origen ? 0 : a.origen === "adicional" ? 1 : -1)
  || (a.orden - b.orden)
  || String(a.numero || "").localeCompare(String(b.numero || ""), "es", { numeric: true })
  || (a.id - b.id);

/** Todo lo de un subcontrato, en filas planas. */
async function cargar(obraId, subId, t) {
  const sub = await Subcontrato.findOne({
    where: { id: subId, obra_id: obraId }, transaction: t, ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!sub) return null;

  const items = (await SubcontratoItem.findAll({ where: { subcontrato_id: sub.id }, raw: true, transaction: t })).sort(porOrden);
  const todos = await SubcontratoCertificado.findAll({
    where: { subcontrato_id: sub.id }, order: [["numero", "ASC"]], raw: true, transaction: t,
  });
  const vigentes = todos.filter((c) => !c.anulado);
  const certIds = todos.map((c) => c.id);
  const certItems = certIds.length
    ? await SubcontratoCertificadoItem.findAll({ where: { certificado_id: certIds }, raw: true, transaction: t })
    : [];
  const descuentos = certIds.length
    ? await SubcontratoDescuento.findAll({ where: { certificado_id: certIds }, raw: true, transaction: t })
    : [];
  const planPeriodos = await SubcontratoPlanPeriodo.findAll({
    where: { subcontrato_id: sub.id }, order: [["numero", "ASC"]], raw: true, transaction: t,
  });
  const planItems = planPeriodos.length
    ? await SubcontratoPlanItem.findAll({ where: { plan_periodo_id: planPeriodos.map((p) => p.id) }, raw: true, transaction: t })
    : [];

  return {
    sub,
    items,
    todos,
    vigentes,
    certItemsPorCert: agrupar(certItems, "certificado_id"),
    descuentosPorCert: agrupar(descuentos, "certificado_id"),
    planPeriodos,
    planItemsPorPeriodo: agrupar(planItems, "plan_periodo_id"),
  };
}

function resumenDe(d) {
  return resumenSubcontrato({
    items: d.items,
    certificados: d.vigentes,
    certItemsPorCert: d.certItemsPorCert,
    descuentos: d.vigentes.flatMap((c) => d.descuentosPorCert[c.id] || []),
    planPeriodos: d.planPeriodos,
    planItemsPorPeriodo: d.planItemsPorPeriodo,
    hoy: hoyISO(),
  });
}

function datosCabecera(s) {
  return {
    id: s.id, obra_id: s.obra_id, subcontratista: s.subcontratista, cuit: s.cuit,
    numero_oc: s.numero_oc, fecha_contrato: s.fecha_contrato, fecha_inicio: s.fecha_inicio,
    periodicidad: s.periodicidad, estado: s.estado, observaciones: s.observaciones,
  };
}

const itemsPlanos = (items) => items.map((it) => ({
  ...it, cantidad: Number(it.cantidad), precio_unitario: Number(it.precio_unitario),
}));

/**
 * Valida la cabecera y los ítems de una OC. Devuelve { error } o los datos listos.
 * Los ítems del pliego se validan contra ESTA obra; los que no son del pliego
 * necesitan descripción.
 */
async function validarOC({ obraId, body, t }) {
  const subcontratista = String(body.subcontratista || "").trim();
  if (!subcontratista) return { error: "Falta el nombre del subcontratista." };
  const periodicidad = body.periodicidad || "quincenal";
  if (!PERIODICIDADES.includes(periodicidad)) return { error: "La periodicidad tiene que ser quincenal o semanal." };
  if (body.fecha_contrato && !esFecha(norm(body.fecha_contrato))) return { error: "La fecha de contrato no es válida." };
  if (body.fecha_inicio && !esFecha(norm(body.fecha_inicio))) return { error: "La fecha de inicio no es válida." };
  if (body.estado && !ESTADOS.includes(body.estado)) return { error: "Estado inválido." };

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { error: "La orden de compra tiene que tener al menos un ítem." };

  const pliego = await PliegoItem.findAll({ where: { obraId }, raw: true, transaction: t });
  const pliegoPorId = new Map(pliego.map((p) => [p.id, p]));
  const vistos = new Set();
  const limpios = [];

  for (const [i, it] of items.entries()) {
    const pliegoId = it.pliego_item_id ? Number(it.pliego_item_id) : null;
    const del = pliegoId ? pliegoPorId.get(pliegoId) : null;
    if (pliegoId && !del) return { error: "Hay ítems que no pertenecen al pliego de esta obra." };
    if (pliegoId && vistos.has(pliegoId)) return { error: `El ítem ${del.numeroItem} del pliego está repetido en la OC.` };
    if (pliegoId) vistos.add(pliegoId);

    const descripcion = String(it.descripcion || del?.descripcionItem || "").trim();
    if (!descripcion) return { error: "Un ítem propio necesita descripción." };
    const cantidad = Number(it.cantidad);
    const precio = Number(it.precio_unitario);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: `El ítem "${descripcion}" necesita una cantidad mayor a 0.` };
    if (!Number.isFinite(precio) || precio < 0) return { error: `El ítem "${descripcion}" tiene un precio inválido.` };

    limpios.push({
      id: it.id ? Number(it.id) : null,
      pliego_item_id: pliegoId,
      numero: String(it.numero || del?.numeroItem || "").trim() || null,
      descripcion: descripcion.slice(0, 600),
      unidad: String(it.unidad || del?.unidadMedida || "").trim().slice(0, 30) || null,
      cantidad: r4(cantidad),
      precio_unitario: r2(precio),
      origen: it.origen === "adicional" ? "adicional" : "contrato",
      orden: i,
    });
  }

  return {
    cabecera: {
      subcontratista,
      cuit: String(body.cuit || "").trim() || null,
      numero_oc: String(body.numero_oc || "").trim() || null,
      fecha_contrato: body.fecha_contrato ? norm(body.fecha_contrato) : null,
      fecha_inicio: body.fecha_inicio ? norm(body.fecha_inicio) : null,
      periodicidad,
      observaciones: body.observaciones || null,
      ...(body.estado ? { estado: body.estado } : {}),
    },
    items: limpios,
  };
}

/* ======================================================
   LISTAR los subcontratos de una obra, con sus números
====================================================== */
router.get("/:obraId/subcontratos", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId } = req.params;
    const subs = await Subcontrato.findAll({ where: { obra_id: obraId }, order: [["createdAt", "ASC"]] });
    const lista = [];
    for (const s of subs) {
      const d = await cargar(obraId, s.id);
      lista.push({ ...datosCabecera(s), items: d.items.length, totales: resumenDe(d).totales });
    }
    return res.json(lista);
  } catch (error) {
    console.error("Error listando subcontratos:", error);
    return res.status(500).json({ message: "Error al listar los subcontratos" });
  }
});

/* ======================================================
   PLIEGO de la obra, para armar la OC.
   Marca en qué otros subcontratos está cada ítem.
====================================================== */
router.get("/:obraId/subcontratos-pliego", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId } = req.params;
    const pliego = (await PliegoItem.findAll({ where: { obraId }, raw: true }))
      .sort((a, b) => String(a.numeroItem).localeCompare(String(b.numeroItem), "es", { numeric: true }));
    const subs = await Subcontrato.findAll({ where: { obra_id: obraId, estado: ["vigente", "finalizado"] }, raw: true });
    const usos = subs.length
      ? await SubcontratoItem.findAll({ where: { subcontrato_id: subs.map((s) => s.id) }, raw: true })
      : [];
    const nombre = Object.fromEntries(subs.map((s) => [s.id, s.subcontratista]));
    const enSubs = {};
    for (const u of usos) {
      if (!u.pliego_item_id) continue;
      (enSubs[u.pliego_item_id] ||= []).push({ subcontrato_id: u.subcontrato_id, subcontratista: nombre[u.subcontrato_id] });
    }
    return res.json(pliego.map((p) => ({
      id: p.id, numeroItem: p.numeroItem, descripcionItem: p.descripcionItem, unidadMedida: p.unidadMedida,
      cantidad: Number(p.cantidad || 0), origen: p.origen, en_subcontratos: enSubs[p.id] || [],
    })));
  } catch (error) {
    console.error("Error pliego para subcontrato:", error);
    return res.status(500).json({ message: "Error al cargar el pliego" });
  }
});

/* ======================================================
   CREAR la orden de compra
====================================================== */
router.post("/:obraId/subcontratos", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId } = req.params;
    const obra = await Obra.findByPk(obraId, { transaction: t });
    if (!obra) { await t.rollback(); return res.status(404).json({ message: "Obra no encontrada" }); }

    const datos = await validarOC({ obraId, body: req.body, t });
    if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

    const sub = await Subcontrato.create({ obra_id: Number(obraId), ...datos.cabecera }, { transaction: t });
    await SubcontratoItem.bulkCreate(
      datos.items.map(({ id, ...it }) => ({ ...it, subcontrato_id: sub.id })),
      { transaction: t }
    );
    await t.commit();
    return res.status(201).json({ ok: true, id: sub.id, message: "Subcontrato creado" });
  } catch (error) {
    await t.rollback();
    console.error("Error creando subcontrato:", error);
    return res.status(500).json({ message: "Error al crear el subcontrato" });
  }
});

/* ======================================================
   DETALLE: OC, estadísticas, curva y certificados
====================================================== */
router.get("/:obraId/subcontratos/:subId", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId);
    if (!d) return res.status(404).json({ message: "Subcontrato no encontrado" });

    const certificados = d.todos.map((c) => {
      if (c.anulado) return { ...c, importe: null, descuentos: null, a_pagar: null, avance_acumulado: null };
      const p = planillaDe({
        items: d.items, certificados: d.vigentes, certItemsPorCert: d.certItemsPorCert,
        descuentos: d.descuentosPorCert[c.id] || [], certificado: c,
      });
      return {
        ...c,
        importe: p.totales.importe.actual,
        descuentos: p.totales.descuentos,
        a_pagar: p.totales.a_pagar,
        avance_acumulado: p.totales.avance.acumulado,
      };
    });

    return res.json({
      subcontrato: datosCabecera(d.sub),
      items: itemsPlanos(d.items),
      resumen: resumenDe(d),
      certificados,
      ultimo_certificado_id: d.vigentes[d.vigentes.length - 1]?.id || null,
      tiene_plan: d.planPeriodos.length > 0,
    });
  } catch (error) {
    console.error("Error detalle subcontrato:", error);
    return res.status(500).json({ message: "Error al cargar el subcontrato" });
  }
});

/* ======================================================
   EDITAR la OC y sus ítems
   · Un ítem que ya tiene certificados no se puede sacar.
   · Cambiar el precio vale para los certificados que vengan: lo ya
     certificado conserva el precio con el que se certificó.
====================================================== */
router.put("/:obraId/subcontratos/:subId", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }

    const datos = await validarOC({ obraId, body: req.body, t });
    if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

    const existentes = new Map(d.items.map((i) => [i.id, i]));
    if (datos.items.some((i) => i.id && !existentes.has(i.id))) {
      await t.rollback();
      return res.status(400).json({ message: "Hay ítems que no son de este subcontrato." });
    }

    const conCertificado = new Set();
    for (const c of d.todos) for (const ci of d.certItemsPorCert[c.id] || []) conCertificado.add(ci.subcontrato_item_id);

    const quedan = new Set(datos.items.filter((i) => i.id).map((i) => i.id));
    const aBorrar = d.items.filter((i) => !quedan.has(i.id));
    const trabado = aBorrar.find((i) => conCertificado.has(i.id));
    if (trabado) {
      await t.rollback();
      return res.status(400).json({ message: `No se puede sacar el ítem "${trabado.descripcion}": ya tiene cantidades certificadas.` });
    }

    await d.sub.update(datos.cabecera, { transaction: t });
    if (aBorrar.length) {
      const ids = aBorrar.map((i) => i.id);
      await SubcontratoPlanItem.destroy({ where: { subcontrato_item_id: ids }, transaction: t });
      await SubcontratoItem.destroy({ where: { id: ids }, transaction: t });
    }
    for (const it of datos.items) {
      const { id, ...campos } = it;
      if (id) await SubcontratoItem.update(campos, { where: { id }, transaction: t });
      else await SubcontratoItem.create({ ...campos, subcontrato_id: d.sub.id }, { transaction: t });
    }

    await t.commit();
    return res.json({ ok: true, message: "Subcontrato actualizado" });
  } catch (error) {
    await t.rollback();
    console.error("Error editando subcontrato:", error);
    return res.status(500).json({ message: "Error al editar el subcontrato" });
  }
});

/* ======================================================
   BORRAR — solo si no tiene certificados vigentes
====================================================== */
router.delete("/:obraId/subcontratos/:subId", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }
    if (d.vigentes.length) {
      await t.rollback();
      return res.status(400).json({ message: "El subcontrato tiene certificados. Para cerrarlo, cambiale el estado a finalizado o anulado." });
    }
    const certIds = d.todos.map((c) => c.id);
    if (certIds.length) {
      await SubcontratoDescuento.destroy({ where: { certificado_id: certIds }, transaction: t });
      await SubcontratoCertificadoItem.destroy({ where: { certificado_id: certIds }, transaction: t });
      await SubcontratoCertificado.destroy({ where: { id: certIds }, transaction: t });
    }
    const periodoIds = d.planPeriodos.map((p) => p.id);
    if (periodoIds.length) {
      await SubcontratoPlanItem.destroy({ where: { plan_periodo_id: periodoIds }, transaction: t });
      await SubcontratoPlanPeriodo.destroy({ where: { id: periodoIds }, transaction: t });
    }
    await SubcontratoItem.destroy({ where: { subcontrato_id: d.sub.id }, transaction: t });
    await d.sub.destroy({ transaction: t });
    await t.commit();
    return res.json({ ok: true, message: "Subcontrato borrado" });
  } catch (error) {
    await t.rollback();
    console.error("Error borrando subcontrato:", error);
    return res.status(500).json({ message: "Error al borrar el subcontrato" });
  }
});

/* ======================================================
   PLAN DE TRABAJO por período
====================================================== */
router.get("/:obraId/subcontratos/:subId/plan", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId);
    if (!d) return res.status(404).json({ message: "Subcontrato no encontrado" });

    let periodos = d.planPeriodos.map((p) => ({
      numero: p.numero, desde: norm(p.desde), hasta: norm(p.hasta),
      items: (d.planItemsPorPeriodo[p.id] || []).map((pi) => ({
        subcontrato_item_id: pi.subcontrato_item_id, cantidad: Number(pi.cantidad),
      })),
    }));
    // Sin plan todavía: se proponen períodos desde el inicio del contrato.
    const propuesto = !periodos.length;
    if (propuesto) {
      const inicio = d.sub.fecha_inicio || d.sub.fecha_contrato || hoyISO();
      periodos = generarPeriodos({ inicio, periodicidad: d.sub.periodicidad, cantidad: d.sub.periodicidad === "semanal" ? 12 : 8 })
        .map((p) => ({ ...p, items: [] }));
    }

    return res.json({
      subcontrato: datosCabecera(d.sub),
      items: itemsPlanos(d.items),
      total_contrato: totalContrato(d.items),
      periodos,
      propuesto,
    });
  } catch (error) {
    console.error("Error plan subcontrato:", error);
    return res.status(500).json({ message: "Error al cargar el plan" });
  }
});

router.put("/:obraId/subcontratos/:subId/plan", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  const rechazar = async (message) => { await t.rollback(); return res.status(400).json({ message }); };
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }

    const periodos = (Array.isArray(req.body.periodos) ? req.body.periodos : [])
      .map((p) => ({ ...p, desde: norm(p.desde), hasta: norm(p.hasta) }))
      .sort((a, b) => (a.desde < b.desde ? -1 : 1));
    if (!periodos.length) return rechazar("El plan tiene que tener al menos un período.");

    const itemsPorId = new Map(d.items.map((i) => [i.id, i]));
    const totalPorItem = {};
    for (let i = 0; i < periodos.length; i++) {
      const p = periodos[i];
      if (!esFecha(p.desde) || !esFecha(p.hasta) || p.desde > p.hasta) return rechazar("Hay un período con fechas inválidas.");
      if (i > 0 && periodos[i - 1].hasta >= p.desde) return rechazar("Hay dos períodos del plan que se pisan.");
      const vistos = new Set();
      for (const pi of p.items || []) {
        const id = Number(pi.subcontrato_item_id);
        const cantidad = Number(pi.cantidad);
        if (!itemsPorId.has(id)) return rechazar("Hay ítems que no son de este subcontrato.");
        if (!Number.isFinite(cantidad) || cantidad < 0) return rechazar("Hay cantidades inválidas en el plan.");
        if (vistos.has(id)) return rechazar("Un ítem aparece dos veces en el mismo período.");
        vistos.add(id);
        totalPorItem[id] = (totalPorItem[id] || 0) + cantidad;
      }
    }
    // El plan reparte lo contratado: un ítem no puede planificarse de más.
    for (const [id, total] of Object.entries(totalPorItem)) {
      const it = itemsPorId.get(Number(id));
      if (total > Number(it.cantidad) + TOLERANCIA) {
        return rechazar(`El ítem "${it.descripcion}" tiene ${r4(total)} ${it.unidad || ""} planificados y el contrato dice ${r4(it.cantidad)}.`);
      }
    }

    const viejos = d.planPeriodos.map((p) => p.id);
    if (viejos.length) {
      await SubcontratoPlanItem.destroy({ where: { plan_periodo_id: viejos }, transaction: t });
      await SubcontratoPlanPeriodo.destroy({ where: { id: viejos }, transaction: t });
    }
    for (const [i, p] of periodos.entries()) {
      const fila = await SubcontratoPlanPeriodo.create(
        { subcontrato_id: d.sub.id, numero: i + 1, desde: p.desde, hasta: p.hasta }, { transaction: t }
      );
      const items = (p.items || []).filter((pi) => Number(pi.cantidad) > 0)
        .map((pi) => ({ plan_periodo_id: fila.id, subcontrato_item_id: Number(pi.subcontrato_item_id), cantidad: r4(pi.cantidad) }));
      if (items.length) await SubcontratoPlanItem.bulkCreate(items, { transaction: t });
    }
    await t.commit();
    return res.json({ ok: true, message: "Plan guardado" });
  } catch (error) {
    await t.rollback();
    console.error("Error guardando plan subcontrato:", error);
    return res.status(500).json({ message: "Error al guardar el plan" });
  }
});

/* ======================================================
   CERTIFICADOS
====================================================== */

/** La planilla de un certificado, con cabecera y descuentos. */
function armarPlanilla(d, cert) {
  const p = planillaDe({
    items: d.items, certificados: d.vigentes, certItemsPorCert: d.certItemsPorCert,
    descuentos: d.descuentosPorCert[cert.id] || [], certificado: cert,
  });
  const ultimo = d.vigentes[d.vigentes.length - 1];
  return {
    subcontrato: datosCabecera(d.sub),
    certificado: {
      id: cert.id || null, numero: cert.numero, desde: norm(cert.desde), hasta: norm(cert.hasta),
      fecha: norm(cert.fecha) || null, anulado: !!cert.anulado, observaciones: cert.observaciones || null,
    },
    filas: p.filas,
    totales: p.totales,
    descuentos: (d.descuentosPorCert[cert.id] || []).map((x) => ({ tipo: x.tipo, concepto: x.concepto, importe: Number(x.importe) })),
    // Solo se corrige el último; uno nuevo, siempre.
    editable: !cert.id || (!cert.anulado && cert.id === ultimo?.id),
  };
}

router.get("/:obraId/subcontratos/:subId/certificados/nuevo", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId);
    if (!d) return res.status(404).json({ message: "Subcontrato no encontrado" });
    const ultimo = d.vigentes[d.vigentes.length - 1];
    const periodo = sugerirPeriodo({
      ultimoHasta: ultimo ? norm(ultimo.hasta) : null,
      inicio: d.sub.fecha_inicio || d.sub.fecha_contrato,
      periodicidad: d.sub.periodicidad,
    });
    const numero = d.todos.reduce((m, c) => Math.max(m, c.numero), 0) + 1;
    return res.json(armarPlanilla(d, { id: null, numero, desde: periodo.desde, hasta: periodo.hasta, fecha: hoyISO() }));
  } catch (error) {
    console.error("Error certificado nuevo:", error);
    return res.status(500).json({ message: "Error al preparar el certificado" });
  }
});

router.get("/:obraId/subcontratos/:subId/certificados/:certId", authMiddleware, LEER, async (req, res) => {
  try {
    const { obraId, subId, certId } = req.params;
    const d = await cargar(obraId, subId);
    if (!d) return res.status(404).json({ message: "Subcontrato no encontrado" });
    const cert = d.todos.find((c) => c.id === Number(certId));
    if (!cert) return res.status(404).json({ message: "Certificado no encontrado" });
    return res.json(armarPlanilla(d, cert));
  } catch (error) {
    console.error("Error planilla certificado:", error);
    return res.status(500).json({ message: "Error al cargar el certificado" });
  }
});

/**
 * Valida un certificado. `anteriorHasta` es el cierre del certificado previo:
 * los períodos no se pueden pisar.
 */
function validarCertificado({ body, d, anteriorHasta }) {
  const desde = norm(body.desde);
  const hasta = norm(body.hasta);
  if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) return { error: "Indicá el período: desde y hasta." };
  if (anteriorHasta && desde <= anteriorHasta) {
    return { error: `El período se pisa con el certificado anterior, que llega hasta el ${anteriorHasta}.` };
  }
  if (body.fecha && !esFecha(norm(body.fecha))) return { error: "La fecha del certificado no es válida." };

  const itemsPorId = new Map(d.items.map((i) => [i.id, i]));
  const vistos = new Set();
  const items = [];
  for (const ci of Array.isArray(body.items) ? body.items : []) {
    const id = Number(ci.subcontrato_item_id);
    const cantidad = Number(ci.cantidad);
    if (!itemsPorId.has(id)) return { error: "Hay ítems que no son de este subcontrato." };
    if (!Number.isFinite(cantidad) || cantidad < 0) return { error: "Hay cantidades inválidas." };
    if (vistos.has(id)) return { error: "Un ítem aparece dos veces en el certificado." };
    vistos.add(id);
    if (cantidad > 0) items.push({ id, cantidad: r4(cantidad) });
  }

  const descuentos = [];
  for (const x of Array.isArray(body.descuentos) ? body.descuentos : []) {
    const importe = Number(x.importe);
    const tipo = TIPOS_DESCUENTO.includes(x.tipo) ? x.tipo : "otro";
    const concepto = String(x.concepto || "").trim();
    if (!Number.isFinite(importe) || importe <= 0) return { error: "Cada descuento necesita un importe mayor a 0." };
    if (tipo === "otro" && !concepto) return { error: "Un descuento de tipo 'otro' necesita que digas qué es." };
    descuentos.push({ tipo, concepto: concepto || null, importe: r2(importe) });
  }

  if (!items.length && !descuentos.length) return { error: "El certificado está vacío: cargá cantidades o descuentos." };
  return { desde, hasta, fecha: body.fecha ? norm(body.fecha) : null, observaciones: body.observaciones || null, items, descuentos };
}

/** Excedentes que produce el certificado: se avisan, no se rechazan. */
function avisosDeExcedente(d, datos, excluirCertId) {
  const previo = {};
  for (const c of d.vigentes) {
    if (c.id === excluirCertId) continue;
    for (const ci of d.certItemsPorCert[c.id] || []) {
      previo[ci.subcontrato_item_id] = (previo[ci.subcontrato_item_id] || 0) + Number(ci.cantidad);
    }
  }
  const avisos = [];
  for (const ci of datos.items) {
    const it = d.items.find((i) => i.id === ci.id);
    const acum = (previo[ci.id] || 0) + ci.cantidad;
    const exced = acum - Number(it.cantidad);
    if (exced > TOLERANCIA) {
      avisos.push({
        subcontrato_item_id: it.id,
        descripcion: it.descripcion,
        excedente: r4(exced),
        mensaje: `"${it.descripcion}": el acumulado (${r4(acum)} ${it.unidad || ""}) supera lo contratado (${r4(it.cantidad)}). Quedan ${r4(exced)} ${it.unidad || ""} como excedente.`,
      });
    }
  }
  return avisos;
}

async function guardarItemsYDescuentos({ cert, datos, d, preciosPrevios, t }) {
  const itemsPorId = new Map(d.items.map((i) => [i.id, i]));
  if (datos.items.length) {
    await SubcontratoCertificadoItem.bulkCreate(
      datos.items.map((ci) => ({
        certificado_id: cert.id,
        subcontrato_item_id: ci.id,
        cantidad: ci.cantidad,
        // Se congela el precio: el que ya tenía esa línea si se está
        // corrigiendo, o el vigente del ítem si es nueva.
        precio_unitario: preciosPrevios[ci.id] ?? Number(itemsPorId.get(ci.id).precio_unitario),
      })),
      { transaction: t }
    );
  }
  if (datos.descuentos.length) {
    await SubcontratoDescuento.bulkCreate(datos.descuentos.map((x) => ({ ...x, certificado_id: cert.id })), { transaction: t });
  }
}

router.post("/:obraId/subcontratos/:subId/certificados", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, subId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }
    if (d.sub.estado === "anulado") { await t.rollback(); return res.status(400).json({ message: "El subcontrato está anulado." }); }

    const ultimo = d.vigentes[d.vigentes.length - 1];
    const datos = validarCertificado({ body: req.body, d, anteriorHasta: ultimo ? norm(ultimo.hasta) : null });
    if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

    const numero = d.todos.reduce((m, c) => Math.max(m, c.numero), 0) + 1;
    const cert = await SubcontratoCertificado.create({
      subcontrato_id: d.sub.id, numero, desde: datos.desde, hasta: datos.hasta,
      fecha: datos.fecha || hoyISO(), observaciones: datos.observaciones, creado_por_id: req.user?.id || null,
    }, { transaction: t });
    await guardarItemsYDescuentos({ cert, datos, d, preciosPrevios: {}, t });

    const avisos = avisosDeExcedente(d, datos, null);
    await t.commit();
    return res.status(201).json({ ok: true, id: cert.id, numero, avisos, hay_excedentes: avisos.length > 0, message: `Certificado N° ${numero} guardado` });
  } catch (error) {
    await t.rollback();
    console.error("Error creando certificado de subcontrato:", error);
    return res.status(500).json({ message: "Error al guardar el certificado" });
  }
});

router.put("/:obraId/subcontratos/:subId/certificados/:certId", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, subId, certId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }
    const cert = d.vigentes.find((c) => c.id === Number(certId));
    if (!cert) { await t.rollback(); return res.status(404).json({ message: "Certificado no encontrado" }); }
    // Solo el último: corregir uno del medio cambiaría el "anterior" de los
    // siguientes, que ya se pagaron.
    if (cert.id !== d.vigentes[d.vigentes.length - 1].id) {
      await t.rollback();
      return res.status(400).json({ message: "Solo se puede corregir el último certificado." });
    }

    const previo = d.vigentes[d.vigentes.length - 2];
    const datos = validarCertificado({ body: req.body, d, anteriorHasta: previo ? norm(previo.hasta) : null });
    if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

    const preciosPrevios = Object.fromEntries(
      (d.certItemsPorCert[cert.id] || []).map((ci) => [ci.subcontrato_item_id, Number(ci.precio_unitario)])
    );
    await SubcontratoCertificado.update(
      { desde: datos.desde, hasta: datos.hasta, fecha: datos.fecha || cert.fecha, observaciones: datos.observaciones },
      { where: { id: cert.id }, transaction: t }
    );
    await SubcontratoCertificadoItem.destroy({ where: { certificado_id: cert.id }, transaction: t });
    await SubcontratoDescuento.destroy({ where: { certificado_id: cert.id }, transaction: t });
    await guardarItemsYDescuentos({ cert, datos, d, preciosPrevios, t });

    const avisos = avisosDeExcedente(d, datos, cert.id);
    await t.commit();
    return res.json({ ok: true, avisos, hay_excedentes: avisos.length > 0, message: `Certificado N° ${cert.numero} corregido` });
  } catch (error) {
    await t.rollback();
    console.error("Error editando certificado de subcontrato:", error);
    return res.status(500).json({ message: "Error al corregir el certificado" });
  }
});

router.post("/:obraId/subcontratos/:subId/certificados/:certId/anular", authMiddleware, ESCRIBIR, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { obraId, subId, certId } = req.params;
    const d = await cargar(obraId, subId, t);
    if (!d) { await t.rollback(); return res.status(404).json({ message: "Subcontrato no encontrado" }); }
    const cert = d.vigentes.find((c) => c.id === Number(certId));
    if (!cert) { await t.rollback(); return res.status(404).json({ message: "Certificado no encontrado o ya anulado" }); }
    if (cert.id !== d.vigentes[d.vigentes.length - 1].id) {
      await t.rollback();
      return res.status(400).json({ message: "Solo se puede anular el último certificado." });
    }
    await SubcontratoCertificado.update({ anulado: true }, { where: { id: cert.id }, transaction: t });
    await t.commit();
    return res.json({ ok: true, message: `Certificado N° ${cert.numero} anulado` });
  } catch (error) {
    await t.rollback();
    console.error("Error anulando certificado de subcontrato:", error);
    return res.status(500).json({ message: "Error al anular el certificado" });
  }
});

export default router;
