// SUBCONTRATOS — circuito propio del subcontratista.
//
// Reproduce el caso real de la planilla de Carlos Loza (OC N° 3, Paul Groussac),
// donde se encontraron tres errores que el sistema tiene que evitar:
//   · el % de avance ponderaba un rango fijo de filas: en el certificado 17
//     informaba 14,31% cuando el real era 23,86%
//   · el "anterior" se copiaba a mano y en varios certificados no cerraba
//   · al cambiar un precio, lo ya certificado se re-valuaba
//
// OC de Loza:
//   S1 Demolición de cubierta  332 m2 × 4.400    =  1.460.800   (del pliego)
//   S2 Encadenados              40 m3 × 115.000  =  4.600.000   (del pliego)
//   S3 Tabique 0,18           2000 m2 × 6.000    = 12.000.000   (del pliego)
//   S4 Descarga de materiales    3 un × 25.000   =     75.000   (NO está en el pliego)
//                                                 18.135.800
//
// Corre SOLO contra una base local de prueba. Ver pruebas/LEEME.md.
import { sequelize } from "../database.js";
import jwt from "jsonwebtoken";
import fs from "fs";
import { fileURLToPath } from "url";
import * as _path from "path";

const _RAIZ = _path.join(_path.dirname(fileURLToPath(import.meta.url)), "..");

const host = String(process.env.DB_HOST || "").toLowerCase();
if (!["localhost", "127.0.0.1"].includes(host) || !/prueba/i.test(process.env.DB_NAME || "")) {
  console.error("⛔ Solo contra una base LOCAL cuyo nombre diga 'prueba'.");
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:3080/api";
const SECRET = fs.readFileSync(_path.join(_RAIZ, ".env"), "utf8").match(/^JWT_SECRET=(.*)$/m)[1].trim();
const TK = jwt.sign({ id: 1, email: "t@t.com", nombre: "T", rol: "admin" }, SECRET, { expiresIn: "1h" });

let ok = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n} ${d}`); fail++; } };
const cerca = (a, b, tol = 0.02) => a != null && Math.abs(Number(a) - Number(b)) < tol;

const req = async (m, ruta, body) => {
  const r = await fetch(API + ruta, {
    method: m, headers: { Authorization: `Bearer ${TK}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};
const sql = async (q) => { const [r] = await sequelize.query(q); return r; };

const SUF = "SC" + Date.now().toString().slice(-6);
let obraId = null, otraObra = null, subId = null;
const p = {}, s = {};

try {
  console.log("=== Preparando la obra y su pliego ===");
  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('SUBCONTRATO ${SUF}', 0, NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('OTRA ${SUF}', 0, NOW(), NOW())`);
  otraObra = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  if (!(await sql("SELECT id FROM itemgenerals LIMIT 1")).length) {
    await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt) VALUES ('Generico ${SUF}', 'gl', NOW(), NOW())`);
  }
  const gen = (await sql("SELECT id FROM itemgenerals LIMIT 1"))[0].id;
  for (const [k, desc, u, q, c] of [
    ["P1", "DEMOLICION DE CUBIERTA METALICA", "m2", 400, 5000],
    ["P2", "ENCADENADOS HORIZONTAL Y VERTICAL", "m3", 50, 130000],
    ["P3", "TABIQUE LAD. CERAMICO 0,18 m", "m2", 2000, 7000],
  ]) {
    await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
               VALUES (${obraId}, ${gen}, '${k}', '${desc}', '${u}', ${q}, ${c}, ${q * c}, 'original')`);
    p[k] = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  }
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
             VALUES (${otraObra}, ${gen}, 'X', 'Ajeno', 'gl', 1, 1, 1, 'original')`);
  p.ajeno = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  // Para comprobar que el circuito del sub NO toca las curvas de la obra.
  const curvaAntes = (await req("GET", `/obras/${obraId}/curva-avance`)).data;

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== La orden de compra ===");
  const oc = (items) => ({
    subcontratista: "Loza, Carlos", cuit: "20-12345678-9", numero_oc: "3",
    fecha_contrato: "2026-02-02", fecha_inicio: "2026-02-09", periodicidad: "quincenal", items,
  });
  const itemsOC = [
    { pliego_item_id: p.P1, cantidad: 332, precio_unitario: 4400 },
    { pliego_item_id: p.P2, cantidad: 40, precio_unitario: 115000 },
    { pliego_item_id: p.P3, cantidad: 2000, precio_unitario: 6000 },
    { descripcion: "Descarga de materiales provenientes de Icaño", unidad: "un", cantidad: 3, precio_unitario: 25000 },
  ];
  let r = await req("POST", `/obras/${obraId}/subcontratos`, oc([{ pliego_item_id: p.ajeno, cantidad: 1, precio_unitario: 1 }]));
  check("un ítem del pliego de OTRA obra se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos`, oc([itemsOC[0], itemsOC[0]]));
  check("el mismo ítem del pliego dos veces se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos`, oc([{ descripcion: "Sin cantidad", cantidad: 0, precio_unitario: 10 }]));
  check("un ítem sin cantidad se rechaza", r.status === 400, `→ ${r.status}`);

  r = await req("POST", `/obras/${obraId}/subcontratos`, oc(itemsOC));
  check("la OC se crea con 3 ítems del pliego y 1 propio", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  subId = r.data.id;

  let det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  for (const it of det.items) s[it.pliego_item_id === p.P1 ? "S1" : it.pliego_item_id === p.P2 ? "S2" : it.pliego_item_id === p.P3 ? "S3" : "S4"] = it.id;
  check("los ítems del pliego heredan número, descripción y unidad", det.items.find((i) => i.id === s.S1)?.unidad === "m2" && det.items.find((i) => i.id === s.S1)?.numero === "P1");
  check("pero con cantidad y precio PROPIOS del sub", cerca(det.items.find((i) => i.id === s.S1)?.precio_unitario, 4400) && cerca(det.items.find((i) => i.id === s.S1)?.cantidad, 332));
  check("el ítem propio no tiene ítem de pliego", det.items.find((i) => i.id === s.S4)?.pliego_item_id === null);
  check("total del contrato $18.135.800", cerca(det.resumen.totales.contrato, 18135800), `→ ${det.resumen.totales.contrato}`);

  r = await req("GET", `/obras/${obraId}/subcontratos-pliego`);
  check("el pliego marca en qué subcontrato ya está cada ítem",
    r.data.find((x) => x.id === p.P1)?.en_subcontratos?.[0]?.subcontratista === "Loza, Carlos");

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== El plan de trabajo, por período ===");
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/plan`);
  check("sin plan, propone quincenas desde el inicio", r.data.propuesto === true && r.data.periodos[0].desde === "2026-02-09" && r.data.periodos[0].hasta === "2026-02-22",
    `→ ${JSON.stringify(r.data.periodos?.[0])}`);
  const plan = [
    { desde: "2026-02-09", hasta: "2026-02-22", items: [{ subcontrato_item_id: s.S1, cantidad: 332 }, { subcontrato_item_id: s.S3, cantidad: 300 }] },
    { desde: "2026-02-23", hasta: "2026-03-08", items: [{ subcontrato_item_id: s.S3, cantidad: 500 }, { subcontrato_item_id: s.S2, cantidad: 20 }] },
    { desde: "2026-03-09", hasta: "2026-03-22", items: [{ subcontrato_item_id: s.S2, cantidad: 20 }, { subcontrato_item_id: s.S4, cantidad: 3 }, { subcontrato_item_id: s.S3, cantidad: 1200 }] },
  ];
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/plan`, {
    periodos: plan.map((x, i) => (i === 2 ? { ...x, items: [...x.items.slice(0, 2), { subcontrato_item_id: s.S3, cantidad: 1300 }] } : x)),
  });
  check("planificar más de lo contratado se rechaza", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/plan`, { periodos: [plan[0], { ...plan[1], desde: "2026-02-20" }] });
  check("dos períodos que se pisan se rechazan", r.status === 400, `→ ${r.status}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/plan`, { periodos: plan });
  check("el plan de 3 quincenas se guarda", r.status === 200, `→ ${r.status} ${r.data?.message}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Certificado N° 1 ===");
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/nuevo`);
  check("la planilla en blanco sugiere N° 1 y la primera quincena", r.data.certificado.numero === 1 && r.data.certificado.desde === "2026-02-09" && r.data.certificado.hasta === "2026-02-22",
    `→ ${JSON.stringify(r.data.certificado)}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-02-09", hasta: "2026-02-20",
    items: [{ subcontrato_item_id: s.S1, cantidad: 332 }, { subcontrato_item_id: s.S3, cantidad: 240 }],
  });
  check("se certifica", r.status === 201 && r.data.numero === 1, `→ ${r.status} ${r.data?.message}`);
  const c1 = r.data.id;
  let pl = (await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/${c1}`)).data;
  check("importe del certificado $2.900.800", cerca(pl.totales.importe.actual, 2900800), `→ ${pl.totales.importe.actual}`);
  check("el avance pondera TODOS los ítems: 15,99%", cerca(pl.totales.avance.acumulado, 15.99, 0.02), `→ ${pl.totales.avance.acumulado}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Cambia el precio del tabique (6.000 → 6.500) ===");
  const conPrecioNuevo = det.items.map((it) => ({
    id: it.id, pliego_item_id: it.pliego_item_id, numero: it.numero, descripcion: it.descripcion,
    unidad: it.unidad, cantidad: it.cantidad, precio_unitario: it.id === s.S3 ? 6500 : it.precio_unitario, origen: it.origen,
  }));
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc(conPrecioNuevo));
  check("el precio se actualiza", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  pl = (await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/${c1}`)).data;
  check("el certificado 1 NO se re-valúa: sigue en $2.900.800", cerca(pl.totales.importe.actual, 2900800), `→ ${pl.totales.importe.actual}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Certificado N° 2, con descuentos ===");
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-02-15", hasta: "2026-03-06", items: [{ subcontrato_item_id: s.S3, cantidad: 10 }],
  });
  check("un período que se pisa con el anterior se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-02-23", hasta: "2026-03-06", items: [],
  });
  check("un certificado vacío se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-02-23", hasta: "2026-03-06",
    items: [{ subcontrato_item_id: s.S3, cantidad: 190 }, { subcontrato_item_id: s.S2, cantidad: 25.81 }, { subcontrato_item_id: s.S4, cantidad: 3 }],
    descuentos: [
      { tipo: "adelanto", concepto: "Adelanto del 27/02", importe: 200000 },
      { tipo: "herramientas", concepto: "Amoladora y discos", importe: 45000 },
    ],
  });
  check("se certifica", r.status === 201 && r.data.numero === 2, `→ ${r.status} ${r.data?.message}`);
  const c2 = r.data.id;
  pl = (await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/${c2}`)).data;
  const fS3 = pl.filas.find((f) => f.id === s.S3);
  check("el ANTERIOR del tabique es lo del certificado 1 (240)", cerca(fS3.cantidad.anterior, 240), `→ ${fS3.cantidad.anterior}`);
  check("con el importe al precio de ENTONCES ($1.440.000)", cerca(fS3.importe.anterior, 1440000), `→ ${fS3.importe.anterior}`);
  check("lo actual se paga al precio nuevo: 190 × 6.500", cerca(fS3.importe.actual, 1235000), `→ ${fS3.importe.actual}`);
  check("el acumulado suma lo pagado ($2.675.000), no 430 × 6.500", cerca(fS3.importe.acumulado, 2675000), `→ ${fS3.importe.acumulado}`);
  check("importe del certificado $4.278.150", cerca(pl.totales.importe.actual, 4278150), `→ ${pl.totales.importe.actual}`);
  check("descuentos $245.000", cerca(pl.totales.descuentos, 245000), `→ ${pl.totales.descuentos}`);
  check("a pagar $4.033.150", cerca(pl.totales.a_pagar, 4033150), `→ ${pl.totales.a_pagar}`);
  check("el ítem que no es del pliego también se certifica", cerca(pl.filas.find((f) => f.id === s.S4).cantidad.actual, 3));

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Certificado N° 3: se hace MÁS de lo contratado ===");
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-03-09", hasta: "2026-03-20", items: [{ subcontrato_item_id: s.S1, cantidad: 10 }, { subcontrato_item_id: s.S3, cantidad: 300 }],
  });
  check("el excedente se registra (no se rechaza)", r.status === 201, `→ ${r.status}`);
  check("y se avisa", r.data?.hay_excedentes === true && cerca(r.data?.avisos?.[0]?.excedente, 10), `→ ${JSON.stringify(r.data?.avisos)}`);
  const c3 = r.data.id;

  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  const rS1 = det.resumen.items.find((i) => i.id === s.S1);
  check("la demolición queda con 10 m2 de excedente", cerca(rS1.excedente, 10), `→ ${rS1.excedente}`);
  check("valorizado $44.000", cerca(rS1.excedente_importe, 44000), `→ ${rS1.excedente_importe}`);
  check("pero su avance no pasa del 100%", cerca(rS1.avance, 100), `→ ${rS1.avance}`);
  check("las estadísticas cuentan el excedente", cerca(det.resumen.totales.excedentes, 44000) && det.resumen.totales.items_con_excedente === 1,
    `→ ${det.resumen.totales.excedentes}`);

  console.log("\n=== Estadísticas: acordado, avanzado, pendiente ===");
  const tot = det.resumen.totales;
  const contrato = 1460800 + 4600000 + 13000000 + 75000; // con el tabique ya a 6.500
  check("contrato $19.135.800", cerca(tot.contrato, contrato), `→ ${tot.contrato}`);
  check("certificado = suma de lo pagado en los 3 certificados", cerca(tot.certificado, 2900800 + 4278150 + 44000 + 1950000), `→ ${tot.certificado}`);
  check("descuentos $245.000 y neto pagado", cerca(tot.descuentos, 245000) && cerca(tot.neto_pagado, tot.certificado - 245000));
  const rS3 = det.resumen.items.find((i) => i.id === s.S3);
  check("tabique: 730 certificados, 1.270 pendientes", cerca(rS3.certificado, 730) && cerca(rS3.pendiente, 1270), `→ ${rS3.certificado} / ${rS3.pendiente}`);
  check("pendiente del tabique valorizado al precio vigente", cerca(rS3.pendiente_importe, 1270 * 6500), `→ ${rS3.pendiente_importe}`);
  check("hay plan: planificado a hoy y desvío", tot.planificado_hoy !== null && tot.desvio !== null, `→ ${tot.planificado_hoy} / ${tot.desvio}`);
  check("la curva del sub tiene un punto por período del plan", det.resumen.curva.length === 3 && det.resumen.curva[2].planificado <= 100.01,
    `→ ${JSON.stringify(det.resumen.curva)}`);
  check("el plan completo llega a 100%", cerca(det.resumen.curva[2].planificado, 100, 0.05), `→ ${det.resumen.curva[2].planificado}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Adicional a la OC ===");
  const conAdicional = [
    ...det.items.map((it) => ({ id: it.id, pliego_item_id: it.pliego_item_id, numero: it.numero, descripcion: it.descripcion,
      unidad: it.unidad, cantidad: it.cantidad, precio_unitario: it.precio_unitario, origen: it.origen })),
    { descripcion: "Adicional de excavación cimientos a mano", unidad: "m3", cantidad: 216.19, precio_unitario: 4600, origen: "adicional" },
  ];
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc(conAdicional));
  check("se agrega el adicional", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  check("el contrato crece en $994.474", cerca(det.resumen.totales.contrato, contrato + 994474), `→ ${det.resumen.totales.contrato}`);
  check("y se distingue: original vs adicionales", cerca(det.resumen.totales.contrato_original, contrato) && cerca(det.resumen.totales.adicionales, 994474));
  check("el adicional va al final de la OC", det.items[det.items.length - 1].origen === "adicional");

  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc(conAdicional.filter((i) => i.id !== s.S3)));
  check("no se puede sacar un ítem que ya tiene certificados", r.status === 400, `→ ${r.status}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Solo se corrige o anula el ÚLTIMO certificado ===");
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c2}`, {
    desde: "2026-02-23", hasta: "2026-03-06", items: [{ subcontrato_item_id: s.S3, cantidad: 1 }],
  });
  check("corregir uno del medio se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados/${c2}/anular`);
  check("anular uno del medio se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`, {
    desde: "2026-03-09", hasta: "2026-03-20", items: [{ subcontrato_item_id: s.S3, cantidad: 280 }],
  });
  check("el último se corrige", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}/anular`);
  check("y se anula", r.status === 200, `→ ${r.status}`);
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/nuevo`);
  check("el siguiente es el N° 4 y retoma después del N° 2", r.data.certificado.numero === 4 && r.data.certificado.desde === "2026-03-07",
    `→ ${JSON.stringify(r.data.certificado)}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  check("el anulado deja de contar", det.resumen.totales.certificados === 2 && cerca(det.resumen.items.find((i) => i.id === s.S3).certificado, 430));

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Aparte de la obra ===");
  const curvaDespues = (await req("GET", `/obras/${obraId}/curva-avance`)).data;
  check("las curvas de la obra no cambiaron", JSON.stringify(curvaAntes.avance) === JSON.stringify(curvaDespues.avance)
    && JSON.stringify(curvaAntes.certificado) === JSON.stringify(curvaDespues.certificado));
  const lista = (await req("GET", `/obras/${obraId}/subcontratos`)).data;
  check("la lista de la obra muestra el subcontrato con sus números", lista.length === 1 && lista[0].totales?.contrato > 0);

  r = await req("DELETE", `/obras/${obraId}/subcontratos/${subId}`);
  check("un subcontrato con certificados no se borra", r.status === 400, `→ ${r.status}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (subId) {
    await sql(`DELETE FROM subcontrato_descuentos WHERE certificado_id IN (SELECT id FROM subcontrato_certificados WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_certificado_items WHERE certificado_id IN (SELECT id FROM subcontrato_certificados WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_certificados WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontrato_plan_items WHERE plan_periodo_id IN (SELECT id FROM subcontrato_plan_periodos WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_plan_periodos WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontrato_items WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontratos WHERE id = ${subId}`);
  }
  for (const o of [obraId, otraObra]) {
    if (!o) continue;
    await sql(`DELETE FROM subcontratos WHERE obra_id = ${o}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${o}`);
    await sql(`DELETE FROM obras WHERE id = ${o}`);
  }
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}%'`);
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedó basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
