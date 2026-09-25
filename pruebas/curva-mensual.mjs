// LA CURVA DE AVANCE ES MENSUAL TAMBIÉN DESPUÉS DEL PLAN
//
// El eje mensual cubría solo los meses de la planificación. Una obra atrasada
// que seguía avanzando después del último mes planificado dibujaba ese tramo
// aparte, un punto por cada carga: con el avance cargado por quincena, la
// curva volvía a verse quincenal ("2026-07-01 → 2026-07-15", "2026-07-16 →
// 2026-07-31"...). Y las certificaciones anuladas seguían sumando en la curva.
//
// Obra de $1.000.000:  A $600k · B $400k
// Original:            m-4 A50 · m-3 A50+B100        → el plan termina en m-3
// Avance real:         m-4 A20 (12%)
//                      m-2 A10 + A10 en dos quincenas (6% + 6%)
//                      m-1 B25 + B25 en dos quincenas (10% + 10%)
// Certificados:        m-2 A20 (12%) · m-1 A30 ANULADO
//
// Las fechas son RELATIVAS al último mes cerrado, para que la suite no caduque.
// Corre SOLO contra una base local de prueba. Ver pruebas/LEEME.md.
import { sequelize } from "../database.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
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
// El token se firma con un usuario real: la certificación guarda quién la creó.
let TK = null;

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

// ── Calendario relativo ────────────────────────────────────────────────
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const pad = (n) => String(n).padStart(2, "0");
const HOY = new Date();
const mesDe = (o) => new Date(HOY.getFullYear(), HOY.getMonth() - 1 + o, 1); // o=0 → último mes cerrado
const desde = (o) => { const d = mesDe(o); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };
const hasta = (o) => { const d = mesDe(o); const u = new Date(d.getFullYear(), d.getMonth() + 1, 0); return `${u.getFullYear()}-${pad(u.getMonth() + 1)}-${pad(u.getDate())}`; };
const q15 = (o) => `${desde(o).slice(0, 8)}15`;
const q16 = (o) => `${desde(o).slice(0, 8)}16`;
const eje = (o) => { const d = mesDe(o); return `${MESES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; };

const SUF = "CM" + Date.now().toString().slice(-6);
let obraId = null;
const id = {};

const en = (c, datos, o) => datos[c.labels.indexOf(eje(o))];

try {
  console.log("=== Preparando la obra ===");
  const hash = await bcrypt.hash("Prueba12345", 10);
  await sql(`INSERT INTO usuarios (nombre, email, password, rol, createdAt, updatedAt)
             VALUES ('Prueba ${SUF}', 'p${SUF}@t.com', '${hash}', 'administrador', NOW(), NOW())`);
  const usuarioId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  TK = jwt.sign({ id: usuarioId, email: `p${SUF}@t.com`, rol: "administrador" }, SECRET, { expiresIn: "1h" });

  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('CURVA ${SUF}', 0, NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt) VALUES ('Generico ${SUF}', 'gl', NOW(), NOW())`);
  const gen = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  for (const [k, costo] of [["A", 600000], ["B", 400000]]) {
    await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
               VALUES (${obraId}, ${gen}, '${k}', 'Item ${k}', 'gl', 1, ${costo}, ${costo}, 'original')`);
    id[k] = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  }

  for (const [o, its] of [[-4, [["A", 50]]], [-3, [["A", 50], ["B", 100]]]]) {
    const r = await req("POST", `/obras/${obraId}/planificacion`, {
      fecha_desde: desde(o), fecha_hasta: hasta(o),
      items: its.map(([k, p]) => ({ pliego_item_id: id[k], porcentaje_planificado: p })),
    });
    if (r.status !== 201) throw new Error(`plan ${o} → ${r.status} ${r.data?.message}`);
  }

  const avances = [
    [1, desde(-4), hasta(-4), [["A", 20]]],
    [2, desde(-2), q15(-2), [["A", 10]]],
    [3, q16(-2), hasta(-2), [["A", 10]]],
    [4, desde(-1), q15(-1), [["B", 25]]],
    [5, q16(-1), hasta(-1), [["B", 25]]],
  ];
  for (const [n, d, h, its] of avances) {
    const r = await req("POST", `/obras/${obraId}/avances`, {
      numero_avance: n, fecha_avance: h, periodo_desde: d, periodo_hasta: h,
      items: its.map(([k, p]) => ({ pliego_item_id: id[k], avance_porcentaje: p })),
    });
    if (r.status !== 201) throw new Error(`avance ${n} → ${r.status} ${r.data?.message}`);
  }

  for (const [n, o, pct] of [[1, -2, 20], [2, -1, 30]]) {
    const r = await req("POST", `/certificaciones/obras/${obraId}/certificaciones`, {
      numero_certificado: n, fecha_certificacion: hasta(o),
      periodo_desde: desde(o), periodo_hasta: hasta(o),
      items: [{ pliego_item_id: id.A, avance_porcentaje: pct }],
    });
    if (r.status !== 201) throw new Error(`certificado ${n} → ${r.status} ${r.data?.error}`);
    id[`cert${n}`] = r.data.certificacion_id;
  }
  const an = await req("POST", `/certificaciones/${id.cert2}/anular`, {});
  if (an.status !== 200) throw new Error(`anular → ${an.status} ${an.data?.error}`);

  const c = (await req("GET", `/obras/${obraId}/curva-avance`)).data;

  console.log("\n=== Después del plan, el eje sigue siendo mensual ===");
  const esperado = ["Inicio", eje(-4), eje(-3), eje(-2), eje(-1)];
  check("un punto por mes, sin cortes ni quincenas",
    JSON.stringify(c.labels) === JSON.stringify(esperado), `→ ${JSON.stringify(c.labels)}`);
  check("ninguna etiqueta es un rango de fechas", !c.labels.some((l) => l.includes("→")));
  check("el mes posterior al plan trae su fecha de cierre",
    c.labelsHasta?.[c.labels.indexOf(eje(-1))] === hasta(-1), `→ ${c.labelsHasta?.[c.labels.indexOf(eje(-1))]}`);

  console.log("\n=== Las quincenas de después del plan suman un solo punto ===");
  check("m-4: 12%", cerca(en(c, c.avance, -4), 12), `→ ${en(c, c.avance, -4)}`);
  check("m-3 sin avance: queda plana en 12%", cerca(en(c, c.avance, -3), 12), `→ ${en(c, c.avance, -3)}`);
  check("m-2: 12 + 6 + 6 = 24%", cerca(en(c, c.avance, -2), 24), `→ ${en(c, c.avance, -2)}`);
  check("m-1: 24 + 10 + 10 = 44%", cerca(en(c, c.avance, -1), 44), `→ ${en(c, c.avance, -1)}`);

  console.log("\n=== El planificado se corta donde termina el plan ===");
  check("m-3: 100%", cerca(en(c, c.planificado, -3), 100), `→ ${en(c, c.planificado, -3)}`);
  check("m-2 y m-1: sin plan", en(c, c.planificado, -2) == null && en(c, c.planificado, -1) == null,
    `→ ${en(c, c.planificado, -2)} / ${en(c, c.planificado, -1)}`);

  console.log("\n=== La certificación anulada no cuenta ===");
  check("m-2: 12% certificado", cerca(en(c, c.certificado, -2), 12), `→ ${en(c, c.certificado, -2)}`);
  check("m-1: sigue en 12% (el anulado no suma)", cerca(en(c, c.certificado, -1), 12), `→ ${en(c, c.certificado, -1)}`);
  check("ni figura su número en el mes", (c.certNumerosPorPeriodo?.[c.labels.indexOf(eje(-1))] || []).length === 0,
    `→ ${JSON.stringify(c.certNumerosPorPeriodo?.[c.labels.indexOf(eje(-1))])}`);
} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (obraId) {
    await sql(`DELETE ci FROM certificacion_items ci
               JOIN certificaciones c ON c.id = ci.certificacion_id WHERE c.obra_id = ${obraId}`);
    await sql(`DELETE FROM certificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM planificacion_items WHERE planificacion_id IN (SELECT id FROM planificaciones WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM planificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM avance_obra_items WHERE avance_obra_id IN (SELECT id FROM avance_obras WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
    await sql(`DELETE FROM obras WHERE id = ${obraId}`);
  }
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}%'`);
  await sql(`DELETE FROM usuarios WHERE email LIKE '%${SUF}%'`);
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedó basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
