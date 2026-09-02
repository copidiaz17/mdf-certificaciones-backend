// La ruta que USA la aplicacion: POST /obras/:id/avances.
//
// Es la que importa. Hasta ahora RECHAZABA con un 400 todo avance que pasara
// del 100%, asi que el caso del Jardin —200 m3 de excavacion sobre 50— no se
// podia registrar de ninguna manera. Y `items-disponibles-avance` escondia los
// items completos, asi que ni siquiera aparecian en el formulario.
//
// Corre SOLO contra la base local de prueba. Ver pruebas/LEEME.md.
import { sequelize } from "file:///C:/certificacion-mdf/mdf-backend/database.js";
import jwt from "file:///C:/certificacion-mdf/mdf-backend/node_modules/jsonwebtoken/index.js";
import fs from "fs";

const API = process.env.API_BASE || "http://localhost:3080/api";
const SECRET = fs.readFileSync("C:/certificacion-mdf/mdf-backend/.env", "utf8").match(/^JWT_SECRET=(.*)$/m)[1].trim();
const TK = jwt.sign({ id: 1, email: "t@t.com", nombre: "T", rol: "admin" }, SECRET, { expiresIn: "1h" });

let ok = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n} ${d}`); fail++; } };
const cerca = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const req = async (m, ruta, body) => {
  const r = await fetch(API + ruta, {
    method: m, headers: { Authorization: `Bearer ${TK}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};
const sql = async (q) => { const [r] = await sequelize.query(q); return r; };

const SUF = "RR" + Date.now().toString().slice(-6);
let obraId = null, itemExcav = null;
const avanceIds = [];

try {
  console.log("=== Preparando: 50 m3 de excavacion en el pliego ===");
  await sql(`INSERT INTO obras (nombre, createdAt, updatedAt) VALUES ('REAL ${SUF}', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  const genId = (await sql("SELECT id FROM itemgenerals LIMIT 1"))[0].id;
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
             VALUES (${obraId}, ${genId}, '1.1', 'Excavacion', 'm3', 50, 10000, 500000, 'original')`);
  itemExcav = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  // ── Lo que antes era imposible ─────────────────────────────────────────
  console.log("\n=== El caso del Jardin, por la ruta que usa la app ===");
  let r = await req("POST", `/obras/${obraId}/avances`, {
    numero_avance: 1, fecha_avance: "2026-03-15",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-15",
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 200 }],
  });
  check("YA NO LO RECHAZA (antes daba 400)", r.status === 201, `→ ${r.status} ${r.data?.message || ""}`);
  if (r.data?.id) avanceIds.push(r.data.id);
  check("avisa del excedente", r.data?.hay_excedentes === true, `→ ${r.data?.hay_excedentes}`);
  console.log(`     "${r.data?.avisos?.[0]?.mensaje}"`);
  check("el aviso trae los 150 m3", cerca(r.data?.avisos?.[0]?.excedente, 150), `→ ${r.data?.avisos?.[0]?.excedente}`);

  const g = (await sql(`SELECT avance_porcentaje, cantidad_ejecutada FROM avance_obra_items WHERE avance_obra_id = ${r.data.id}`))[0];
  check("guarda los 200 m3", cerca(g?.cantidad_ejecutada, 200), `→ ${g?.cantidad_ejecutada}`);
  check("y el 400%, sin truncar", cerca(g?.avance_porcentaje, 400), `→ ${g?.avance_porcentaje}`);

  console.log("\n=== El ponderado del periodo se sigue calculando bien ===");
  // Se topa al 100% para ponderar: 500.000 de 500.000 = 100%
  check("no se dispara al 400%", cerca(r.data?.avance_periodo_ponderado, 100), `→ ${r.data?.avance_periodo_ponderado}`);

  // ── El item completo ya no desaparece del formulario ───────────────────
  console.log("\n=== Un item al 100% sigue apareciendo para cargar ===");
  r = await req("GET", `/obras/${obraId}/items-disponibles-avance`);
  check("responde", r.status === 200, `→ ${r.status}`);
  const disp = (r.data || []).find((i) => i.id === itemExcav);
  check("el item excedido SIGUE en la lista (antes se filtraba)", !!disp,
    `→ ${(r.data || []).length} items`);
  check("marcado como completo", disp?.completo === true, `→ ${disp?.completo}`);
  check("y como excedido", disp?.excedido === true, `→ ${disp?.excedido}`);
  check("con el acumulado real (400%)", cerca(disp?.acumulado, 400), `→ ${disp?.acumulado}`);
  check("disponible en 0", cerca(disp?.porcentajeDisponible, 0), `→ ${disp?.porcentajeDisponible}`);

  // ── Segundo avance sobre un item ya excedido ───────────────────────────
  console.log("\n=== Se le puede seguir cargando ===");
  r = await req("POST", `/obras/${obraId}/avances`, {
    numero_avance: 2, fecha_avance: "2026-04-15",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-15",
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 20 }],
  });
  check("acepta 20 m3 mas sobre un item ya excedido", r.status === 201, `→ ${r.status} ${r.data?.message || ""}`);
  if (r.data?.id) avanceIds.push(r.data.id);
  check("y el excedente acumulado sube a 170", cerca(r.data?.avisos?.[0]?.excedente, 170),
    `→ ${r.data?.avisos?.[0]?.excedente}`);

  // ── Editar ──────────────────────────────────────────────────────────────
  console.log("\n=== Editar un avance tampoco rechaza ===");
  r = await req("PUT", `/obras/${obraId}/avances/${avanceIds[1]}`, {
    numero_avance: 2, fecha_avance: "2026-04-15",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-15",
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 40 }],
  });
  check("acepta la edicion", r.status === 200, `→ ${r.status} ${r.data?.message || ""}`);
  check("y avisa del excedente", r.data?.hay_excedentes === true);
  // 200 del primero + 40 del editado = 240 → excedente 190
  check("con el acumulado bien (190, no cuenta dos veces el editado)",
    cerca(r.data?.avisos?.[0]?.excedente, 190), `→ ${r.data?.avisos?.[0]?.excedente}`);

  // ── La certificacion SIGUE topada ──────────────────────────────────────
  console.log("\n=== La CERTIFICACION sigue topada al 100% ===");
  r = await req("POST", `/obras/${obraId}/certificaciones`, {
    numero_certificado: "1", fecha_certificacion: "2026-04-30",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-30",
    items: [{ pliego_item_id: itemExcav, avance_porcentaje: 400 }],
  });
  check("rechaza certificar al 400%", r.status >= 400, `→ ${r.status} ${r.data?.message || ""}`);
  console.log(`     "${r.data?.message || r.data?.error}"`);

  console.log("\n=== Items disponibles para CERTIFICAR sigue filtrando ===");
  r = await req("GET", `/obras/${obraId}/items-disponibles-certificacion`);
  check("responde", r.status === 200, `→ ${r.status}`);
  check("el item aparece (no se certifico nada todavia)", (r.data || []).some((i) => i.id === itemExcav));

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
