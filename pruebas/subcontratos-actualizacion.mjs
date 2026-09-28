// ACTUALIZACIONES DE PRECIO DEL CONTRATO DEL SUBCONTRATISTA
//
// Los precios de la OC cambian con el tiempo. Una actualización dice desde qué
// fecha rigen los precios nuevos, y cada certificado va con los de la última
// actualización vigente al FIN de su período. Lo definió José, con dos reglas:
//   · un certificado del 25/5 al 7/6 con una actualización desde el 1/6 va
//     entero con el precio nuevo (manda el fin del período);
//   · una actualización solo puede regir después del último certificado: lo
//     ya certificado no se revalúa ni se ajusta después.
//
// OC:  A  100 m2 × 1.000  = 100.000
//      B   10 m3 × 10.000 = 100.000
// Cert 1 (1–15/5)   A 20                       → 20.000
// Cert 2 (16–31/5)  A 20                       → 20.000
// Actualización 1 desde el 1/6: A a 1.200 (B no cambia)
// Cert 3 (1–14/6)   A 10 + B 2                 → 12.000 + 20.000 = 32.000
// Actualización 2 desde el 1/7: B a 11.000
// Cert 4 (15/6–2/7) A 5 + B 1: termina después del 1/7 → 6.000 + 11.000 = 17.000
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
const SECRET = process.env.JWT_SECRET
  || fs.readFileSync(_path.join(_RAIZ, ".env"), "utf8").match(/^JWT_SECRET=(.*)$/m)[1].trim();
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

const SUF = "SA" + Date.now().toString().slice(-6);
let obraId = null, subId = null;
const s = {};

try {
  console.log("=== Preparando la obra y la OC ===");
  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('ACTUALIZACION ${SUF}', 0, NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  let r = await req("POST", `/obras/${obraId}/subcontratos`, {
    subcontratista: `Sub ${SUF}`, fecha_inicio: "2026-05-01", periodicidad: "quincenal",
    items: [
      { descripcion: "Revoque A", unidad: "m2", cantidad: 100, precio_unitario: 1000 },
      { descripcion: "Hormigón B", unidad: "m3", cantidad: 10, precio_unitario: 10000 },
    ],
  });
  if (r.status !== 201) throw new Error(`OC → ${r.status} ${r.data?.message}`);
  subId = r.data.id;
  const base = `/obras/${obraId}/subcontratos/${subId}`;
  let det = (await req("GET", base)).data;
  s.A = det.items.find((i) => i.descripcion === "Revoque A").id;
  s.B = det.items.find((i) => i.descripcion === "Hormigón B").id;

  const certificar = (desde, hasta, items) => req("POST", `${base}/certificados`, {
    desde, hasta, items: items.map(([id, cantidad]) => ({ subcontrato_item_id: id, cantidad })),
  });
  r = await certificar("2026-05-01", "2026-05-15", [[s.A, 20]]);
  if (r.status !== 201) throw new Error(`cert 1 → ${r.status} ${r.data?.message}`);
  r = await certificar("2026-05-16", "2026-05-31", [[s.A, 20]]);
  if (r.status !== 201) throw new Error(`cert 2 → ${r.status} ${r.data?.message}`);
  s.cert2 = r.data.id;

  // ─────────────────────────────────────────────────────────────────
  console.log("\n=== Una actualización no puede tocar lo ya certificado ===");
  det = (await req("GET", base)).data;
  check("el detalle dice desde cuándo puede regir una nueva: el día después del último certificado",
    det.actualizacion_desde_minima === "2026-06-01", `→ ${det.actualizacion_desde_minima}`);
  r = await req("POST", `${base}/actualizaciones`, { fecha_vigencia: "2026-05-20", items: [{ subcontrato_item_id: s.A, precio_unitario: 1200 }] });
  check("desde el 20/5 se rechaza: ya hay un certificado hasta el 31/5", r.status === 400, `→ ${r.status}`);
  check("y lo explica con la fecha del último certificado", /31\/05\/2026/.test(r.data?.message || ""), `→ ${r.data?.message}`);
  r = await req("POST", `${base}/actualizaciones`, { fecha_vigencia: "2026-05-31", items: [{ subcontrato_item_id: s.A, precio_unitario: 1200 }] });
  check("desde el mismo día en que cierra el último certificado, también", r.status === 400, `→ ${r.status}`);

  console.log("\n=== Se carga la actualización de junio ===");
  r = await req("POST", `${base}/actualizaciones`, { fecha_vigencia: "2026-06-01", items: [{ subcontrato_item_id: s.A, precio_unitario: 1000 }, { subcontrato_item_id: s.B, precio_unitario: 10000 }] });
  check("si ningún precio cambia, no hay nada que actualizar", r.status === 400, `→ ${r.status} ${r.data?.message}`);
  r = await req("POST", `${base}/actualizaciones`, {
    fecha_vigencia: "2026-06-01", motivo: "Acuerdo de junio",
    items: [{ subcontrato_item_id: s.A, precio_unitario: 1200 }, { subcontrato_item_id: s.B, precio_unitario: 10000 }],
  });
  check("se guarda la actualización N° 1", r.status === 201 && r.data?.numero === 1, `→ ${r.status} ${r.data?.message}`);
  s.act1 = r.data?.id;
  r = await req("POST", `${base}/actualizaciones`, { fecha_vigencia: "2026-06-01", items: [{ subcontrato_item_id: s.A, precio_unitario: 1300 }] });
  check("otra desde el mismo día se rechaza", r.status === 400, `→ ${r.status}`);

  det = (await req("GET", base)).data;
  const a1 = det.actualizaciones.find((a) => a.id === s.act1);
  check("solo guarda el ítem que cambia (B quedaba igual)", a1?.items.length === 1 && a1.items[0].subcontrato_item_id === s.A, `→ ${JSON.stringify(a1?.items)}`);
  check("muestra de qué precio a cuál: 1.000 → 1.200", cerca(a1?.items[0]?.precio_anterior, 1000) && cerca(a1?.items[0]?.precio, 1200));
  check("todavía se puede corregir: ningún certificado la usó", a1?.editable === true);
  check("el precio de la OC queda como el original", cerca(det.items.find((i) => i.id === s.A).precio_unitario, 1000));
  check("y el vigente es el nuevo", cerca(det.items.find((i) => i.id === s.A).precio_vigente, 1200));

  console.log("\n=== Lo ya certificado no se revalúa ===");
  const c2 = det.certificados.find((c) => c.id === s.cert2);
  check("el certificado 2 sigue valiendo 20 × 1.000 = 20.000", cerca(c2?.importe, 20000), `→ ${c2?.importe}`);
  const pl2 = (await req("GET", `${base}/certificados/${s.cert2}`)).data;
  check("y su planilla sigue con los precios de la OC", !pl2.actualizacion && cerca(pl2.filas.find((f) => f.id === s.A).precio, 1000));

  console.log("\n=== El certificado de junio va con los precios nuevos ===");
  const nuevo = (await req("GET", `${base}/certificados/nuevo`)).data;
  check("la planilla nueva propone del 1 al 14/6", nuevo.certificado.desde === "2026-06-01" && nuevo.certificado.hasta === "2026-06-14", `→ ${nuevo.certificado.desde} ${nuevo.certificado.hasta}`);
  check("dice con qué actualización va", nuevo.actualizacion?.numero === 1, `→ ${JSON.stringify(nuevo.actualizacion)}`);
  const fA = nuevo.filas.find((f) => f.id === s.A);
  check("A sale a 1.200", cerca(fA.precio, 1200) && cerca(fA.precio_vigente, 1200), `→ ${fA.precio}`);
  check("con su historia de precios, para recalcular si se cambia la fecha", fA.precios.length === 2 && fA.precios[1].desde === "2026-06-01");
  r = await certificar("2026-06-01", "2026-06-14", [[s.A, 10], [s.B, 2]]);
  check("se emite el certificado 3", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  s.cert3 = r.data?.id;
  det = (await req("GET", base)).data;
  const c3 = det.certificados.find((c) => c.id === s.cert3);
  check("vale 10 × 1.200 + 2 × 10.000 = 32.000", cerca(c3?.importe, 32000), `→ ${c3?.importe}`);
  const congelados = await sql(`SELECT subcontrato_item_id, precio_unitario FROM subcontrato_certificado_items WHERE certificado_id = ${s.cert3}`);
  check("el precio queda congelado en el certificado", cerca(congelados.find((x) => x.subcontrato_item_id === s.A)?.precio_unitario, 1200));

  console.log("\n=== Lo pendiente se valoriza a los precios nuevos ===");
  // A: 100 − 50 = 50 × 1.200 = 60.000 · B: 10 − 2 = 8 × 10.000 = 80.000
  check("queda por hacer 140.000", cerca(det.resumen.totales.pendiente, 140000), `→ ${det.resumen.totales.pendiente}`);
  check("lo de la OC a precios originales sigue en 200.000", cerca(det.resumen.totales.original_oc, 200000), `→ ${det.resumen.totales.original_oc}`);
  check("y a precios actualizados es 220.000", cerca(det.resumen.totales.original, 220000), `→ ${det.resumen.totales.original}`);
  check("lo certificado suma 20.000 + 20.000 + 32.000", cerca(det.resumen.totales.certificado, 72000), `→ ${det.resumen.totales.certificado}`);

  console.log("\n=== Una actualización usada ya no se toca ===");
  const a1Ahora = det.actualizaciones.find((a) => a.id === s.act1);
  check("figura como usada por el certificado 3", a1Ahora.editable === false && a1Ahora.usada_por_certificado === 3);
  r = await req("PUT", `${base}/actualizaciones/${s.act1}`, { fecha_vigencia: "2026-06-20", items: [{ subcontrato_item_id: s.A, precio_unitario: 1500 }] });
  check("no se puede corregir", r.status === 400 && /N° 3/.test(r.data?.message || ""), `→ ${r.status} ${r.data?.message}`);
  r = await req("DELETE", `${base}/actualizaciones/${s.act1}`);
  check("ni borrar", r.status === 400, `→ ${r.status}`);

  console.log("\n=== Manda el FIN del período ===");
  r = await req("POST", `${base}/actualizaciones`, { fecha_vigencia: "2026-07-01", motivo: "Julio", items: [{ subcontrato_item_id: s.B, precio_unitario: 11000 }] });
  check("se guarda la actualización N° 2, desde el 1/7", r.status === 201 && r.data?.numero === 2, `→ ${r.status} ${r.data?.message}`);
  s.act2 = r.data?.id;
  r = await certificar("2026-06-15", "2026-07-02", [[s.A, 5], [s.B, 1]]);
  check("un certificado del 15/6 al 2/7 se emite", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  s.cert4 = r.data?.id;
  let pl4 = (await req("GET", `${base}/certificados/${s.cert4}`)).data;
  check("termina después del 1/7: va con la actualización 2", pl4.actualizacion?.numero === 2, `→ ${JSON.stringify(pl4.actualizacion)}`);
  check("B a 11.000 y A sigue con el 1.200 de la anterior: 6.000 + 11.000 = 17.000", cerca(pl4.totales.importe.actual, 17000), `→ ${pl4.totales.importe.actual}`);

  r = await req("PUT", `${base}/certificados/${s.cert4}`, { desde: "2026-06-15", hasta: "2026-06-30", items: [{ subcontrato_item_id: s.A, cantidad: 5 }, { subcontrato_item_id: s.B, cantidad: 1 }] });
  check("se corrige para que termine el 30/6", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  pl4 = (await req("GET", `${base}/certificados/${s.cert4}`)).data;
  check("y vuelve a los precios de junio: 6.000 + 10.000 = 16.000", cerca(pl4.totales.importe.actual, 16000) && pl4.actualizacion?.numero === 1, `→ ${pl4.totales.importe.actual}`);

  det = (await req("GET", base)).data;
  check("la actualización de julio quedó sin usar: se puede corregir", det.actualizaciones.find((a) => a.id === s.act2)?.editable === true);
  r = await req("PUT", `${base}/actualizaciones/${s.act2}`, { fecha_vigencia: "2026-07-01", motivo: "Julio corregido", items: [{ subcontrato_item_id: s.B, precio_unitario: 11500 }] });
  check("se corrige", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  r = await req("DELETE", `${base}/actualizaciones/${s.act2}`);
  check("y se borra", r.status === 200, `→ ${r.status} ${r.data?.message}`);

  console.log("\n=== Anulando los certificados, la actualización vuelve a ser editable ===");
  await req("POST", `${base}/certificados/${s.cert4}/anular`);
  await req("POST", `${base}/certificados/${s.cert3}/anular`);
  det = (await req("GET", base)).data;
  check("sin certificados de junio, la de junio se puede corregir", det.actualizaciones.find((a) => a.id === s.act1)?.editable === true);
  r = await req("PUT", `${base}/actualizaciones/${s.act1}`, { fecha_vigencia: "2026-06-01", items: [{ subcontrato_item_id: s.A, precio_unitario: 1300 }] });
  check("y se corrige a 1.300", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  det = (await req("GET", base)).data;
  check("el precio vigente de A pasa a 1.300", cerca(det.items.find((i) => i.id === s.A).precio_vigente, 1300));
} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (subId) {
    await sql(`DELETE FROM subcontrato_actualizacion_items WHERE actualizacion_id IN (SELECT id FROM subcontrato_actualizaciones WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_actualizaciones WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontrato_descuentos WHERE certificado_id IN (SELECT id FROM subcontrato_certificados WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_certificado_items WHERE certificado_id IN (SELECT id FROM subcontrato_certificados WHERE subcontrato_id = ${subId})`);
    await sql(`DELETE FROM subcontrato_certificados WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontrato_items WHERE subcontrato_id = ${subId}`);
    await sql(`DELETE FROM subcontratos WHERE id = ${subId}`);
  }
  if (obraId) await sql(`DELETE FROM obras WHERE id = ${obraId}`);
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedó basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
