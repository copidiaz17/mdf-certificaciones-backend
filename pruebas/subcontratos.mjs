// SUBCONTRATOS — circuito propio del subcontratista.
//
// Reproduce el caso real de la planilla de Carlos Loza (OC N° 3, Paul Groussac),
// donde se encontraron tres errores que el sistema tiene que evitar:
//   · el % de avance ponderaba un rango fijo de filas: en el certificado 17
//     informaba 14,31% cuando el real era 23,86%
//   · el "anterior" se copiaba a mano y en varios certificados no cerraba
//   · al cambiar un precio, lo ya certificado se re-valuaba
//
// El sub NO tiene plan de trabajo: el avance se registra contra la OC. Lo que
// se hace de más, o un rubro que no existía, se registra como ADICIONAL al
// certificar, previa confirmación.
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

// La OC tal como la devuelve el detalle, lista para mandarla de vuelta.
const comoOC = (items) => items.map((it) => ({
  id: it.id, pliego_item_id: it.pliego_item_id, numero: it.numero, descripcion: it.descripcion,
  unidad: it.unidad, cantidad: it.cantidad, precio_unitario: it.precio_unitario, origen: it.origen,
  tipo_adicional: it.tipo_adicional, item_origen_id: it.item_origen_id,
}));

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
  r = await req("POST", `/obras/${obraId}/subcontratos`, oc([...itemsOC, { descripcion: "Extra", cantidad: 1, precio_unitario: 1, origen: "adicional" }]));
  check("un adicional sin decir si es de más o nuevo se rechaza", r.status === 400, `→ ${r.status}`);

  r = await req("POST", `/obras/${obraId}/subcontratos`, oc(itemsOC));
  check("la OC se crea con 3 ítems del pliego y 1 propio", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  subId = r.data.id;

  let det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  for (const it of det.items) s[it.pliego_item_id === p.P1 ? "S1" : it.pliego_item_id === p.P2 ? "S2" : it.pliego_item_id === p.P3 ? "S3" : "S4"] = it.id;
  check("los ítems del pliego heredan número, descripción y unidad", det.items.find((i) => i.id === s.S1)?.unidad === "m2" && det.items.find((i) => i.id === s.S1)?.numero === "P1");
  check("pero con cantidad y precio PROPIOS del sub", cerca(det.items.find((i) => i.id === s.S1)?.precio_unitario, 4400) && cerca(det.items.find((i) => i.id === s.S1)?.cantidad, 332));
  check("el ítem propio no tiene ítem de pliego", det.items.find((i) => i.id === s.S4)?.pliego_item_id === null);
  check("total del contrato $18.135.800", cerca(det.resumen.totales.contrato, 18135800), `→ ${det.resumen.totales.contrato}`);
  check("sin certificados, avance 0 y todo pendiente", det.resumen.totales.avance === 0 && cerca(det.resumen.totales.pendiente, 18135800));

  r = await req("GET", `/obras/${obraId}/subcontratos-pliego`);
  check("el pliego marca en qué subcontrato ya está cada ítem",
    r.data.find((x) => x.id === p.P1)?.en_subcontratos?.[0]?.subcontratista === "Loza, Carlos");

  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/plan`);
  check("el sub ya NO tiene plan de trabajo", r.status === 404, `→ ${r.status}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Certificado N° 1 ===");
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/nuevo`);
  check("la planilla en blanco sugiere N° 1 y la primera quincena", r.data.certificado.numero === 1 && r.data.certificado.desde === "2026-02-09" && r.data.certificado.hasta === "2026-02-22",
    `→ ${JSON.stringify(r.data.certificado)}`);
  check("cada fila dice su clase", r.data.filas.every((f) => f.clase === "contrato"));
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, {
    desde: "2026-02-09", hasta: "2026-02-20",
    items: [{ subcontrato_item_id: s.S1, cantidad: 332 }, { subcontrato_item_id: s.S3, cantidad: 240 }],
  });
  check("se certifica sin pedir confirmación (nada de más)", r.status === 201 && r.data.numero === 1, `→ ${r.status} ${r.data?.message}`);
  const c1 = r.data.id;
  let pl = (await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/${c1}`)).data;
  check("importe del certificado $2.900.800", cerca(pl.totales.importe.actual, 2900800), `→ ${pl.totales.importe.actual}`);
  check("el avance pondera TODOS los ítems: 15,99%", cerca(pl.totales.avance.acumulado, 15.99, 0.02), `→ ${pl.totales.avance.acumulado}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Cambia el precio del tabique (6.000 → 6.500) ===");
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`,
    oc(comoOC(det.items).map((it) => (it.id === s.S3 ? { ...it, precio_unitario: 6500 } : it))));
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
  check("el ANTERIOR del tabique es lo del certificado 1 (240)", cerca(fS3.anterior.cantidad, 240), `→ ${fS3.anterior.cantidad}`);
  check("con el importe al precio de ENTONCES ($1.440.000)", cerca(fS3.anterior.importe, 1440000), `→ ${fS3.anterior.importe}`);
  check("lo actual se paga al precio nuevo: 190 × 6.500", cerca(fS3.actual.importe, 1235000), `→ ${fS3.actual.importe}`);
  check("el acumulado suma lo pagado ($2.675.000), no 430 × 6.500", cerca(fS3.anterior.importe + fS3.actual.importe, 2675000));
  check("importe del certificado $4.278.150", cerca(pl.totales.importe.actual, 4278150), `→ ${pl.totales.importe.actual}`);
  check("descuentos $245.000", cerca(pl.totales.descuentos, 245000), `→ ${pl.totales.descuentos}`);
  check("a pagar $4.033.150", cerca(pl.totales.a_pagar, 4033150), `→ ${pl.totales.a_pagar}`);
  check("el ítem que no es del pliego también se certifica", cerca(pl.filas.find((f) => f.id === s.S4).actual.cantidad, 3));

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Certificado N° 3: se hace MÁS de lo contratado y un rubro nuevo ===");
  const cert3 = {
    desde: "2026-03-09", hasta: "2026-03-20",
    items: [{ subcontrato_item_id: s.S1, cantidad: 10 }, { subcontrato_item_id: s.S3, cantidad: 300 }],
    nuevos: [{ clave: "n1", descripcion: "Limpieza final de obra", unidad: "gl", cantidad: 1, precio_unitario: 80000 }],
  };
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, cert3);
  check("sin confirmar, el servidor frena y pregunta (409)", r.status === 409 && r.data?.requiere_confirmacion === true, `→ ${r.status}`);
  const exDeMas = r.data?.extras?.find((x) => x.tipo === "de_mas");
  const exNuevo = r.data?.extras?.find((x) => x.tipo === "nuevo");
  check("avisa que la demolición se carga 10 m2 de más", exDeMas?.subcontrato_item_id === s.S1 && cerca(exDeMas?.cantidad, 10) && /de más/.test(exDeMas?.mensaje || ""),
    `→ ${JSON.stringify(exDeMas)}`);
  check("y que la limpieza es un ítem nuevo", exNuevo?.descripcion === "Limpieza final de obra" && /ítem nuevo/.test(exNuevo?.mensaje || ""), `→ ${JSON.stringify(exNuevo)}`);
  console.log(`     "${r.data?.message}"`);
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/nuevo`);
  check("no se guardó nada: el siguiente sigue siendo el N° 3", r.data.certificado.numero === 3);

  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados`, { ...cert3, confirmar_extras: true });
  check("confirmado, se certifica", r.status === 201 && r.data.numero === 3, `→ ${r.status} ${r.data?.message}`);
  check("y dice qué registró como adicional", r.data?.adicionales_registrados?.length === 2);
  const c3 = r.data.id;

  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  const nuevoItem = det.items.find((i) => i.descripcion === "Limpieza final de obra");
  check("el rubro nuevo queda en la OC como adicional · ítem nuevo",
    nuevoItem?.origen === "adicional" && nuevoItem?.tipo_adicional === "nuevo" && nuevoItem?.creado_en_certificado_id === c3 && cerca(nuevoItem?.cantidad, 1),
    `→ ${JSON.stringify(nuevoItem)}`);
  const rS1 = det.resumen.items.find((i) => i.id === s.S1);
  check("la demolición queda al 100%, sin pasarse", cerca(rS1.certificado, 332) && cerca(rS1.avance, 100), `→ ${rS1.certificado} / ${rS1.avance}`);
  const vS1 = det.resumen.items.find((i) => i.id === `de-mas-${s.S1}`);
  check("los 10 m2 de más son su propio renglón: adicional · cargado de más",
    vS1?.virtual === true && vS1?.clase === "de_mas" && /de más/.test(vS1?.etiqueta) && cerca(vS1?.certificado, 10) && cerca(vS1?.total, 44000),
    `→ ${JSON.stringify(vS1)}`);
  check("y dice qué rubro agranda", vS1?.rubro_origen === "DEMOLICION DE CUBIERTA METALICA");
  const rNuevo = det.resumen.items.find((i) => i.id === nuevoItem?.id);
  check("el ítem nuevo aparece como tal", rNuevo?.clase === "nuevo" && /ítem nuevo/.test(rNuevo?.etiqueta) && cerca(rNuevo?.total, 80000));

  pl = (await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`)).data;
  check("importe del certificado 3: 44.000 + 1.950.000 + 80.000", cerca(pl.totales.importe.actual, 2074000), `→ ${pl.totales.importe.actual}`);
  check("la planilla separa lo de más ($44.000) y lo nuevo ($80.000)", cerca(pl.totales.de_mas, 44000) && cerca(pl.totales.nuevo, 80000),
    `→ ${pl.totales.de_mas} / ${pl.totales.nuevo}`);

  console.log("\n=== Estadísticas: acordado, avanzado, pendiente, adicionales ===");
  let tot = det.resumen.totales;
  const original = 1460800 + 4600000 + 13000000 + 75000; // con el tabique ya a 6.500
  check("original de la OC $19.135.800", cerca(tot.original, original), `→ ${tot.original}`);
  check("adicionales de más $44.000", cerca(tot.de_mas, 44000), `→ ${tot.de_mas}`);
  check("adicionales nuevos $80.000", cerca(tot.nuevo, 80000), `→ ${tot.nuevo}`);
  check("acordado a la fecha = los tres ($19.259.800)", cerca(tot.contrato, original + 44000 + 80000), `→ ${tot.contrato}`);
  check("certificado = suma de lo pagado en los 3 certificados", cerca(tot.certificado, 2900800 + 4278150 + 2074000), `→ ${tot.certificado}`);
  check("descuentos $245.000 y neto pagado", cerca(tot.descuentos, 245000) && cerca(tot.neto_pagado, tot.certificado - 245000));
  check("cuenta los renglones de más y nuevos", tot.renglones_de_mas === 1 && tot.renglones_nuevos === 1, `→ ${tot.renglones_de_mas} / ${tot.renglones_nuevos}`);
  const rS3 = det.resumen.items.find((i) => i.id === s.S3);
  check("tabique: 730 certificados, 1.270 pendientes", cerca(rS3.certificado, 730) && cerca(rS3.pendiente, 1270), `→ ${rS3.certificado} / ${rS3.pendiente}`);
  check("pendiente del tabique valorizado al precio vigente", cerca(rS3.pendiente_importe, 1270 * 6500), `→ ${rS3.pendiente_importe}`);
  check("avance real 48,67%", cerca(tot.avance, 48.67, 0.02), `→ ${tot.avance}`);
  check("la curva tiene un punto por certificado, y sube", det.resumen.curva.length === 3
    && det.resumen.curva[0].avance < det.resumen.curva[1].avance && cerca(det.resumen.curva[2].avance, tot.avance),
    `→ ${JSON.stringify(det.resumen.curva.map((c) => c.avance))}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Adicional cargado a mano en la OC ===");
  const exc = { descripcion: "Adicional de excavación cimientos a mano", unidad: "m3", cantidad: 216.19, precio_unitario: 4600, origen: "adicional" };
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc([...comoOC(det.items), { ...exc, tipo_adicional: "de_mas" }]));
  check("un adicional de más sin decir qué rubro agranda se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc([...comoOC(det.items), { ...exc, tipo_adicional: "de_mas", item_origen_id: p.P1 }]));
  check("ni apuntando a algo que no es de este subcontrato", r.status === 400, `→ ${r.status}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc([...comoOC(det.items), { ...exc, tipo_adicional: "de_mas", item_origen_id: s.S2 }]));
  check("se agrega el adicional de más sobre los encadenados", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  tot = det.resumen.totales;
  check("el acordado crece en $994.474", cerca(tot.contrato, original + 44000 + 80000 + 994474), `→ ${tot.contrato}`);
  check("y suma a los adicionales de más", cerca(tot.de_mas, 44000 + 994474), `→ ${tot.de_mas}`);
  const rExc = det.resumen.items.find((i) => i.descripcion === exc.descripcion);
  check("el renglón dice que agranda los encadenados", rExc?.clase === "de_mas" && rExc?.rubro_origen === "ENCADENADOS HORIZONTAL Y VERTICAL", `→ ${JSON.stringify(rExc)}`);
  check("los adicionales van al final de la OC", det.items.slice(-2).every((i) => i.origen === "adicional"));
  check("editar la OC no pierde de qué certificado nació el ítem nuevo",
    det.items.find((i) => i.id === nuevoItem.id)?.creado_en_certificado_id === c3);

  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc(comoOC(det.items).filter((i) => i.id !== s.S3)));
  check("no se puede sacar un ítem que ya tiene certificados", r.status === 400, `→ ${r.status}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}`, oc(comoOC(det.items).filter((i) => i.id !== s.S2)));
  check("ni el rubro que agranda un adicional", r.status === 400, `→ ${r.status}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Solo se corrige o anula el ÚLTIMO certificado ===");
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c2}`, {
    desde: "2026-02-23", hasta: "2026-03-06", items: [{ subcontrato_item_id: s.S3, cantidad: 1 }],
  });
  check("corregir uno del medio se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados/${c2}/anular`);
  check("anular uno del medio se rechaza", r.status === 400, `→ ${r.status}`);

  const corr = (items, extra = {}) => ({ desde: "2026-03-09", hasta: "2026-03-20", items, ...extra });
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`,
    corr([{ subcontrato_item_id: s.S1, cantidad: 10 }, { subcontrato_item_id: s.S3, cantidad: 280 }, { subcontrato_item_id: nuevoItem.id, cantidad: 2 }]));
  check("al corregir, lo de más vuelve a pedir confirmación", r.status === 409 && r.data.extras.length === 1 && r.data.extras[0].tipo === "de_mas",
    `→ ${r.status} ${JSON.stringify(r.data?.extras)}`);
  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`,
    corr([{ subcontrato_item_id: s.S1, cantidad: 10 }, { subcontrato_item_id: s.S3, cantidad: 280 }, { subcontrato_item_id: nuevoItem.id, cantidad: 2 }], { confirmar_extras: true }));
  check("confirmado, se corrige", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  check("el ítem nuevo acompaña: ahora son 2", cerca(det.items.find((i) => i.id === nuevoItem.id)?.cantidad, 2));

  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`, corr([{ subcontrato_item_id: s.S3, cantidad: 280 }]));
  check("sin nada de más ya no pregunta", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  check("llevado a cero, el ítem nuevo desaparece de la OC", !det.items.some((i) => i.id === nuevoItem.id));
  check("y el renglón de más también", !det.resumen.items.some((i) => i.id === `de-mas-${s.S1}`) && cerca(det.resumen.totales.de_mas, 994474));

  r = await req("PUT", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}`,
    corr([{ subcontrato_item_id: s.S3, cantidad: 280 }], { nuevos: [{ descripcion: "Retiro de escombros", unidad: "viaje", cantidad: 4, precio_unitario: 30000 }], confirmar_extras: true }));
  check("en la corrección también se puede agregar un ítem nuevo", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  const escombros = det.items.find((i) => i.descripcion === "Retiro de escombros");
  check("y queda como nacido en el certificado 3", escombros?.creado_en_certificado_id === c3 && escombros?.tipo_adicional === "nuevo");

  r = await req("POST", `/obras/${obraId}/subcontratos/${subId}/certificados/${c3}/anular`);
  check("el último se anula", r.status === 200 && r.data.items_quitados === 1, `→ ${r.status} ${JSON.stringify(r.data)}`);
  det = (await req("GET", `/obras/${obraId}/subcontratos/${subId}`)).data;
  check("y se lleva el ítem nuevo que había creado", !det.items.some((i) => i.descripcion === "Retiro de escombros"));
  check("el adicional cargado a mano se queda", det.items.some((i) => i.descripcion === exc.descripcion));
  r = await req("GET", `/obras/${obraId}/subcontratos/${subId}/certificados/nuevo`);
  check("el siguiente es el N° 4 y retoma después del N° 2", r.data.certificado.numero === 4 && r.data.certificado.desde === "2026-03-07",
    `→ ${JSON.stringify(r.data.certificado)}`);
  check("el anulado deja de contar", det.resumen.totales.certificados === 2 && cerca(det.resumen.items.find((i) => i.id === s.S3).certificado, 430));

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Aparte de la obra ===");
  const curvaDespues = (await req("GET", `/obras/${obraId}/curva-avance`)).data;
  check("las curvas de la obra no cambiaron", JSON.stringify(curvaAntes.avance) === JSON.stringify(curvaDespues.avance)
    && JSON.stringify(curvaAntes.certificado) === JSON.stringify(curvaDespues.certificado));
  const lista = (await req("GET", `/obras/${obraId}/subcontratos`)).data;
  check("la lista de la obra muestra el subcontrato con sus números", lista.length === 1 && lista[0].totales?.contrato > 0 && lista[0].totales?.de_mas > 0);

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
