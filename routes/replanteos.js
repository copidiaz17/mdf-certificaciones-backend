// routes/replanteos.js
//
// REPLANTEO = una versión nueva del plan de trabajos, con todos sus meses.
//
//   GET    /obras/:obraId/replanteos/contexto[?version=N]   lo que necesita la grilla
//   POST   /obras/:obraId/replanteos                        crea la versión siguiente
//   PUT    /obras/:obraId/replanteos/:version               reemplaza la versión vigente
//   DELETE /obras/:obraId/replanteos/:version               borra la versión vigente
//
// Por qué la versión se guarda ENTERA y no mes a mes: cargado de a un mes, el
// sistema no tenía cómo saber que abril y marzo eran parte del mismo replanteo.
// Cada mes volvía a ofrecer el mismo disponible y la curva pasaba del 100%. Y
// un solo registro de marzo a mayo tampoco servía: todo el porcentaje caía el
// último día, como un escalón.
//
// Todo lo que escribe va en una transacción. Antes la pantalla creaba los
// ítems adicionales primero y el replanteo después, en llamadas separadas: si
// el replanteo fallaba, el adicional quedaba igual en el pliego.
import express from "express";
import { sequelize } from "../database.js";

import Obra from "../models/Obra.js";
import PliegoItem from "../models/PliegoItem.js";
import ItemGeneral from "../models/ItemGeneral.js";
import Planificacion from "../models/planificacion.js";
import PlanificacionItem from "../models/planificacionItem.js";
import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";

import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";
import {
  agruparVersiones, avancePorItemHasta, disponibleDeItem, ultimoCorte,
  cierreDeAvance, esFecha, norm, r2,
} from "../utils/planVersiones.js";

const router = express.Router();

const MOTIVOS = ["tiempo", "adicional_item", "ambos"];
const r5 = (n) => Number(Number(n || 0).toFixed(5));
const porNumero = (a, b) => String(a.numeroItem).localeCompare(String(b.numeroItem), "es", { numeric: true });

async function cargarObra(obraId, t) {
  const opts = t ? { transaction: t, lock: t.LOCK.UPDATE } : {};
  const obra = await Obra.findByPk(obraId, opts);
  if (!obra) return null;
  const pliego = await PliegoItem.findAll({ where: { obraId }, raw: true, transaction: t });
  const planificaciones = await Planificacion.findAll({ where: { obraId }, raw: true, transaction: t });
  const avances = await AvanceObra.findAll({ where: { obra_id: obraId }, raw: true, transaction: t });
  const avanceItems = avances.length
    ? await AvanceObraItem.findAll({ where: { avance_obra_id: avances.map((a) => a.id) }, raw: true, transaction: t })
    : [];
  return { obra, pliego, versiones: agruparVersiones(planificaciones), avances, avanceItems };
}

/**
 * Valida una versión completa. Devuelve { error } o los datos normalizados.
 * Reglas:
 *   · los meses son posteriores al corte y no se pisan entre sí
 *   · cada ítem es de esta obra, o un adicional que viene en el mismo pedido
 *   · lo planificado de un ítem, sumando TODOS los meses, no supera lo que le
 *     falta ejecutar al corte. Esta es la regla que antes faltaba.
 */
function validarVersion({ body, fechaCorte, pliego, real }) {
  const motivo = body.motivo;
  if (!MOTIVOS.includes(motivo)) return { error: "Elegí el motivo del replanteo." };
  if (!esFecha(fechaCorte)) return { error: "Falta la fecha de corte (hasta dónde manda el avance real)." };

  const meses = Array.isArray(body.meses) ? body.meses : [];
  if (!meses.length) return { error: "El replanteo tiene que tener al menos un mes." };
  const mesesOrdenados = meses
    .map((m) => ({ ...m, fecha_desde: norm(m.fecha_desde), fecha_hasta: norm(m.fecha_hasta) }))
    .sort((a, b) => (a.fecha_desde < b.fecha_desde ? -1 : 1));
  for (let i = 0; i < mesesOrdenados.length; i++) {
    const m = mesesOrdenados[i];
    if (!esFecha(m.fecha_desde) || !esFecha(m.fecha_hasta) || m.fecha_desde > m.fecha_hasta) {
      return { error: "Hay un mes con fechas inválidas." };
    }
    if (m.fecha_desde <= fechaCorte) {
      return { error: `El mes que empieza el ${m.fecha_desde} es anterior al corte (${fechaCorte}). Lo que pasó hasta el corte ya está ejecutado.` };
    }
    if (i > 0 && mesesOrdenados[i - 1].fecha_hasta >= m.fecha_desde) {
      return { error: "Hay dos meses del replanteo que se pisan." };
    }
  }

  const adicionales = Array.isArray(body.adicionales) ? body.adicionales : [];
  if (adicionales.length && motivo === "tiempo") {
    return { error: "Con motivo 'extensión de plazo' no se agregan ítems. Elegí 'adicional' o 'extensión + adicional'." };
  }
  const numerosPliego = new Set(pliego.map((p) => String(p.numeroItem).trim().toLowerCase()));
  const claves = new Map();
  for (const ad of adicionales) {
    const clave = String(ad.clave || "").trim();
    const descripcion = String(ad.descripcionItem || "").trim();
    const numero = String(ad.numeroItem || "").trim();
    if (!clave || claves.has(clave)) return { error: "Los ítems adicionales vinieron sin identificar." };
    if (!descripcion) return { error: "Un ítem adicional no tiene descripción." };
    if (!(Number(ad.cantidad) > 0)) return { error: `El adicional "${descripcion}" necesita una cantidad mayor a 0.` };
    if (!(Number(ad.costoUnitario) > 0)) return { error: `El adicional "${descripcion}" necesita un costo unitario mayor a 0.` };
    if (numero && numerosPliego.has(numero.toLowerCase())) {
      return { error: `Ya hay un ítem ${numero} en el pliego de esta obra.` };
    }
    if (numero) numerosPliego.add(numero.toLowerCase());
    claves.set(clave, { ...ad, clave, descripcion, numero });
  }

  const pliegoPorId = new Map(pliego.map((p) => [p.id, p]));
  const totalPorItem = new Map();
  let hayAlgo = false;
  for (const m of mesesOrdenados) {
    const vistos = new Set();
    m.items = (Array.isArray(m.items) ? m.items : []).map((it) => {
      const ref = it.clave ? `clave:${it.clave}` : `id:${Number(it.pliego_item_id)}`;
      return { ...it, ref, porcentaje: Number(it.porcentaje) };
    });
    for (const it of m.items) {
      if (it.clave ? !claves.has(it.clave) : !pliegoPorId.has(Number(it.pliego_item_id))) {
        return { error: "Hay ítems que no pertenecen al pliego de esta obra." };
      }
      if (!Number.isFinite(it.porcentaje) || it.porcentaje < 0 || it.porcentaje > 100) {
        return { error: "Hay porcentajes fuera de rango (0 a 100)." };
      }
      if (vistos.has(it.ref)) return { error: "Un ítem aparece dos veces en el mismo mes." };
      vistos.add(it.ref);
      if (it.porcentaje > 0) hayAlgo = true;
      totalPorItem.set(it.ref, (totalPorItem.get(it.ref) || 0) + it.porcentaje);
    }
  }
  if (!hayAlgo) return { error: "El replanteo no planifica nada: cargá porcentajes en algún mes." };

  for (const [ref, total] of totalPorItem) {
    const esAdicional = ref.startsWith("clave:");
    const disponible = esAdicional ? 100 : disponibleDeItem(real[Number(ref.slice(3))]);
    if (total > disponible + 0.01) {
      const nombre = esAdicional
        ? claves.get(ref.slice(6)).descripcion
        : `${pliegoPorId.get(Number(ref.slice(3))).numeroItem}`;
      return { error: `El ítem ${nombre} tiene ${r2(total)}% planificado entre todos los meses, y le falta ejecutar solo ${disponible}%.` };
    }
  }

  return { motivo, meses: mesesOrdenados, adicionales: [...claves.values()] };
}

async function guardarVersion({ obraId, version, datos, fechaCorte, padreId, avanceCorteId, pliego, t }) {
  const idPorClave = {};
  let siguienteA = pliego.filter((p) => p.origen === "adicional").length + 1;
  const creados = [];

  for (const ad of datos.adicionales) {
    // El ítem maestro es obligatorio en el pliego. La pantalla vieja mandaba
    // null y por eso el replanteo por adicional nunca funcionó. Se resuelve
    // como ya lo hace el avance de obra: el catálogo general se completa solo.
    const [general] = await ItemGeneral.findOrCreate({
      where: { nombre: ad.descripcion },
      defaults: { nombre: ad.descripcion, unidadMedida: ad.unidadMedida || "gl" },
      transaction: t,
    });
    let numero = ad.numero;
    if (!numero) {
      const usados = new Set(pliego.map((p) => String(p.numeroItem)));
      while (usados.has(`A${siguienteA}`)) siguienteA++;
      numero = `A${siguienteA++}`;
    }
    const item = await PliegoItem.create({
      obraId: Number(obraId),
      ItemGeneralId: general.id,
      numeroItem: numero,
      descripcionItem: ad.descripcion,
      unidadMedida: ad.unidadMedida || "gl",
      cantidad: r5(ad.cantidad),
      costoUnitario: r5(ad.costoUnitario),
      costoParcial: r5(Number(ad.cantidad) * Number(ad.costoUnitario)),
      origen: "adicional",
      fecha_incorporacion: esFecha(ad.fecha_incorporacion) ? ad.fecha_incorporacion : datos.meses[0].fecha_desde,
    }, { transaction: t });
    idPorClave[ad.clave] = item.id;
    pliego.push(item.toJSON());
    creados.push({ clave: ad.clave, id: item.id, numeroItem: numero });
  }

  for (const m of datos.meses) {
    const fila = await Planificacion.create({
      obraId: Number(obraId),
      nombre: `Replanteo ${version} · ${m.fecha_desde} → ${m.fecha_hasta}`,
      fecha_desde: m.fecha_desde,
      fecha_hasta: m.fecha_hasta,
      estado: "abierta",
      tipo: "replanteo",
      motivo: datos.motivo,
      version,
      fecha_corte: fechaCorte,
      planificacion_padre_id: padreId,
      avance_corte_id: avanceCorteId,
    }, { transaction: t });

    const items = m.items
      .filter((it) => it.porcentaje > 0)
      .map((it) => ({
        planificacion_id: fila.id,
        pliego_item_id: it.clave ? idPorClave[it.clave] : Number(it.pliego_item_id),
        porcentaje_planificado: r2(it.porcentaje),
      }));
    if (items.length) await PlanificacionItem.bulkCreate(items, { transaction: t });
  }

  return creados;
}

/* ======================================================
   CONTEXTO: todo lo que necesita la grilla del replanteo
====================================================== */
router.get(
  "/:obraId/replanteos/contexto",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]),
  async (req, res) => {
    try {
      const { obraId } = req.params;
      const base = await cargarObra(obraId);
      if (!base) return res.status(404).json({ message: "Obra no encontrada" });
      const { obra, pliego, versiones, avances, avanceItems } = base;

      const ultima = versiones.length ? versiones[versiones.length - 1] : null;
      let editando = null;
      if (req.query.version !== undefined) {
        editando = versiones.find((v) => v.version === Number(req.query.version) && v.version > 0);
        if (!editando) return res.status(404).json({ message: "Replanteo no encontrado" });
      }

      const fechaCorte = editando ? editando.fecha_corte : ultimoCorte(avances);
      const real = avancePorItemHasta(avances, avanceItems, fechaCorte);
      const presupuesto = pliego.reduce((s, p) => s + Number(p.costoParcial || 0), 0);

      const items = [...pliego].sort(porNumero).map((p) => {
        const costo = Number(p.costoParcial || 0);
        return {
          id: p.id,
          numeroItem: p.numeroItem,
          descripcionItem: p.descripcionItem,
          unidadMedida: p.unidadMedida,
          cantidad: Number(p.cantidad || 0),
          costoParcial: costo,
          origen: p.origen || "original",
          incidencia: presupuesto > 0 ? r2((costo / presupuesto) * 100) : 0,
          avance_real: r2(real[p.id] || 0),
          disponible: disponibleDeItem(real[p.id]),
        };
      });

      const avanceRealObra = presupuesto > 0
        ? r2(items.reduce((s, i) => s + (Math.min(100, i.avance_real) / 100) * i.costoParcial, 0) / presupuesto * 100)
        : 0;

      let version = null;
      if (editando) {
        const filasItems = await PlanificacionItem.findAll({
          where: { planificacion_id: editando.filas.map((f) => f.id) }, raw: true,
        });
        version = {
          version: editando.version,
          motivo: editando.motivo,
          fecha_corte: editando.fecha_corte,
          editable: editando.version === ultima.version,
          meses: editando.filas.map((f) => ({
            fecha_desde: norm(f.fecha_desde),
            fecha_hasta: norm(f.fecha_hasta),
            items: filasItems
              .filter((i) => i.planificacion_id === f.id)
              .map((i) => ({ pliego_item_id: i.pliego_item_id, porcentaje: Number(i.porcentaje_planificado) })),
          })),
        };
      }

      return res.json({
        obra: { id: obra.id, nombre: obra.nombre },
        fecha_corte: fechaCorte,
        ultimo_avance: ultimoCorte(avances),
        avance_real_obra: avanceRealObra,
        presupuesto_total: r2(presupuesto),
        items,
        version,
        proxima_version: (ultima?.version || 0) + 1,
        version_vigente: ultima?.version ?? null,
        plan_vigente_hasta: ultima?.fecha_hasta || null,
        versiones: versiones.map((v) => ({
          version: v.version, tipo: v.tipo, motivo: v.motivo, fecha_corte: v.fecha_corte,
          fecha_desde: v.fecha_desde, fecha_hasta: v.fecha_hasta, meses: v.filas.length,
        })),
      });
    } catch (error) {
      console.error("Error contexto replanteo:", error);
      return res.status(500).json({ message: "Error al preparar el replanteo" });
    }
  }
);

/* ======================================================
   CREAR la versión siguiente
====================================================== */
router.post(
  "/:obraId/replanteos",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId } = req.params;
      // La obra se bloquea mientras dura: dos replanteos simultáneos no pueden
      // tomar el mismo número de versión.
      const base = await cargarObra(obraId, t);
      if (!base) { await t.rollback(); return res.status(404).json({ message: "Obra no encontrada" }); }
      const { pliego, versiones, avances, avanceItems } = base;

      const fechaCorte = norm(req.body.fecha_corte);
      const ultima = versiones.length ? versiones[versiones.length - 1] : null;
      if (ultima && ultima.version > 0 && fechaCorte && fechaCorte < ultima.fecha_corte) {
        await t.rollback();
        return res.status(400).json({
          message: `El corte no puede ser anterior al del replanteo vigente (${ultima.fecha_corte}).`,
        });
      }

      const real = avancePorItemHasta(avances, avanceItems, fechaCorte);
      const datos = validarVersion({ body: req.body, fechaCorte, pliego, real });
      if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

      const version = (ultima?.version || 0) + 1;
      const avanceCorte = avances
        .filter((a) => cierreDeAvance(a) <= fechaCorte)
        .sort((a, b) => (cierreDeAvance(a) < cierreDeAvance(b) ? 1 : -1))[0];

      const adicionales = await guardarVersion({
        obraId, version, datos, fechaCorte, pliego, t,
        // Queda encadenado a la versión que reemplaza. Antes estos dos campos
        // existían en la tabla pero la pantalla nunca los mandaba.
        padreId: ultima?.filas[0]?.id || null,
        avanceCorteId: avanceCorte?.id || null,
      });

      await t.commit();
      return res.status(201).json({
        ok: true, version, meses: datos.meses.length, adicionales,
        message: `Replanteo ${version} guardado`,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error creando replanteo:", error);
      return res.status(500).json({ message: "Error al guardar el replanteo" });
    }
  }
);

/* ======================================================
   EDITAR la versión vigente (se reemplaza entera)
====================================================== */
router.put(
  "/:obraId/replanteos/:version",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId } = req.params;
      const base = await cargarObra(obraId, t);
      if (!base) { await t.rollback(); return res.status(404).json({ message: "Obra no encontrada" }); }
      const { pliego, versiones, avances, avanceItems } = base;

      const objetivo = versiones.find((v) => v.version === Number(req.params.version) && v.version > 0);
      if (!objetivo) { await t.rollback(); return res.status(404).json({ message: "Replanteo no encontrado" }); }
      if (objetivo.version !== versiones[versiones.length - 1].version) {
        await t.rollback();
        return res.status(400).json({
          message: "Solo se puede editar el replanteo vigente. Los anteriores quedan como historia de lo que se prometió.",
        });
      }

      // El corte no se cambia al editar: define qué estaba ejecutado cuando se
      // replanteó. Para otro corte, se hace un replanteo nuevo.
      const fechaCorte = objetivo.fecha_corte;
      const real = avancePorItemHasta(avances, avanceItems, fechaCorte);
      const datos = validarVersion({ body: req.body, fechaCorte, pliego, real });
      if (datos.error) { await t.rollback(); return res.status(400).json({ message: datos.error }); }

      const ids = objetivo.filas.map((f) => f.id);
      await PlanificacionItem.destroy({ where: { planificacion_id: ids }, transaction: t });
      await Planificacion.destroy({ where: { id: ids }, transaction: t });

      const adicionales = await guardarVersion({
        obraId, version: objetivo.version, datos, fechaCorte, pliego, t,
        padreId: objetivo.filas[0].planificacion_padre_id || null,
        avanceCorteId: objetivo.filas[0].avance_corte_id || null,
      });

      await t.commit();
      return res.json({
        ok: true, version: objetivo.version, meses: datos.meses.length, adicionales,
        message: `Replanteo ${objetivo.version} actualizado`,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error editando replanteo:", error);
      return res.status(500).json({ message: "Error al editar el replanteo" });
    }
  }
);

/* ======================================================
   BORRAR la versión vigente
====================================================== */
router.delete(
  "/:obraId/replanteos/:version",
  authMiddleware,
  hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { obraId } = req.params;
      const base = await cargarObra(obraId, t);
      if (!base) { await t.rollback(); return res.status(404).json({ message: "Obra no encontrada" }); }
      const { pliego, versiones } = base;

      const objetivo = versiones.find((v) => v.version === Number(req.params.version) && v.version > 0);
      if (!objetivo) { await t.rollback(); return res.status(404).json({ message: "Replanteo no encontrado" }); }
      if (objetivo.version !== versiones[versiones.length - 1].version) {
        await t.rollback();
        return res.status(400).json({ message: "Solo se puede borrar el replanteo vigente (el último)." });
      }

      const ids = objetivo.filas.map((f) => f.id);
      const itemsUsados = await PlanificacionItem.findAll({ where: { planificacion_id: ids }, raw: true, transaction: t });
      const adicionalesUsados = new Set(
        itemsUsados.map((i) => i.pliego_item_id).filter((id) => pliego.find((p) => p.id === id)?.origen === "adicional")
      );

      await PlanificacionItem.destroy({ where: { planificacion_id: ids }, transaction: t });
      await Planificacion.destroy({ where: { id: ids }, transaction: t });
      await t.commit();

      return res.json({
        ok: true,
        message: `Replanteo ${objetivo.version} borrado`,
        // Los ítems adicionales NO se borran solos: pueden tener avance o
        // certificación cargados. Se avisa para que se decida desde el pliego.
        adicionales_en_pliego: adicionalesUsados.size,
      });
    } catch (error) {
      await t.rollback();
      console.error("Error borrando replanteo:", error);
      return res.status(500).json({ message: "Error al borrar el replanteo" });
    }
  }
);

export default router;
