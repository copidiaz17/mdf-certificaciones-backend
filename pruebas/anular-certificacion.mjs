// Anular y reactivar una certificación, y que el servidor recalcule.
//
// Antes no se podía anular: un certificado cargado mal se editaba o se
// borraba. Borrarlo es peor de lo que parece, porque del otro lado —en el
// sistema de costos— puede haber una factura emitida contra él.
//
// Se corre contra una base DE PRUEBA, nunca contra producción:
//
//   DB_SSL=false DB_HOST=localhost DB_USER=root DB_PASSWORD= \
//   DB_NAME=certif_falube_prueba API_BASE=http://localhost:3098/api \
//   node pruebas/anular-certificacion.mjs

import { sequelize } from "../database.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const API = process.env.API_BASE || "http://localhost:3098/api";
const SECRET = process.env.JWT_SECRET;

let ok = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n} ${d}`); fail++; } };
const sql = async (q) => { const [r] = await sequelize.query(q); return r; };

const req = async (m, ruta, body, tk) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: { ...(tk ? { Authorization: `Bearer ${tk}` } : {}), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};

const SUF = Date.now().toString().slice(-6);
let obraId = null, itemId = null, certA = null, certB = null, token = null;

try {
  const base = sequelize.config.database;
  if (!/prueba|test/i.test(base)) {
    console.error(`⛔ La base "${base}" no parece de prueba. Cancelo.`);
    process.exit(1);
  }
  await sequelize.authenticate();
  console.log(`Base de prueba: ${base}\n`);

  // ── Preparar: usuario, obra y un ítem de pliego ───────────────────────
  const hash = await bcrypt.hash("Prueba12345", 10);
  await sql(`INSERT INTO usuarios (nombre, email, password, rol, createdAt, updatedAt)
             VALUES ('Prueba ${SUF}', 'p${SUF}@t.com', '${hash}', 'administrador', NOW(), NOW())`);
  const usuarioId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  token = jwt.sign({ id: usuarioId, email: `p${SUF}@t.com`, rol: "administrador" }, SECRET, { expiresIn: "1h" });

  // Repartición municipalidad: deduce 40% de anticipo, 5% de reparo y 3% de tasa.
  await sql(`INSERT INTO obras (nombre, reparticion, createdAt, updatedAt)
             VALUES ('Obra ${SUF}', 'municipalidad_sgo', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  // El ítem del catálogo general, que el pliego necesita sí o sí.
  await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
             VALUES ('Item general ${SUF}', 'm3', NOW(), NOW())`);
  const itemGeneralId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  // 100 unidades a $1.000 = $100.000 el ítem completo.
  // pliegoitems no lleva timestamps: por eso no van acá.
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem,
                                      unidadMedida, cantidad, costoUnitario, costoParcial)
             VALUES (${obraId}, ${itemGeneralId}, '1', 'Item de prueba', 'm3', 100, 1000, 100000)`);
  itemId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  console.log(`Obra ${obraId} · ítem ${itemId} · 100 × $1.000 = $100.000\n`);

  // ── 1. El servidor recalcula, ignorando lo que manda el front ─────────
  console.log("=== El servidor ignora los totales del navegador ===");
  let r = await req("POST", `/certificaciones/obras/${obraId}/certificaciones`, {
    numero_certificado: 1,
    fecha_certificacion: "2026-03-31",
    periodo_desde: "2026-03-01",
    periodo_hasta: "2026-03-31",
    items: [{ pliego_item_id: itemId, avance_porcentaje: 50, importe: 999999 }],
    // Mentira deliberada: si el servidor le creyera, quedaría guardada.
    totales: { subtotal: 999999, totalNeto: 999999, deduccionAnticipo: 0 },
  }, token);
  check("crea el certificado", r.status === 201, `→ ${r.status} ${r.data?.error}`);
  certA = r.data?.certificacion_id;

  const g = (await sql(`SELECT * FROM certificaciones WHERE id = ${certA}`))[0];
  // 50% de $100.000 = $50.000, no los $999.999 que mandó el front.
  check("el subtotal sale del pliego, no del front",
    Math.abs(Number(g.subtotal) - 50000) < 1, `→ ${g.subtotal}`);
  check("deduce el anticipo del 40%",
    Math.abs(Number(g.deduccion_anticipo) - 20000) < 1, `→ ${g.deduccion_anticipo}`);
  check("fondo de reparo del 5%",
    Math.abs(Number(g.fondo_reparo) - 2500) < 1, `→ ${g.fondo_reparo}`);
  check("tasa de inspección del 3%",
    Math.abs(Number(g.tasa_inspeccion) - 1500) < 1, `→ ${g.tasa_inspeccion}`);
  // 50.000 − 20.000 − 2.500 − 1.500 + 2.500 (sustitución) = 28.500
  check("total neto", Math.abs(Number(g.total_neto) - 28500) < 1, `→ ${g.total_neto}`);
  check("el importe del ítem también se recalculó",
    Math.abs(Number((await sql(`SELECT importe FROM certificacion_items WHERE certificacion_id=${certA}`))[0].importe) - 50000) < 1);
  check("queda registrado quién lo creó", Number(g.creado_por_id) === Number(usuarioId), `→ ${g.creado_por_id}`);

  console.log("\n=== Un ítem de otra obra no se puede certificar ===");
  await sql(`INSERT INTO obras (nombre, reparticion, createdAt, updatedAt)
             VALUES ('Otra ${SUF}', 'municipalidad_sgo', NOW(), NOW())`);
  const otraObra = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  r = await req("POST", `/certificaciones/obras/${otraObra}/certificaciones`, {
    numero_certificado: 1, fecha_certificacion: "2026-03-31",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-31",
    items: [{ pliego_item_id: itemId, avance_porcentaje: 10 }],
  }, token);
  check("rechaza", r.status === 400, `→ ${r.status}`);
  check("y lo explica", /no pertenece a esta obra/i.test(r.data?.error || ""), `→ ${r.data?.error}`);

  // ── 2. Anular ─────────────────────────────────────────────────────────
  console.log("\n=== Anular ===");
  r = await req("POST", `/certificaciones/${certA}/anular`, {}, token);
  check("anula", r.status === 200, `→ ${r.status} ${r.data?.error}`);
  const anulado = (await sql(`SELECT anulada, anulada_por_id FROM certificaciones WHERE id=${certA}`))[0];
  check("queda marcado", Number(anulado.anulada) === 1);
  check("con quién lo anuló", Number(anulado.anulada_por_id) === Number(usuarioId));
  check("no se borró", (await sql(`SELECT COUNT(*) n FROM certificaciones WHERE id=${certA}`))[0].n == 1);

  r = await req("POST", `/certificaciones/${certA}/anular`, {}, token);
  check("no se puede anular dos veces", r.status === 400, `→ ${r.status}`);

  r = await req("PUT", `/certificaciones/${certA}`, {
    numero_certificado: 9, fecha_certificacion: "2026-04-01",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-31",
  }, token);
  check("un certificado anulado no se puede editar", r.status === 400, `→ ${r.status}`);

  console.log("\n=== El anulado libera el acumulado ===");
  // Con el primero anulado, el ítem vuelve a estar en 0%: se puede certificar
  // el 100% entero. Si el anulado siguiera contando, esto daría error.
  r = await req("POST", `/certificaciones/obras/${obraId}/certificaciones`, {
    numero_certificado: 2, fecha_certificacion: "2026-04-30",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-30",
    items: [{ pliego_item_id: itemId, avance_porcentaje: 100 }],
  }, token);
  check("deja certificar el 100%", r.status === 201, `→ ${r.status} ${r.data?.error}`);
  certB = r.data?.certificacion_id;

  console.log("\n=== Reactivar cuando ya no entra ===");
  // Ahora el ítem está al 100% por el certificado B. Reactivar el A lo
  // llevaría a 150%: tiene que negarse y decir por qué.
  r = await req("POST", `/certificaciones/${certA}/reactivar`, {}, token);
  check("no deja reactivar", r.status === 400, `→ ${r.status}`);
  // El mensaje descompone el número —"otras 100% + esta 50%"— en vez de dar
  // solo el total: así se ve de dónde sale el conflicto.
  check("y descompone de dónde sale el conflicto",
    /otras\s*100/.test(r.data?.error || "") && /esta\s*50/.test(r.data?.error || ""),
    `→ ${r.data?.error}`);
  check("sigue anulado",
    Number((await sql(`SELECT anulada FROM certificaciones WHERE id=${certA}`))[0].anulada) === 1);

  console.log("\n=== Reactivar cuando sí entra ===");
  await sql(`UPDATE certificaciones SET anulada = 1 WHERE id = ${certB}`);
  r = await req("POST", `/certificaciones/${certA}/reactivar`, {}, token);
  check("reactiva", r.status === 200, `→ ${r.status} ${r.data?.error}`);
  const react = (await sql(`SELECT anulada, anulada_por_id FROM certificaciones WHERE id=${certA}`))[0];
  check("ya no está anulado", Number(react.anulada) === 0);
  check("y se limpia quién lo anuló", react.anulada_por_id === null);

  console.log("\n=== El historial muestra las anuladas ===");
  r = await req("GET", `/certificaciones/obras/${obraId}/certificaciones`, null, token);
  check("las lista a todas", Array.isArray(r.data) && r.data.length === 2, `→ ${r.data?.length}`);
  check("y dice cuál está anulada",
    r.data?.some((c) => c.anulada === true || c.anulada === 1), `→ ${JSON.stringify(r.data?.map(c=>c.anulada))}`);

  console.log("\n=== Sin sesión no se anula nada ===");
  r = await req("POST", `/certificaciones/${certA}/anular`, {});
  check("rechaza", r.status === 401 || r.status === 403, `→ ${r.status}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (obraId) {
    await sql(`DELETE ci FROM certificacion_items ci
               JOIN certificaciones c ON c.id = ci.certificacion_id WHERE c.obra_id = ${obraId}`);
    await sql(`DELETE FROM certificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
  }
  await sql(`DELETE FROM obras WHERE nombre LIKE '%${SUF}'`);
  await sql(`DELETE FROM usuarios WHERE email LIKE '%${SUF}%'`);
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}'`);
  check("no quedó basura de prueba",
    Number((await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}'`))[0].n) === 0);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
