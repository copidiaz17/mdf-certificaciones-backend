// routes/subcontratos.js
//
// CIRCUITO DEL SUBCONTRATISTA — aparte del de la obra.
//
//   GET    /obras/:obraId/subcontratos                         lista con estadísticas
//   GET    /obras/:obraId/subcontratos-pliego                  pliego para armar la OC
//   POST   /obras/:obraId/subcontratos                         crea la OC con sus ítems
//   GET    /obras/:obraId/subcontratos/:subId                  detalle + estadísticas
//   PUT    /obras/:obraId/subcontratos/:subId                  edita la OC y sus ítems
//   DELETE /obras/:obraId/subcontratos/:subId                  borra (si no tiene certificados)
//   GET    /obras/:obraId/subcontratos/:subId/certificados/nuevo       planilla en blanco
//   GET    /obras/:obraId/subcontratos/:subId/certificados/:certId     planilla de un certificado
//   POST   /obras/:obraId/subcontratos/:subId/certificados             certifica un período
//   PUT    /obras/:obraId/subcontratos/:subId/certificados/:certId     corrige el ÚLTIMO
//   POST   /obras/:obraId/subcontratos/:subId/certificados/:certId/anular  anula el ÚLTIMO
//
// El subcontratista NO tiene plan de trabajo: el avance se registra
// directamente contra la orden de compra, como en la planilla de Excel.
//
// Los trabajos extra se registran como ADICIONAL al certificar, sin cargarlos
// antes: si en un rubro se certifica más de lo contratado, o se agrega un
// rubro que no existía, el servidor pide confirmación y recién ahí lo
// registra, diciendo de qué clase es ("cargado de más" o "ítem nuevo").
import express from "express";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";
import Subcontrato from "../models/Subcontrato.js";
import SubcontratoItem from "../models/SubcontratoItem.js";
import {
  SubcontratoCertificado, SubcontratoCertificadoItem, SubcontratoDescuento,
} from "../models/SubcontratoCertificado.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";
import {
  planillaDe, resumenSubcontrato, sugerirPeriodo, esFecha, norm, r2, r4,
} from "../utils/subcontratos.js";

const router = express.Router();

const LEER = hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
const ESCRIBIR = hasRole([ROLES.ADMIN, ROLES.OPERATOR]);

const ESTADOS = ["vigente", "finalizado", "anulado"];
const PERIODICIDADES = ["quincenal", "semanal"];
const TIPOS_ADICIONAL = ["de_mas", "nuevo"];
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
  const certIds = todos.map((c) => c.id);
  const certItems = certIds.length
    ? await SubcontratoCertificadoItem.findAll({ where: { certificado_id: certIds }, raw: true, transaction: t })
    : [];
  const descuentos = certIds.length
    ? await SubcontratoDescuento.findAll({ where: { certificado_id: certIds }, raw: true, transaction: t })
    : [];

  return {
    sub,
    items,
    todos,
    vigentes: todos.filter((c) => !c.anulado),
    certItemsPorCert: agrupar(certItems, "certificado_id"),
    descuentosPorCert: agrupar(descuentos, "certificado_id"),
  };
}

function resumenDe(d) {
  return resumenSubcontrato({
    items: d.items,
    certificados: d.vigentes,
    certItemsPorCert: d.certItemsPorCert,
    descuentos: d.vigentes.flatMap((c) => d.descuentosPorCert[c.id] || []),
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
 * `existentes` son los ids de ítems que ya tiene el subcontrato: un adicional
 * "de más" tiene que agrandar uno de ellos.
 */
async function validarOC({ obraId, body, existentes = new Set(), t }) {
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

    const esAdicional = it.origen === "adicional";
    let tipo = null, itemOrigen = null;
    if (esAdicional) {
      tipo = it.tipo_adicional;
      if (!TIPOS_ADICIONAL.includes(tipo)) {
        return { error: `El adicional "${descripcion}" tiene que decir si es un rubro cargado de más o un ítem nuevo.` };
      }
      if (tipo === "de_mas") {
        itemOrigen = it.item_origen_id ? Number(it.item_origen_id) : null;
        if (!itemOrigen || !existentes.has(itemOrigen)) {
          return { error: `El adicional "${descripcion}" es de más: indicá qué rubro de la OC agranda.` };
        }
      }
    }

    limpios.push({
      id: it.id ? Number(it.id) : null,
      pliego_item_id: pliegoId,
      numero: String(it.numero || del?.numeroItem || "").trim() || null,
      descripcion: descripcion.slice(0, 600),
      unidad: String(it.unidad || del?.unidadMedida || "").trim().slice(0, 30) || null,
      cantidad: r4(cantidad),
      precio_unitario: r2(precio),
      origen: esAdicional ? "adicional" : "contrato",
      tipo_adicional: tipo,
      item_origen_id: itemOrigen,
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
   DETALLE: OC, estadísticas y certificados
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

    const existentes = new Set(d.items.map((i) => i.id));
    const datos = await validarOC({ obraId, body: req.body, existentes, t });
    if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

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
    const huerfano = datos.items.find((i) => i.item_origen_id && aBorrar.some((b) => b.id === i.item_origen_id));
    if (huerfano) {
      await t.rollback();
      return res.status(400).json({ message: `El adicional "${huerfano.descripcion}" agranda un rubro que estás sacando.` });
    }

    await d.sub.update(datos.cabecera, { transaction: t });
    if (aBorrar.length) await SubcontratoItem.destroy({ where: { id: aBorrar.map((i) => i.id) }, transaction: t });
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
 *
 * `nuevos` son rubros que no estaban en la OC y se cargan directo en el
 * certificado: se registran como adicional "ítem nuevo".
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
    items.push({ id, cantidad: r4(cantidad) });
  }

  const nuevos = [];
  const claves = new Set();
  for (const n of Array.isArray(body.nuevos) ? body.nuevos : []) {
    const descripcion = String(n.descripcion || "").trim();
    const cantidad = Number(n.cantidad);
    const precio = Number(n.precio_unitario);
    const clave = String(n.clave || descripcion);
    if (!descripcion) return { error: "Un ítem nuevo necesita descripción." };
    if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: `El ítem nuevo "${descripcion}" necesita una cantidad mayor a 0.` };
    if (!Number.isFinite(precio) || precio < 0) return { error: `El ítem nuevo "${descripcion}" tiene un precio inválido.` };
    if (claves.has(clave)) return { error: `El ítem nuevo "${descripcion}" está repetido.` };
    claves.add(clave);
    nuevos.push({
      clave, descripcion: descripcion.slice(0, 600), unidad: String(n.unidad || "").trim().slice(0, 30) || null,
      numero: String(n.numero || "").trim() || null, cantidad: r4(cantidad), precio_unitario: r2(precio),
    });
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

  if (!items.some((i) => i.cantidad > 0) && !nuevos.length && !descuentos.length) {
    return { error: "El certificado está vacío: cargá cantidades, ítems nuevos o descuentos." };
  }
  return {
    desde, hasta, fecha: body.fecha ? norm(body.fecha) : null, observaciones: body.observaciones || null,
    items, nuevos, descuentos,
  };
}

/**
 * Lo que este certificado registraría como ADICIONAL: rubros que superan lo
 * contratado ("cargado de más") y rubros que no existían ("ítem nuevo").
 * Los ítems que nacieron en este mismo certificado no cuentan: su cantidad
 * acordada es justamente la que se certifica.
 */
function extrasDe(d, datos, cert) {
  const previo = {};
  for (const c of d.vigentes) {
    if (cert && c.id === cert.id) continue;
    for (const ci of d.certItemsPorCert[c.id] || []) {
      previo[ci.subcontrato_item_id] = (previo[ci.subcontrato_item_id] || 0) + Number(ci.cantidad);
    }
  }
  const extras = [];
  for (const ci of datos.items) {
    if (ci.cantidad <= 0) continue;
    const it = d.items.find((i) => i.id === ci.id);
    if (cert && it.creado_en_certificado_id === cert.id) continue;
    const exced = (previo[ci.id] || 0) + ci.cantidad - Number(it.cantidad);
    if (exced > TOLERANCIA) {
      extras.push({
        tipo: "de_mas",
        subcontrato_item_id: it.id,
        descripcion: it.descripcion,
        unidad: it.unidad,
        cantidad: r4(exced),
        mensaje: `"${it.descripcion}": se está cargando ${r4(exced)} ${it.unidad || ""} de más sobre lo contratado (${r4(it.cantidad)}). Se registra como adicional: cargado de más.`,
      });
    }
  }
  for (const n of datos.nuevos) {
    extras.push({
      tipo: "nuevo",
      descripcion: n.descripcion,
      unidad: n.unidad,
      cantidad: n.cantidad,
      mensaje: `"${n.descripcion}" no está en la orden de compra. Se registra como adicional: ítem nuevo (${n.cantidad} ${n.unidad || ""}).`,
    });
  }
  return extras;
}

/** Si hay extras sin confirmar, se frena y se le devuelve a la pantalla qué preguntar. */
function pedirConfirmacion(res, extras) {
  return res.status(409).json({
    requiere_confirmacion: true,
    extras,
    message: extras.length === 1
      ? "Hay un trabajo extra en este certificado. ¿Lo registramos como adicional?"
      : `Hay ${extras.length} trabajos extra en este certificado. ¿Los registramos como adicionales?`,
  });
}

/** Crea los ítems nuevos (adicional "ítem nuevo") nacidos en este certificado. */
async function crearNuevos({ d, datos, cert, t }) {
  const orden = d.items.reduce((m, i) => Math.max(m, i.orden), 0);
  const creados = [];
  for (const [k, n] of datos.nuevos.entries()) {
    const item = await SubcontratoItem.create({
      subcontrato_id: d.sub.id, pliego_item_id: null, numero: n.numero, descripcion: n.descripcion,
      unidad: n.unidad, cantidad: n.cantidad, precio_unitario: n.precio_unitario,
      origen: "adicional", tipo_adicional: "nuevo", creado_en_certificado_id: cert.id, orden: orden + k + 1,
    }, { transaction: t });
    creados.push({ id: item.id, cantidad: n.cantidad, precio_unitario: n.precio_unitario });
  }
  return creados;
}

async function guardarLineas({ cert, lineas, descuentos, t }) {
  const conCantidad = lineas.filter((l) => l.cantidad > 0);
  if (conCantidad.length) {
    await SubcontratoCertificadoItem.bulkCreate(
      conCantidad.map((l) => ({ certificado_id: cert.id, subcontrato_item_id: l.id, cantidad: l.cantidad, precio_unitario: l.precio_unitario })),
      { transaction: t }
    );
  }
  if (descuentos.length) {
    await SubcontratoDescuento.bulkCreate(descuentos.map((x) => ({ ...x, certificado_id: cert.id })), { transaction: t });
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

    const extras = extrasDe(d, datos, null);
    if (extras.length && req.body.confirmar_extras !== true) { await t.rollback(); return pedirConfirmacion(res, extras); }

    const numero = d.todos.reduce((m, c) => Math.max(m, c.numero), 0) + 1;
    const cert = await SubcontratoCertificado.create({
      subcontrato_id: d.sub.id, numero, desde: datos.desde, hasta: datos.hasta,
      fecha: datos.fecha || hoyISO(), observaciones: datos.observaciones, creado_por_id: req.user?.id || null,
    }, { transaction: t });

    const itemsPorId = new Map(d.items.map((i) => [i.id, i]));
    const nuevos = await crearNuevos({ d, datos, cert, t });
    await guardarLineas({
      cert, t, descuentos: datos.descuentos,
      lineas: [
        // Precio congelado: el vigente del ítem al certificar.
        ...datos.items.map((l) => ({ ...l, precio_unitario: Number(itemsPorId.get(l.id).precio_unitario) })),
        ...nuevos,
      ],
    });

    await t.commit();
    return res.status(201).json({
      ok: true, id: cert.id, numero, adicionales_registrados: extras,
      message: `Certificado N° ${numero} guardado${extras.length ? ` con ${extras.length} adicional(es)` : ""}`,
    });
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

    const extras = extrasDe(d, datos, cert);
    if (extras.length && req.body.confirmar_extras !== true) { await t.rollback(); return pedirConfirmacion(res, extras); }

    const preciosPrevios = Object.fromEntries(
      (d.certItemsPorCert[cert.id] || []).map((ci) => [ci.subcontrato_item_id, Number(ci.precio_unitario)])
    );
    await SubcontratoCertificado.update(
      { desde: datos.desde, hasta: datos.hasta, fecha: datos.fecha || cert.fecha, observaciones: datos.observaciones },
      { where: { id: cert.id }, transaction: t }
    );
    await SubcontratoCertificadoItem.destroy({ where: { certificado_id: cert.id }, transaction: t });
    await SubcontratoDescuento.destroy({ where: { certificado_id: cert.id }, transaction: t });

    // Los ítems nuevos que nacieron en este certificado acompañan la
    // corrección: su cantidad acordada es la certificada, y si se lleva a
    // cero, el ítem desaparece.
    const itemsPorId = new Map(d.items.map((i) => [i.id, i]));
    const cantidadPorId = new Map(datos.items.map((l) => [l.id, l.cantidad]));
    const nacidos = d.items.filter((i) => i.creado_en_certificado_id === cert.id);
    const aBorrar = [];
    for (const it of nacidos) {
      const q = cantidadPorId.get(it.id) || 0;
      if (q > 0) await SubcontratoItem.update({ cantidad: q }, { where: { id: it.id }, transaction: t });
      else aBorrar.push(it.id);
    }
    if (aBorrar.length) await SubcontratoItem.destroy({ where: { id: aBorrar }, transaction: t });

    const nuevos = await crearNuevos({ d, datos, cert, t });
    await guardarLineas({
      cert, t, descuentos: datos.descuentos,
      lineas: [
        ...datos.items.filter((l) => !aBorrar.includes(l.id)).map((l) => ({
          ...l, precio_unitario: preciosPrevios[l.id] ?? Number(itemsPorId.get(l.id).precio_unitario),
        })),
        ...nuevos,
      ],
    });

    await t.commit();
    return res.json({ ok: true, adicionales_registrados: extras, message: `Certificado N° ${cert.numero} corregido` });
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

    // Los ítems nuevos que nacieron en este certificado se van con él: no
    // tienen nada certificado en otro lado.
    const nacidos = d.items.filter((i) => i.creado_en_certificado_id === cert.id).map((i) => i.id);
    if (nacidos.length) {
      await SubcontratoCertificadoItem.destroy({ where: { certificado_id: cert.id, subcontrato_item_id: nacidos }, transaction: t });
      await SubcontratoItem.destroy({ where: { id: nacidos }, transaction: t });
    }
    await SubcontratoCertificado.update({ anulado: true }, { where: { id: cert.id }, transaction: t });
    await t.commit();
    return res.json({ ok: true, message: `Certificado N° ${cert.numero} anulado`, items_quitados: nacidos.length });
  } catch (error) {
    await t.rollback();
    console.error("Error anulando certificado de subcontrato:", error);
    return res.status(500).json({ message: "Error al anular el certificado" });
  }
});

export default router;
