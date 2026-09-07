// Convertir un excedente en item del pliego, y la API entre sistemas.
// Corre SOLO contra la base local de prueba. Deja todo como estaba.
import { sequelize } from "../database.js";
import jwt from "jsonwebtoken";
import fs from "fs";

import { fileURLToPath } from "url";
import * as _path from "path";
// Relativo a ESTE archivo, no a una ruta escrita a mano: la misma prueba
// tiene que poder correr en los dos sistemas.
const _RAIZ = _path.join(_path.dirname(fileURLToPath(import.meta.url)), "..");

const API = process.env.API_BASE || "http://localhost:3080/api";
const SECRET = fs.readFileSync(_path.join(_RAIZ, ".env"), "utf8").match(/^JWT_SECRET=(.*)$/m)[1].trim();
const TK = jwt.sign({ id: 1, email: "t@t.com", nombre: "T", rol: "admin" }, SECRET, { expiresIn: "1h" });
const TOKEN_API = process.env.API_TOKEN || "prueba-token";

let ok = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n} ${d}`); fail++; } };
const cerca = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const req = async (m, ruta, body, cabeceras = {}) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: { Authorization: `Bearer ${TK}`, "Content-Type": "application/json", ...cabeceras },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};
const publica = (ruta) => req("GET", ruta, null, { "X-API-Token": TOKEN_API });
const sql = async (q) => { const [r] = await sequelize.query(q); return r; };

const SUF = "CV" + Date.now().toString().slice(-6);
let obraId = null, itemExcav = null;
const avanceIds = [];

try {
  // ── Escenario: 50 m3 de pliego, 200 ejecutados, 1 certificacion al 100% ─
  console.log("=== Preparando ===");
  await sql(`INSERT INTO obras (nombre, createdAt, updatedAt) VALUES ('CONV ${SUF}', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  const genId = (await sql("SELECT id FROM itemgenerals LIMIT 1"))[0].id;

  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
             VALUES (${obraId}, ${genId}, '1.1', 'Excavacion', 'm3', 50, 10000, 500000, 'original')`);
  itemExcav = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  let r = await req("POST", `/avanceObra/${obraId}`, {
    numero_avance: 1, fecha_avance: "2026-03-15", periodo_desde: "2026-03-01", periodo_hasta: "2026-03-15",
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 200 }],
  });
  if (r.data?.id) avanceIds.push(r.data.id);
  check("carga el avance de 200 m3 sobre 50", r.status === 201, `→ ${r.status}`);

  r = await req("GET", `/avanceObra/${obraId}/excedentes`);
  check("el excedente es 150 m3", cerca(r.data?.excedentes?.[0]?.excedente, 150), `→ ${r.data?.excedentes?.[0]?.excedente}`);
  check("y esta todo pendiente", cerca(r.data?.excedentes?.[0]?.pendiente, 150), `→ ${r.data?.excedentes?.[0]?.pendiente}`);

  // ── Convertir en parte ──────────────────────────────────────────────────
  console.log("\n=== Reconocer 100 de los 150 en un item nuevo ===");
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${itemExcav}/convertir`, { cantidad: 100 });
  check("lo convierte", r.status === 201, `→ ${r.status} ${r.data?.message || r.data?.error || ""}`);
  console.log(`     "${r.data?.message}"`);
  const nuevo = r.data?.item;
  check("crea un item NUEVO, no toca el original", nuevo?.id !== itemExcav);
  check("con el numero marcado (1.1 EXC)", nuevo?.numeroItem === "1.1 EXC", `→ ${nuevo?.numeroItem}`);
  check("SIN PRECIO", Number(nuevo?.costoUnitario) === 0 && Number(nuevo?.costoParcial) === 0,
    `→ ${nuevo?.costoUnitario} / ${nuevo?.costoParcial}`);
  check("con la cantidad reconocida", cerca(nuevo?.cantidad, 100), `→ ${nuevo?.cantidad}`);
  check("marcado como origen excedente", nuevo?.origen === "excedente", `→ ${nuevo?.origen}`);
  check("y apuntando al item del que salio", Number(nuevo?.item_origen_id) === itemExcav, `→ ${nuevo?.item_origen_id}`);
  check("informa cuanto queda", cerca(r.data?.pendiente_restante, 50), `→ ${r.data?.pendiente_restante}`);

  const original = (await sql(`SELECT cantidad, costoParcial FROM pliegoitems WHERE id = ${itemExcav}`))[0];
  check("el item ORIGINAL quedo intacto (50 m3, $500.000)",
    cerca(original.cantidad, 50) && cerca(original.costoParcial, 500000),
    `→ ${original.cantidad} / ${original.costoParcial}`);

  console.log("\n=== El pendiente baja a 50 ===");
  r = await req("GET", `/avanceObra/${obraId}/excedentes`);
  const e = r.data?.excedentes?.[0];
  check("el excedente total sigue siendo 150", cerca(e?.excedente, 150), `→ ${e?.excedente}`);
  check("ya convertido: 100", cerca(e?.ya_convertido, 100), `→ ${e?.ya_convertido}`);
  check("pendiente: 50", cerca(e?.pendiente, 50), `→ ${e?.pendiente}`);
  check("el item de excedente NO aparece como excedente propio", (r.data?.excedentes || []).length === 1,
    `→ ${r.data?.excedentes?.length}`);

  console.log("\n=== No se puede reconocer mas de lo que queda ===");
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${itemExcav}/convertir`, { cantidad: 80 });
  check("rechaza 80 cuando quedan 50", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);

  r = await req("POST", `/avanceObra/${obraId}/excedentes/${itemExcav}/convertir`, { cantidad: 50 });
  check("acepta los 50 que faltan", r.status === 201, `→ ${r.status}`);
  r = await req("GET", `/avanceObra/${obraId}/excedentes`);
  check("y el pendiente queda en 0", cerca(r.data?.excedentes?.[0]?.pendiente, 0), `→ ${r.data?.excedentes?.[0]?.pendiente}`);

  console.log("\n=== Un item de excedente no genera otro excedente ===");
  const idExc = nuevo.id;
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${idExc}/convertir`, { cantidad: 10 });
  check("lo rechaza", r.status === 400, `→ ${r.status}`);

  // ── La API entre sistemas ───────────────────────────────────────────────
  console.log("\n=== API entre sistemas: sin token no entra ===");
  r = await req("GET", "/publica/obras");
  check("sin token: 401", r.status === 401, `→ ${r.status}`);
  r = await req("GET", "/publica/obras", null, { "X-API-Token": "cualquiera" });
  check("con token equivocado: 401", r.status === 401, `→ ${r.status}`);

  console.log("\n=== API entre sistemas: el avance de la obra ===");
  r = await publica("/publica/obras");
  check("lista las obras", r.status === 200 && (r.data?.obras || []).some((o) => o.id === obraId), `→ ${r.status}`);

  r = await publica(`/publica/obras/${obraId}/avance`);
  check("responde el avance", r.status === 200, `→ ${r.status} ${r.data?.error || ""}`);
  const t = r.data?.totales;
  console.log(`     contrato $${t?.precio_contrato} · ejecutado $${t?.ejecutado_importe} · certificado $${t?.certificado_importe}`);

  check("precio de contrato = 500.000 (el excedente no suma, no tiene precio)",
    cerca(t?.precio_contrato, 500000), `→ ${t?.precio_contrato}`);
  check("ejecutado valorizado tope 100% = 500.000", cerca(t?.ejecutado_importe, 500000), `→ ${t?.ejecutado_importe}`);
  check("certificado = 0 (no se certifico nada)", cerca(t?.certificado_importe, 0), `→ ${t?.certificado_importe}`);
  check("la diferencia es el trabajo hecho sin facturar", cerca(t?.diferencia, 500000), `→ ${t?.diferencia}`);
  check("y lo explica en castellano", /derechos a facturar/i.test(t?.interpretacion || ""), `→ ${t?.interpretacion}`);
  check("avisa que hay items sin precio", t?.items_sin_precio === 2, `→ ${t?.items_sin_precio}`);

  console.log("\n=== EL EXCEDENTE NO CRUZA ===");
  const itExc = (r.data?.items || []).find((i) => i.pliego_item_id === itemExcav);
  // Se ejecutaron 200 m3 de 50. Al sistema de contabilidad le llegan 50.
  check("la cantidad viene TOPADA al pliego (50, no 200)", cerca(itExc?.cantidad_reconocida, 50),
    `→ ${itExc?.cantidad_reconocida}`);
  check("el porcentaje viene topado al 100 (no 400)", cerca(itExc?.avance_reconocido_porcentaje, 100),
    `→ ${itExc?.avance_reconocido_porcentaje}`);
  check("NO manda el excedente en ningun campo",
    itExc?.excedente_cantidad === undefined && itExc?.excedente === undefined,
    `→ ${JSON.stringify(Object.keys(itExc || {}))}`);
  check("ni el total lo cuenta", t?.items_con_excedente === undefined, `→ ${t?.items_con_excedente}`);
  const crudo = JSON.stringify(r.data);
  check("los 200 m3 no aparecen en ningun lado de la respuesta", !/200/.test(crudo.replace(/500000/g, "")),
    "el excedente se filtro en la respuesta");
  check("el importe se valoriza al tope, no al ejecutado", cerca(itExc?.ejecutado_importe, 500000),
    `→ ${itExc?.ejecutado_importe}`);
  check("y la respuesta explica el alcance", /TOPADO|reclamo a negociar/i.test(r.data?.alcance || ""),
    `→ ${r.data?.alcance}`);
  const itNuevo = (r.data?.items || []).find((i) => i.origen === "excedente");
  check("los items de excedente vienen marcados sin_precio", itNuevo?.sin_precio === true);
  check("y con su item de origen", Number(itNuevo?.item_origen_id) === itemExcav, `→ ${itNuevo?.item_origen_id}`);

  console.log("\n=== Certificar cambia la diferencia ===");
  await sql(`INSERT INTO certificaciones (obra_id, numero_certificado, fecha_certificacion, periodo_desde, periodo_hasta, subtotal, total_neto, anulada, createdAt, updatedAt)
             VALUES (${obraId}, '1', '2026-03-31', '2026-03-01', '2026-03-31', 500000, 500000, 0, NOW(), NOW())`);
  const certId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await sql(`INSERT INTO certificacion_items (certificacion_id, pliego_item_id, avance_porcentaje, importe)
             VALUES (${certId}, ${itemExcav}, 100, 500000)`);

  r = await publica(`/publica/obras/${obraId}/avance`);
  check("ahora certificado = 500.000", cerca(r.data?.totales?.certificado_importe, 500000), `→ ${r.data?.totales?.certificado_importe}`);
  check("y la diferencia queda en 0", cerca(r.data?.totales?.diferencia, 0), `→ ${r.data?.totales?.diferencia}`);
  check("lo dice", /coinciden/i.test(r.data?.totales?.interpretacion || ""), `→ ${r.data?.totales?.interpretacion}`);
  await sql(`DELETE FROM certificacion_items WHERE certificacion_id = ${certId}`);
  await sql(`DELETE FROM certificaciones WHERE id = ${certId}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  for (const id of avanceIds) await sql(`DELETE FROM avance_obra_items WHERE avance_obra_id = ${id}`);
  if (obraId) {
    await sql(`DELETE FROM certificacion_items WHERE certificacion_id IN (SELECT id FROM certificaciones WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM certificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
    await sql(`DELETE FROM obras WHERE id = ${obraId}`);
  }
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedo basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
