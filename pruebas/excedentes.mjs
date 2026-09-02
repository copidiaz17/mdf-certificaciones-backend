// Excedentes de avance de obra: registrar por encima del pliego, avisar, y
// que quede en la seccion de excedentes. Sin precio.
// Deja la base como la encontro.
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

const SUF = "EX" + Date.now().toString().slice(-6);
let obraId = null, itemExcav = null, itemPared = null;
const avanceIds = [];

try {
  // ── Obra de prueba con dos items del pliego ─────────────────────────────
  console.log("=== Preparando una obra con pliego ===");
  await sql(`INSERT INTO obras (nombre, createdAt, updatedAt) VALUES ('PRUEBA ${SUF}', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  const gen = await sql("SELECT id FROM itemgenerals LIMIT 1");
  const genId = gen.length ? gen[0].id : 1;

  const crearItem = async (numero, desc, unidad, cantidad, costoUnit) => {
    await sql(`INSERT INTO pliegoitems
      (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
      VALUES (${obraId}, ${genId}, '${numero}', '${desc}', '${unidad}', ${cantidad}, ${costoUnit}, ${cantidad * costoUnit}, 'original')`);
    return (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  };
  // El caso real del jardin: 50 m3 de excavacion presupuestados.
  itemExcav = await crearItem("1.1", "Excavacion", "m3", 50, 10000);
  itemPared = await crearItem("1.2", "Mamposteria", "m2", 100, 5000);
  check("crea la obra y dos items del pliego", !!itemExcav && !!itemPared);

  // ── Avisa ANTES de guardar ──────────────────────────────────────────────
  console.log("\n=== Avisa antes de guardar (previsualizar) ===");
  let r = await req("POST", `/avanceObra/${obraId}/previsualizar`, {
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 200 }],
  });
  check("la previsualizacion responde", r.status === 200, `→ ${r.status} ${r.data?.error || ""}`);
  check("avisa del excedente antes de guardar", (r.data?.avisos || []).length === 1, `→ ${r.data?.avisos?.length}`);
  console.log(`     "${r.data?.avisos?.[0]?.mensaje}"`);
  check("el aviso dice el excedente en m3, no en %", cerca(r.data?.avisos?.[0]?.excedente, 150),
    `→ ${r.data?.avisos?.[0]?.excedente}`);
  check("y no guardo nada", (await sql(`SELECT COUNT(*) n FROM avance_obras WHERE obra_id=${obraId}`))[0].n === 0);

  // ── El caso del jardin: 200 m3 sobre 50 ────────────────────────────────
  console.log("\n=== Registrar 200 m3 sobre 50 presupuestados ===");
  r = await req("POST", `/avanceObra/${obraId}`, {
    numero_avance: 1, fecha_avance: "2026-03-15",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-15",
    items: [
      { pliego_item_id: itemExcav, cantidad_ejecutada: 200 },
      { pliego_item_id: itemPared, cantidad_ejecutada: 80 },
    ],
  });
  check("LO GUARDA (no lo rechaza)", r.status === 201, `→ ${r.status} ${r.data?.message || r.data?.error || ""}`);
  if (r.data?.id) avanceIds.push(r.data.id);
  check("avisa que hay excedentes", r.data?.hay_excedentes === true);
  check("un solo aviso: la excavacion", (r.data?.avisos || []).length === 1, `→ ${r.data?.avisos?.length}`);

  const guardado = await sql(`SELECT pliego_item_id, avance_porcentaje, cantidad_ejecutada
                              FROM avance_obra_items WHERE avance_obra_id = ${r.data.id}`);
  const excav = guardado.find((g) => g.pliego_item_id === itemExcav);
  check("guarda los 200 m3, NO los trunca", cerca(excav?.cantidad_ejecutada, 200), `→ ${excav?.cantidad_ejecutada}`);
  check("y el porcentaje queda en 400, no en 100", cerca(excav?.avance_porcentaje, 400), `→ ${excav?.avance_porcentaje}`);

  const pared = guardado.find((g) => g.pliego_item_id === itemPared);
  check("la mamposteria, que no se paso, queda en 80%", cerca(pared?.avance_porcentaje, 80), `→ ${pared?.avance_porcentaje}`);

  // ── La seccion de excedentes ────────────────────────────────────────────
  console.log("\n=== La seccion de excedentes ===");
  r = await req("GET", `/avanceObra/${obraId}/excedentes`);
  check("responde", r.status === 200, `→ ${r.status}`);
  check("lista SOLO el item que se paso", (r.data?.excedentes || []).length === 1, `→ ${r.data?.excedentes?.length}`);
  const e = r.data?.excedentes?.[0];
  check("con la cantidad del pliego (50 m3)", cerca(e?.cantidad_pliego, 50), `→ ${e?.cantidad_pliego}`);
  check("la ejecutada (200 m3)", cerca(e?.cantidad_ejecutada, 200), `→ ${e?.cantidad_ejecutada}`);
  check("y el excedente (150 m3)", cerca(e?.excedente, 150), `→ ${e?.excedente}`);
  check("con su unidad de medida", e?.unidad === "m3", `→ ${e?.unidad}`);
  console.log(`     ${e?.numero_item} ${e?.descripcion}: ${e?.excedente} ${e?.unidad} de mas`);

  console.log("\n=== SIN PRECIO: es una decision, no un olvido ===");
  const texto = JSON.stringify(r.data);
  check("el excedente no trae importe", e?.importe === undefined && e?.precio === undefined && e?.costo === undefined,
    `→ ${JSON.stringify(Object.keys(e || {}))}`);
  check("y la respuesta explica por que", /replanteo|redeterminaci/i.test(r.data?.nota || ""), `→ ${r.data?.nota}`);

  // ── Se acumula entre avances ────────────────────────────────────────────
  console.log("\n=== El excedente se acumula entre avances ===");
  r = await req("POST", `/avanceObra/${obraId}`, {
    numero_avance: 2, fecha_avance: "2026-04-15",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-15",
    items: [{ pliego_item_id: itemPared, cantidad_ejecutada: 40 }],
  });
  if (r.data?.id) avanceIds.push(r.data.id);
  check("el segundo avance guarda", r.status === 201, `→ ${r.status}`);
  // 80 + 40 = 120 m2 sobre 100 → 20 de excedente
  check("avisa que la mamposteria AHORA se paso", (r.data?.avisos || []).length === 1, `→ ${r.data?.avisos?.length}`);
  check("con el excedente acumulado (20 m2)", cerca(r.data?.avisos?.[0]?.excedente, 20), `→ ${r.data?.avisos?.[0]?.excedente}`);

  r = await req("GET", `/avanceObra/${obraId}/excedentes`);
  check("ahora hay dos items excedidos", (r.data?.excedentes || []).length === 2, `→ ${r.data?.excedentes?.length}`);

  // ── Se puede cargar por porcentaje tambien ──────────────────────────────
  console.log("\n=== Tambien se puede cargar por porcentaje ===");
  r = await req("POST", `/avanceObra/${obraId}/previsualizar`, {
    items: [{ pliego_item_id: itemExcav, avance_porcentaje: 50 }],
  });
  check("50% de 50 m3 = 25 m3", cerca(r.data?.items?.[0]?.cantidad_ejecutada, 25), `→ ${r.data?.items?.[0]?.cantidad_ejecutada}`);

  console.log("\n=== Un item de otra obra no entra ===");
  r = await req("POST", `/avanceObra/${obraId}`, {
    numero_avance: 3, fecha_avance: "2026-05-15", periodo_desde: "2026-05-01", periodo_hasta: "2026-05-15",
    items: [{ pliego_item_id: 999999, cantidad_ejecutada: 10 }],
  });
  check("lo rechaza", r.status === 400, `→ ${r.status}`);

  console.log("\n=== Un avance normal no avisa nada ===");
  r = await req("POST", `/avanceObra/${obraId}/previsualizar`, {
    items: [{ pliego_item_id: itemExcav, cantidad_ejecutada: 10 }],
  });
  // 200 ya cargados + 10 = 210, sigue excedido... probamos con una obra limpia
  await sql(`INSERT INTO obras (nombre, createdAt, updatedAt) VALUES ('LIMPIA ${SUF}', NOW(), NOW())`);
  const obraLimpia = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
             VALUES (${obraLimpia}, ${genId}, '1.1', 'Hormigon', 'm3', 100, 20000, 2000000, 'original')`);
  const itemLimpio = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  r = await req("POST", `/avanceObra/${obraLimpia}/previsualizar`, {
    items: [{ pliego_item_id: itemLimpio, cantidad_ejecutada: 60 }],
  });
  check("60 de 100 no genera ningun aviso", (r.data?.avisos || []).length === 0, `→ ${r.data?.avisos?.length}`);
  await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraLimpia}`);
  await sql(`DELETE FROM obras WHERE id = ${obraLimpia}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  for (const id of avanceIds) await sql(`DELETE FROM avance_obra_items WHERE avance_obra_id = ${id}`);
  if (obraId) {
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
    await sql(`DELETE FROM obras WHERE id = ${obraId}`);
  }
  await sql(`DELETE FROM obras WHERE nombre LIKE '%${SUF}%'`);
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedo basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
