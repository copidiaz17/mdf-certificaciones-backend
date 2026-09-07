// Excedentes: ejecutar más de lo que dice el pliego.
//
// El pliego decía 100 m3 y se excavaron 250. Eso pasa en obra, y hasta ahora
// Falube lo RECHAZABA: el avance no se podía guardar, así que los 150 m3 de
// más no existían en ningún lado.
//
// Las tres reglas que se fijan acá:
//
//   1. El AVANCE no tiene tope: se ejecutó, se registra.
//   2. La CERTIFICACIÓN sí: no se factura más de lo contratado.
//   3. Lo que sale hacia el sistema de costos va TOPADO al pliego, porque un
//      excedente no reconocido todavía no es un activo.
//
// Contra una base DE PRUEBA, nunca producción.

import { sequelize } from "../database.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const API = process.env.API_BASE || "http://localhost:3098/api";
const SECRET = process.env.JWT_SECRET;
const TOKEN_API = process.env.API_TOKEN || "prueba-token";

let ok = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n} ${d}`); fail++; } };
const sql = async (q) => { const [r] = await sequelize.query(q); return r; };

const req = async (m, ruta, body, tk, extra = {}) => {
  const r = await fetch(API + ruta, {
    method: m,
    headers: {
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      "Content-Type": "application/json", ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};

const SUF = Date.now().toString().slice(-6);
let obraId = null, itemId = null;

try {
  const base = sequelize.config.database;
  if (!/prueba|test/i.test(base)) {
    console.error(`⛔ La base "${base}" no parece de prueba. Cancelo.`);
    process.exit(1);
  }
  await sequelize.authenticate();
  console.log(`Base de prueba: ${base}\n`);

  const hash = await bcrypt.hash("Prueba12345", 10);
  await sql(`INSERT INTO usuarios (nombre, email, password, rol, createdAt, updatedAt)
             VALUES ('Prueba ${SUF}', 'p${SUF}@t.com', '${hash}', 'administrador', NOW(), NOW())`);
  const usuarioId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  const token = jwt.sign({ id: usuarioId, email: `p${SUF}@t.com`, rol: "administrador" }, SECRET, { expiresIn: "1h" });

  await sql(`INSERT INTO obras (nombre, reparticion, createdAt, updatedAt)
             VALUES ('Obra ${SUF}', 'municipalidad_sgo', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
             VALUES ('Excavacion ${SUF}', 'm3', NOW(), NOW())`);
  const itemGeneralId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  // El pliego dice 100 m3 a $1.000 = $100.000.
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem,
                                      unidadMedida, cantidad, costoUnitario, costoParcial)
             VALUES (${obraId}, ${itemGeneralId}, '1', 'Excavacion', 'm3', 100, 1000, 100000)`);
  itemId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  console.log(`Pliego: 100 m3 · se van a ejecutar 250\n`);

  // ── 1. El avance no tiene tope ────────────────────────────────────────
  console.log("=== Ejecutar 250 m3 sobre un pliego de 100 ===");
  let r = await req("POST", `/obras/${obraId}/avances`, {
    numero_avance: 1, fecha_avance: "2026-03-31",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-31",
    items: [{ pliego_item_id: itemId, cantidad_ejecutada: 250 }],
  }, token);
  check("lo guarda (antes lo rechazaba)", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  check("y avisa del excedente", r.data?.hay_excedentes === true, `→ ${JSON.stringify(r.data?.avisos)}`);

  const guardado = (await sql(`SELECT avance_porcentaje p, cantidad_ejecutada c
                                 FROM avance_obra_items WHERE pliego_item_id = ${itemId}`))[0];
  check("guarda la cantidad, no solo el porcentaje",
    Math.abs(Number(guardado.c) - 250) < 0.001, `→ ${guardado.c}`);
  check("el porcentaje refleja el exceso (250%)",
    Math.abs(Number(guardado.p) - 250) < 0.01, `→ ${guardado.p}`);

  // ── 2. Lo que sale hacia costos va topado ─────────────────────────────
  console.log("\n=== Hacia el sistema de costos va TOPADO al pliego ===");
  r = await req("GET", `/publica/obras/${obraId}/avance`, null, null, { "X-API-Token": TOKEN_API });
  check("responde", r.status === 200, `→ ${r.status}`);
  const item = r.data?.items?.[0];
  check("informa 100%, no 250%",
    item && Math.abs(Number(item.avance_reconocido_porcentaje) - 100) < 0.01,
    `→ ${item?.avance_reconocido_porcentaje}`);
  check("y el importe es el del pliego entero",
    item && Math.abs(Number(item.ejecutado_importe) - 100000) < 1, `→ ${item?.ejecutado_importe}`);
  check("no se filtra el 250 en ningun lado",
    !JSON.stringify(r.data).includes("250"), "aparece 250 en la respuesta");

  // ── 3. La lista de excedentes ─────────────────────────────────────────
  console.log("\n=== La lista de excedentes ===");
  r = await req("GET", `/avanceObra/${obraId}/excedentes`, null, token);
  check("responde", r.status === 200, `→ ${r.status}`);
  const exc = r.data?.excedentes?.[0];
  check("informa 150 m3 de mas", exc && Math.abs(Number(exc.excedente) - 150) < 0.001, `→ ${exc?.excedente}`);
  check("en la unidad del item", exc?.unidad === "m3", `→ ${exc?.unidad}`);
  check("y aclara que va sin precio", /sin precio|no en pesos|cantidad/i.test(r.data?.nota || ""), `→ ${r.data?.nota}`);

  // ── 4. Convertir parte del excedente ──────────────────────────────────
  console.log("\n=== Reconocer 100 de los 150 ===");
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${itemId}/convertir`, { cantidad: 100 }, token);
  check("crea el item nuevo", r.status === 201, `→ ${r.status} ${r.data?.message}`);
  check("quedan 50 pendientes", Math.abs(Number(r.data?.pendiente_restante) - 50) < 0.001, `→ ${r.data?.pendiente_restante}`);

  const nuevo = (await sql(`SELECT numeroItem, cantidad, costoUnitario, costoParcial, origen, item_origen_id
                              FROM pliegoitems WHERE obraId = ${obraId} AND origen = 'excedente'`))[0];
  check("es un item NUEVO, no agranda el original", !!nuevo);
  check("SIN precio", Number(nuevo.costoUnitario) === 0 && Number(nuevo.costoParcial) === 0,
    `→ ${nuevo.costoUnitario} / ${nuevo.costoParcial}`);
  check("con la cantidad reconocida", Math.abs(Number(nuevo.cantidad) - 100) < 0.001, `→ ${nuevo.cantidad}`);
  check("apunta al item del que salio", Number(nuevo.item_origen_id) === Number(itemId));
  check("y el original quedo intacto",
    Math.abs(Number((await sql(`SELECT cantidad FROM pliegoitems WHERE id=${itemId}`))[0].cantidad) - 100) < 0.001);

  console.log("\n=== No se puede reconocer mas de lo que sobra ===");
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${itemId}/convertir`, { cantidad: 80 }, token);
  check("rechaza", r.status === 400, `→ ${r.status}`);
  check("y dice cuanto queda", /50/.test(r.data?.message || ""), `→ ${r.data?.message}`);

  console.log("\n=== Un excedente no genera otro excedente ===");
  const nuevoId = (await sql(`SELECT id FROM pliegoitems WHERE obraId=${obraId} AND origen='excedente'`))[0].id;
  r = await req("POST", `/avanceObra/${obraId}/excedentes/${nuevoId}/convertir`, { cantidad: 10 }, token);
  check("rechaza", r.status === 400, `→ ${r.status}`);

  // ── 5. La certificación SIGUE topada ──────────────────────────────────
  console.log("\n=== La certificacion sigue topada al 100% ===");
  r = await req("POST", `/certificaciones/obras/${obraId}/certificaciones`, {
    numero_certificado: 1, fecha_certificacion: "2026-03-31",
    periodo_desde: "2026-03-01", periodo_hasta: "2026-03-31",
    items: [{ pliego_item_id: itemId, avance_porcentaje: 100 }],
  }, token);
  check("deja certificar el 100%", r.status === 201, `→ ${r.status} ${r.data?.error}`);

  r = await req("POST", `/certificaciones/obras/${obraId}/certificaciones`, {
    numero_certificado: 2, fecha_certificacion: "2026-04-30",
    periodo_desde: "2026-04-01", periodo_hasta: "2026-04-30",
    items: [{ pliego_item_id: itemId, avance_porcentaje: 10 }],
  }, token);
  check("pero NO mas del 100%, aunque se haya ejecutado", r.status === 400, `→ ${r.status}`);
  check("y lo explica", /100%/.test(r.data?.error || ""), `→ ${r.data?.error}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (obraId) {
    await sql(`DELETE ci FROM certificacion_items ci
               JOIN certificaciones c ON c.id = ci.certificacion_id WHERE c.obra_id = ${obraId}`);
    await sql(`DELETE FROM certificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE ai FROM avance_obra_items ai
               JOIN avance_obras a ON a.id = ai.avance_obra_id WHERE a.obra_id = ${obraId}`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
  }
  await sql(`DELETE FROM obras WHERE nombre LIKE '%${SUF}'`);
  await sql(`DELETE FROM usuarios WHERE email LIKE '%${SUF}%'`);
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}'`);
  check("no quedo basura de prueba",
    Number((await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}'`))[0].n) === 0);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
