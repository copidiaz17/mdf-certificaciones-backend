// API para que otros sistemas lean lo de acá.
//
// La usa el sistema de costos/contabilidad. Hasta ahora se conectaba a esta
// base por MySQL directo, lo que ata los dos sistemas al esquema: una columna
// que se renombra acá rompe allá sin aviso. Con una API de por medio, lo que
// se promete es la respuesta, no la tabla.
//
// ── Qué expone, y sobre todo qué NO ──────────────────────────────────────
//
// Cruzan tres cosas: LO PLANIFICADO (el pliego), LO CERTIFICADO, y el avance
// TOPADO A LO PLANIFICADO.
//
// EL EXCEDENTE NO CRUZA. Nunca.
//
// Lo ejecutado por encima del pliego —200 m3 de excavación donde había 50— no
// es todavía de la empresa: es un reclamo que se negocia después con la
// Municipalidad o con Arquitectura, y puede terminar reconocido entero, en
// parte, o no reconocido. Mandarlo al sistema de contabilidad lo pondría a un
// paso de convertirse en un activo, y contablemente no lo es hasta que lo
// reconozcan. La RT 54 y la NIIF 15 dicen lo mismo sobre la contraprestación
// variable: se reconoce cuando es altamente probable que no haya que dar
// marcha atrás, y un excedente sin negociar no llega a esa vara.
//
// El excedente vive de este lado, en la pantalla de excedentes, hasta que se
// convierte en un ítem del pliego con precio. Recién ahí cruza, y cruza como
// lo que es: un ítem contratado.
//
// Con lo que sí cruza alcanza para el informe de obra en curso (WIP) que la
// RT 54 exige desde los ejercicios iniciados el 1/1/2025:
//   · precio de contrato     → el pliego
//   · avance reconocido      → los avances, topados al 100% de cada ítem
//   · certificado a la fecha → las certificaciones
// El costo incurrido lo tiene el sistema de costos.
//
// La diferencia entre lo ejecutado y lo certificado es la que importa, y por
// eso el avance sí cruza aunque topado: sin él, ejecutado y certificado serían
// siempre iguales y no habría manera de ver el desfasaje.
//   ejecutado > certificado  → trabajo hecho y no facturado (activo)
//   certificado > ejecutado  → cobrado por adelantado (pasivo)
//
// ── Autenticación ────────────────────────────────────────────────────────
// Token compartido en la cabecera X-API-Token, contra API_TOKEN del .env.
// Es de sistema a sistema, no de persona: no hay usuario ni sesión. Si el
// token no está configurado, la API queda CERRADA en vez de abierta — un
// endpoint que se abre solo porque falta una variable de entorno es la manera
// más fácil de publicar los números de la empresa sin querer.

import express from "express";
import { Op } from "sequelize";
import PliegoItem from "../models/PliegoItem.js";
import AvanceObra from "../models/AvanceObra.js";
import AvanceObraItem from "../models/AvanceObraItem.js";
import Certificacion from "../models/Certificacion.js";
import CertificacionItem from "../models/CertificacionItem.js";
import Obra from "../models/Obra.js";

const router = express.Router();

// Si este sistema permite anular certificados. MDF si, Falube todavia no.
// Cuando Falube lo agregue, esto lo detecta solo.
const TIENE_ANULADA = Boolean(Certificacion.rawAttributes?.anulada);


const aNumero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r5 = (n) => Math.round((Number(n) || 0) * 100000) / 100000;

function soloConToken(req, res, next) {
  const esperado = process.env.API_TOKEN;
  if (!esperado) {
    return res.status(503).json({
      error:
        "La API entre sistemas no está habilitada en este servidor. " +
        "Falta configurar API_TOKEN en el .env.",
    });
  }
  const recibido = req.get("X-API-Token") || "";
  if (recibido !== esperado) {
    return res.status(401).json({ error: "Token inválido" });
  }
  next();
}

router.use(soloConToken);

// ── GET /api/publica/obras ───────────────────────────────────────────────
// Las obras, para que el otro sistema pueda mapearlas contra las suyas.
router.get("/obras", async (req, res) => {
  try {
    const obras = await Obra.findAll({ order: [["nombre", "ASC"]] });
    res.json({
      obras: obras.map((o) => ({
        id: o.id,
        nombre: o.nombre,
        reparticion: o.reparticion ?? null,
        ubicacion: o.ubicacion ?? null,
      })),
    });
  } catch (e) {
    console.error("API pública / obras:", e);
    res.status(500).json({ error: "Error al obtener las obras" });
  }
});

// ── GET /api/publica/obras/:obraId/avance ────────────────────────────────
// El estado de la obra, ítem por ítem: lo contratado, lo ejecutado y lo
// certificado. Es la materia prima del WIP.
router.get("/obras/:obraId/avance", async (req, res) => {
  try {
    const { obraId } = req.params;

    const obra = await Obra.findByPk(obraId);
    if (!obra) return res.status(404).json({ error: "La obra no existe" });

    const pliego = await PliegoItem.findAll({ where: { obraId }, order: [["numeroItem", "ASC"]] });
    if (pliego.length === 0) {
      return res.json({ obra: { id: obra.id, nombre: obra.nombre }, items: [], totales: vacio() });
    }

    // ── Avance físico acumulado por ítem ────────────────────────────────
    const avances = await AvanceObra.findAll({ where: { obra_id: obraId }, attributes: ["id", "fecha_avance"] });
    const idsAvance = avances.map((a) => a.id);
    const avanceItems = idsAvance.length
      ? await AvanceObraItem.findAll({ where: { avance_obra_id: { [Op.in]: idsAvance } } })
      : [];

    const ejecutado = new Map();
    for (const i of avanceItems) {
      const previo = ejecutado.get(i.pliego_item_id) || { porcentaje: 0, cantidad: 0 };
      previo.porcentaje += aNumero(i.avance_porcentaje);
      previo.cantidad += aNumero(i.cantidad_ejecutada);
      ejecutado.set(i.pliego_item_id, previo);
    }

    // ── Certificado acumulado por ítem (sin las anuladas) ────────────────
    const certificaciones = await Certificacion.findAll({
      where: { obra_id: obraId },
      // Se pregunta al modelo en vez de asumir: el sistema de Falube todavia
      // no permite anular un certificado y no tiene la columna. Pedirla igual
      // fallaria con "Unknown column 'anulada'".
      attributes: ["id", "fecha_certificacion", ...(TIENE_ANULADA ? ["anulada"] : [])],
    });
    const idsCert = certificaciones.filter((c) => !c.anulada).map((c) => c.id);
    const certItems = idsCert.length
      ? await CertificacionItem.findAll({ where: { CertificacionId: { [Op.in]: idsCert } } })
      : [];

    const certificado = new Map();
    for (const i of certItems) {
      const previo = certificado.get(i.PliegoItemId) || { porcentaje: 0, importe: 0 };
      previo.porcentaje += aNumero(i.avance_porcentaje);
      previo.importe += aNumero(i.importe);
      certificado.set(i.PliegoItemId, previo);
    }

    // ── Armar la respuesta ──────────────────────────────────────────────
    const items = [];
    const totales = vacio();

    for (const p of pliego) {
      const precio = aNumero(p.costoParcial);
      const cantidadPliego = aNumero(p.cantidad);
      const eje = ejecutado.get(p.id) || { porcentaje: 0, cantidad: 0 };
      const cer = certificado.get(p.id) || { porcentaje: 0, importe: 0 };

      // ── EL TOPE ──────────────────────────────────────────────────────
      // El avance cruza topado a lo planificado. Lo ejecutado de más se queda
      // de este lado hasta que se negocie: no es de la empresa todavía.
      const avancePct = Math.min(eje.porcentaje, 100);
      const avanceCantidad = cantidadPliego > 0 ? Math.min(eje.cantidad, cantidadPliego) : eje.cantidad;
      const ejecutadoImporte = r2((precio * avancePct) / 100);

      items.push({
        pliego_item_id: p.id,
        numero_item: p.numeroItem,
        descripcion: p.descripcionItem,
        unidad: p.unidadMedida || "",
        origen: p.origen,
        item_origen_id: p.item_origen_id ?? null,
        // Un ítem nacido de un excedente entra recién cuando le ponen precio.
        // Mientras tanto aporta cantidad pero no plata, que es lo correcto.
        sin_precio: precio === 0,

        cantidad_pliego: r5(cantidadPliego),
        precio_contrato: r2(precio),

        // Reconocido = topado al plan. El nombre lo dice para que nadie del
        // otro lado lo confunda con el avance físico real.
        cantidad_reconocida: r5(avanceCantidad),
        avance_reconocido_porcentaje: r2(avancePct),
        ejecutado_importe: ejecutadoImporte,

        certificado_porcentaje: r2(cer.porcentaje),
        certificado_importe: r2(cer.importe),

        // La diferencia que le importa a la contabilidad.
        diferencia: r2(ejecutadoImporte - cer.importe),
      });

      totales.precio_contrato += precio;
      totales.ejecutado_importe += ejecutadoImporte;
      totales.certificado_importe += cer.importe;
      if (precio === 0) totales.items_sin_precio++;
    }

    for (const k of ["precio_contrato", "ejecutado_importe", "certificado_importe"]) {
      totales[k] = r2(totales[k]);
    }
    // El grado de avance de la obra: ejecutado sobre contratado, ponderado por
    // el peso de cada ítem. Es el número que pide la RT 54.
    totales.avance_porcentaje =
      totales.precio_contrato > 0 ? r2((totales.ejecutado_importe / totales.precio_contrato) * 100) : 0;
    totales.diferencia = r2(totales.ejecutado_importe - totales.certificado_importe);
    totales.interpretacion =
      totales.diferencia > 0
        ? "Hay trabajo ejecutado que todavía no se certificó: es un activo (derechos a facturar)."
        : totales.diferencia < 0
        ? "Se certificó más de lo ejecutado: es un pasivo (cobrado por adelantado)."
        : "Lo ejecutado y lo certificado coinciden.";

    res.json({
      obra: { id: obra.id, nombre: obra.nombre },
      items,
      totales,
      // Que quede dicho en la respuesta y no solo en el código: quien consuma
      // esto tiene que saber qué está recibiendo y qué no.
      alcance:
        "El avance viene TOPADO a lo planificado en el pliego. Lo ejecutado por " +
        "encima no se informa: es un reclamo a negociar con el comitente y no es " +
        "un activo hasta que lo reconozcan. Cuando se reconoce, entra como un " +
        "ítem más del pliego con su precio.",
      ultimo_avance: avances.length
        ? avances.map((a) => a.fecha_avance).sort().pop()
        : null,
      ultima_certificacion: certificaciones.length
        ? certificaciones.map((c) => c.fecha_certificacion).sort().pop()
        : null,
    });
  } catch (e) {
    console.error("API pública / avance:", e);
    res.status(500).json({ error: "Error al obtener el avance de la obra" });
  }
});

function vacio() {
  return {
    precio_contrato: 0,
    ejecutado_importe: 0,
    certificado_importe: 0,
    // Ítems del pliego que todavía no tienen precio (excedentes reconocidos
    // pero sin negociar). Aportan cantidad, no plata.
    items_sin_precio: 0,
    avance_porcentaje: 0,
    diferencia: 0,
  };
}

// ── GET /api/publica/obras/:obraId/certificados ──────────────────────────
// Los certificados de una obra: lo que el sistema de costos necesita para
// armar la factura sin que nadie vuelva a tipear los números.
//
// Van los TRES importes, porque son tres cosas distintas y confundirlas
// factura mal:
//   subtotal           lo certificado bruto
//   deduccion_anticipo la devolución del anticipo financiero
//   total_neto         lo que la obra termina cobrando
//
// El importe a facturar NO es ninguno de los tres: es subtotal menos la
// devolución del anticipo. Ese cálculo lo hace costos, que es donde vive la
// regla de cada repartición. Acá se mandan los insumos, no la conclusión.
//
// Las ANULADAS también van, marcadas: si un certificado se anula después de
// que costos lo importó, el otro lado tiene que enterarse. Filtrarlas acá
// dejaría del otro lado una factura pendiente de un certificado que ya no
// existe.
router.get("/obras/:obraId/certificados", async (req, res) => {
  try {
    const obra = await Obra.findByPk(req.params.obraId);
    if (!obra) return res.status(404).json({ error: "La obra no existe" });

    const certificaciones = await Certificacion.findAll({
      where: { obra_id: obra.id },
      order: [["fecha_certificacion", "ASC"], ["id", "ASC"]],
    });

    res.json({
      obra: { id: obra.id, nombre: obra.nombre, reparticion: obra.reparticion ?? null },
      certificados: certificaciones.map((c) => ({
        id: c.id,
        numero: String(c.numero_certificado),
        fecha_certificacion: c.fecha_certificacion,
        periodo_desde: c.periodo_desde,
        periodo_hasta: c.periodo_hasta,
        subtotal: r2(c.subtotal),
        deduccion_anticipo: r2(c.deduccion_anticipo),
        total_neto: r2(c.total_neto),
        anulada: Boolean(c.anulada),
      })),
    });
  } catch (e) {
    console.error("API pública / certificados:", e);
    res.status(500).json({ error: "Error al obtener los certificados" });
  }
});

export default router;
