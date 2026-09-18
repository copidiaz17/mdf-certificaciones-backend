// REPLANTEO COMO VERSIÓN DEL PLAN DE TRABAJOS
//
// Antes del arreglo (17/09/2026) había 10 fallas confirmadas contra el
// servidor real. Las más graves:
//   · replantear mes a mes volvía a ofrecer el mismo disponible → curva 120%
//   · "planificado" sumaba original + replanteo → 197%
//   · un replanteo de varios meses caía entero el último día
//   · el replanteo por ítem adicional nunca funcionó (ItemGeneralId null)
//   · un replanteo no se podía editar ni borrar
//
// Obra de $1.000.000:  A $400k · B $300k · C $200k · D $100k
// Original mensual:    ene A50 · feb A50+B50 · mar B50+C100 · abr D100
// Avance real:         ene A30 (12%) · feb A20+B10 (11%)  → 23% al 28/02
//
// Corre SOLO contra una base local de prueba. Ver pruebas/LEEME.md.
import { sequelize } from "../database.js";
import { migrar } from "../migraciones.mjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import { fileURLToPath } from "url";
import * as _path from "path";

const _RAIZ = _path.join(_path.dirname(fileURLToPath(import.meta.url)), "..");

// Freno: esta suite crea, edita y borra, y además corre migraciones.
const host = String(process.env.DB_HOST || "").toLowerCase();
if (!["localhost", "127.0.0.1"].includes(host) || !/prueba/i.test(process.env.DB_NAME || "")) {
  console.error("⛔ Solo contra una base LOCAL cuyo nombre diga 'prueba'. DB_HOST y DB_NAME actuales no califican.");
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

const SUF = "RP" + Date.now().toString().slice(-6);
let obraId = null;
const id = {};

const curva = async () => (await req("GET", `/obras/${obraId}/curva-avance`)).data;
const en = (c, datos, etiqueta) => datos[c.labels.indexOf(etiqueta)];
const serie = (c, version) => c.planificacionesCurvas.find((s) => s.version === version);
const maximo = (datos) => Math.max(...datos.filter((v) => v != null));

// v1: reparte EXACTAMENTE lo que falta ejecutar al 28/02
const mesesV1 = () => [
  { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.A, porcentaje: 30 }, { pliego_item_id: id.B, porcentaje: 40 }] },
  { fecha_desde: "2026-04-01", fecha_hasta: "2026-04-30", items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 50 }, { pliego_item_id: id.C, porcentaje: 60 }] },
  { fecha_desde: "2026-05-01", fecha_hasta: "2026-05-31", items: [{ pliego_item_id: id.C, porcentaje: 40 }, { pliego_item_id: id.D, porcentaje: 100 }] },
];

try {
  console.log("=== Preparando la obra ===");
  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('REPLANTEO ${SUF}', 0, NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  if (!(await sql("SELECT id FROM itemgenerals LIMIT 1")).length) {
    await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt) VALUES ('Generico ${SUF}', 'gl', NOW(), NOW())`);
  }
  const gen = (await sql("SELECT id FROM itemgenerals LIMIT 1"))[0].id;
  for (const [k, costo] of [["A", 400000], ["B", 300000], ["C", 200000], ["D", 100000]]) {
    await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
               VALUES (${obraId}, ${gen}, '${k}', 'Item ${k}', 'gl', 1, ${costo}, ${costo}, 'original')`);
    id[k] = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  }
  const original = [
    ["2026-01-01", "2026-01-31", [["A", 50]]],
    ["2026-02-01", "2026-02-28", [["A", 50], ["B", 50]]],
    ["2026-03-01", "2026-03-31", [["B", 50], ["C", 100]]],
    ["2026-04-01", "2026-04-30", [["D", 100]]],
  ];
  id.original = [];
  for (const [d, h, its] of original) {
    const r = await req("POST", `/obras/${obraId}/planificacion`, {
      fecha_desde: d, fecha_hasta: h, items: its.map(([k, p]) => ({ pliego_item_id: id[k], porcentaje_planificado: p })),
    });
    if (r.status !== 201) throw new Error(`original ${d} → ${r.status} ${r.data?.message}`);
    id.original.push(r.data.planificacion_id);
  }
  id.avances = [];
  for (const [n, d, h, its] of [
    [1, "2026-01-01", "2026-01-31", [["A", 30]]],
    [2, "2026-02-01", "2026-02-28", [["A", 20], ["B", 10]]],
  ]) {
    const r = await req("POST", `/obras/${obraId}/avances`, {
      numero_avance: n, fecha_avance: h, periodo_desde: d, periodo_hasta: h,
      items: its.map(([k, p]) => ({ pliego_item_id: id[k], avance_porcentaje: p })),
    });
    if (r.status !== 201) throw new Error(`avance ${n} → ${r.status}`);
    id.avances.push(r.data.id);
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== El plan original se valida en el servidor ===");
  let r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: "2026-06-01", fecha_hasta: "2026-06-30", tipo: "replanteo",
    items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("un replanteo suelto por la ruta vieja se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: "2026-06-01", fecha_hasta: "2026-06-30", items: [{ pliego_item_id: 999999999, porcentaje_planificado: 10 }],
  });
  check("un ítem de otra obra se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: "2026-06-01", fecha_hasta: "2026-06-30", items: [{ pliego_item_id: id.C, porcentaje_planificado: 150 }],
  });
  check("un porcentaje de 150 se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: "2026-06-01", fecha_hasta: "2026-06-30", items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("planificar un ítem por encima del 100% sumando meses se rechaza", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== El contexto de la grilla ===");
  r = await req("GET", `/obras/${obraId}/replanteos/contexto`);
  const ctx = r.data;
  const disp = Object.fromEntries(ctx.items.map((i) => [i.id, i.disponible]));
  check("corte sugerido = último avance (28/02)", ctx.fecha_corte === "2026-02-28", `→ ${ctx.fecha_corte}`);
  check("avance real de la obra al corte = 23%", cerca(ctx.avance_real_obra, 23), `→ ${ctx.avance_real_obra}`);
  check("disponible: A 50 · B 90 · C 100 · D 100",
    disp[id.A] === 50 && disp[id.B] === 90 && disp[id.C] === 100 && disp[id.D] === 100, `→ ${JSON.stringify(disp)}`);
  check("la próxima versión es la 1", ctx.proxima_version === 1, `→ ${ctx.proxima_version}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Crear el replanteo se valida entero ===");
  const base = { motivo: "tiempo", fecha_corte: "2026-02-28" };
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.A, porcentaje: 40 }] },
    { fecha_desde: "2026-04-01", fecha_hasta: "2026-04-30", items: [{ pliego_item_id: id.A, porcentaje: 20 }] },
  ] });
  check("R1 · A planificado 60% entre dos meses con 50% libre → rechazado", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: "2026-02-01", fecha_hasta: "2026-02-28", items: [{ pliego_item_id: id.A, porcentaje: 10 }] },
  ] });
  check("un mes anterior al corte se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.A, porcentaje: 10 }] },
    { fecha_desde: "2026-03-15", fecha_hasta: "2026-04-15", items: [{ pliego_item_id: id.B, porcentaje: 10 }] },
  ] });
  check("dos meses que se pisan se rechazan", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, motivo: "cualquiera", meses: mesesV1() });
  check("un motivo inválido se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: mesesV1(), adicionales: [
    { clave: "x", descripcionItem: "Algo", cantidad: 1, costoUnitario: 1 },
  ] });
  check("un adicional con motivo 'solo plazo' se rechaza", r.status === 400, `→ ${r.status}`);
  check("ninguno de los rechazos dejó filas", Number((await sql(`SELECT COUNT(*) n FROM planificaciones WHERE obra_id = ${obraId} AND version > 0`))[0].n) === 0);

  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: mesesV1() });
  check("replanteo 1 (marzo a mayo) se guarda", r.status === 201 && r.data?.version === 1, `→ ${r.status} ${r.data?.message}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== La curva del replanteo ===");
  let c = await curva();
  let v1 = serie(c, 1);
  check("R2 · la curva del replanteo no pasa el 100%", maximo(v1.datos) <= 100.01, `→ ${maximo(v1.datos)}`);
  check("arranca en el avance real al corte (23% en 2ª q feb)", cerca(en(c, v1.datos, "2ª q feb 26"), 23), `→ ${en(c, v1.datos, "2ª q feb 26")}`);
  check("R5 · no se corta: 1ª q mar sigue en 23", cerca(en(c, v1.datos, "1ª q mar 26"), 23), `→ ${en(c, v1.datos, "1ª q mar 26")}`);
  check("R7 · se reparte mes a mes: mar 47 · abr 82 · may 100",
    cerca(en(c, v1.datos, "2ª q mar 26"), 47) && cerca(en(c, v1.datos, "2ª q abr 26"), 82) && cerca(en(c, v1.datos, "2ª q may 26"), 100),
    `→ ${en(c, v1.datos, "2ª q mar 26")} · ${en(c, v1.datos, "2ª q abr 26")} · ${en(c, v1.datos, "2ª q may 26")}`);
  check("es la vigente", v1.esVigente === true);
  check("la original sigue dibujada y llega a 100", cerca(maximo(serie(c, 0).datos), 100), `→ ${maximo(serie(c, 0).datos)}`);
  check("R3 · 'planificado' no pasa el 100%", maximo(c.planificado) <= 100.01, `→ ${maximo(c.planificado)}`);
  check("'planificado' antes del corte es el original (feb 55%)", cerca(en(c, c.planificado, "2ª q feb 26"), 55), `→ ${en(c, c.planificado, "2ª q feb 26")}`);
  check("'planificado' después del corte es el replanteo (mar 47%)", cerca(en(c, c.planificado, "2ª q mar 26"), 47), `→ ${en(c, c.planificado, "2ª q mar 26")}`);

  console.log("\n=== El historial ===");
  r = await req("GET", `/obras/${obraId}/planificaciones`);
  const hist = r.data;
  check("R4 · ningún acumulado pasa el 100%", hist.every((h) => h.total_porcentaje_acum <= 100.01), `→ ${Math.max(...hist.map((h) => h.total_porcentaje_acum))}`);
  const filasV1 = hist.filter((h) => h.version === 1);
  check("el replanteo muestra sus 3 meses, acumulando desde el 23%: 47 · 82 · 100",
    filasV1.length === 3 && cerca(filasV1[0].total_porcentaje_acum, 47) && cerca(filasV1[2].total_porcentaje_acum, 100),
    `→ ${filasV1.map((f) => f.total_porcentaje_acum).join(" · ")}`);
  check("el original muestra hasta 100", cerca(hist.filter((h) => h.version === 0).at(-1).total_porcentaje_acum, 100));

  const fila = (await sql(`SELECT * FROM planificaciones WHERE obra_id = ${obraId} AND version = 1 ORDER BY fecha_desde LIMIT 1`))[0];
  check("R9 · queda encadenado al plan que reemplaza", fila.planificacion_padre_id === id.original[0], `→ ${fila.planificacion_padre_id}`);
  check("R9 · con el avance del corte", fila.avance_corte_id === id.avances[1], `→ ${fila.avance_corte_id}`);

  r = await req("GET", `/obras/${obraId}/items-disponible-planificacion`);
  check("el disponible del original no cuenta el replanteo", r.status === 200 && !(r.data || []).some((i) => i.porcentajeDisponible < 0));

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Editar ===");
  // Se pasa todo el ítem C de abril a mayo.
  const editado = [
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.A, porcentaje: 30 }, { pliego_item_id: id.B, porcentaje: 40 }] },
    { fecha_desde: "2026-04-01", fecha_hasta: "2026-04-30", items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 50 }] },
    { fecha_desde: "2026-05-01", fecha_hasta: "2026-05-31", items: [{ pliego_item_id: id.C, porcentaje: 100 }, { pliego_item_id: id.D, porcentaje: 100 }] },
  ];
  r = await req("PUT", `/obras/${obraId}/replanteos/1`, { motivo: "tiempo", meses: editado });
  check("R6 · el replanteo se puede editar", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  c = await curva(); v1 = serie(c, 1);
  check("la edición se refleja: abr 70 · may 100",
    cerca(en(c, v1.datos, "2ª q abr 26"), 70) && cerca(en(c, v1.datos, "2ª q may 26"), 100),
    `→ ${en(c, v1.datos, "2ª q abr 26")} · ${en(c, v1.datos, "2ª q may 26")}`);
  r = await req("PUT", `/obras/${obraId}/replanteos/1`, { motivo: "tiempo", meses: [
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.B, porcentaje: 95 }] },
  ] });
  check("una edición inválida se rechaza", r.status === 400, `→ ${r.status}`);
  check("y no toca lo guardado", Number((await sql(`SELECT COUNT(*) n FROM planificaciones WHERE obra_id = ${obraId} AND version = 1`))[0].n) === 3);

  r = await req("PUT", `/obras/${obraId}/planificacion/${id.original[1]}`, {
    fecha_desde: "2026-02-01", fecha_hasta: "2026-02-28",
    items: [{ pliego_item_id: id.A, porcentaje_planificado: 50 }, { pliego_item_id: id.B, porcentaje_planificado: 40 }],
  });
  check("un mes del original se puede editar aunque haya replanteo", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  // Editar reemplaza las filas de la versión: el id de antes ya no existe.
  const filaV1 = async () => (await sql(`SELECT id FROM planificaciones WHERE obra_id = ${obraId} AND version = 1 ORDER BY fecha_desde LIMIT 1`))[0].id;
  r = await req("PUT", `/obras/${obraId}/planificacion/${await filaV1()}`, {
    fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("un mes del replanteo NO se edita suelto", r.status === 400, `→ ${r.status}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Replanteo 2: con adicional y motivo 'ambos' ===");
  r = await req("POST", `/obras/${obraId}/avances`, {
    numero_avance: 3, fecha_avance: "2026-03-31", periodo_desde: "2026-03-01", periodo_hasta: "2026-03-31",
    items: [{ pliego_item_id: id.A, avance_porcentaje: 30 }, { pliego_item_id: id.B, avance_porcentaje: 20 }],
  });
  id.avances.push(r.data.id);
  const ctx2 = (await req("GET", `/obras/${obraId}/replanteos/contexto`)).data;
  const disp2 = Object.fromEntries(ctx2.items.map((i) => [i.id, i.disponible]));
  check("nuevo corte 31/03 y disponible recalculado: A 20 · B 70",
    ctx2.fecha_corte === "2026-03-31" && disp2[id.A] === 20 && disp2[id.B] === 70, `→ ${ctx2.fecha_corte} ${JSON.stringify(disp2)}`);

  const itemsAntes = Number((await sql(`SELECT COUNT(*) n FROM pliegoitems WHERE obraId = ${obraId}`))[0].n);
  const adicional = { clave: "rampa", descripcionItem: `Rampa ${SUF}`, unidadMedida: "m2", cantidad: 10, costoUnitario: 25000 };
  r = await req("POST", `/obras/${obraId}/replanteos`, {
    motivo: "ambos", fecha_corte: "2026-03-31", adicionales: [adicional],
    meses: [{ fecha_desde: "2026-03-15", fecha_hasta: "2026-04-30", items: [{ clave: "rampa", porcentaje: 100 }] }],
  });
  check("R10 · si el replanteo falla, el adicional NO queda en el pliego",
    r.status === 400 && Number((await sql(`SELECT COUNT(*) n FROM pliegoitems WHERE obraId = ${obraId}`))[0].n) === itemsAntes,
    `→ ${r.status}`);

  r = await req("POST", `/obras/${obraId}/replanteos`, {
    motivo: "ambos", fecha_corte: "2026-03-31", adicionales: [adicional],
    meses: [
      { fecha_desde: "2026-04-01", fecha_hasta: "2026-04-30", items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 70 }, { clave: "rampa", porcentaje: 50 }] },
      { fecha_desde: "2026-05-01", fecha_hasta: "2026-05-31", items: [{ pliego_item_id: id.C, porcentaje: 100 }, { pliego_item_id: id.D, porcentaje: 100 }, { clave: "rampa", porcentaje: 50 }] },
    ],
  });
  check("R11 · el replanteo por adicional FUNCIONA", r.status === 201 && r.data?.version === 2, `→ ${r.status} ${r.data?.message}`);
  const nuevo = (await sql(`SELECT * FROM pliegoitems WHERE obraId = ${obraId} AND origen = 'adicional'`))[0];
  check("el adicional entró al pliego con su ítem maestro y su costo",
    nuevo && nuevo.ItemGeneralId && cerca(nuevo.costoParcial, 250000), `→ ${JSON.stringify(nuevo && { g: nuevo.ItemGeneralId, c: nuevo.costoParcial })}`);
  const motivo = (await sql(`SELECT DISTINCT motivo FROM planificaciones WHERE obra_id = ${obraId} AND version = 2`))[0]?.motivo;
  check("R8 · el motivo 'ambos' se guarda", motivo === "ambos", `→ ${motivo}`);

  c = await curva();
  const v2 = serie(c, 2);
  check("la vigente pasa a ser la 2 y la 1 queda como historia", v2?.esVigente === true && serie(c, 1)?.esVigente === false);
  check("con el adicional el presupuesto sube, y la curva igual cierra en 100", cerca(maximo(v2.datos), 100) && maximo(v2.datos) <= 100.01, `→ ${maximo(v2.datos)}`);
  check("'planificado' sigue sin pasar el 100%", maximo(c.planificado) <= 100.01, `→ ${maximo(c.planificado)}`);

  r = await req("PUT", `/obras/${obraId}/replanteos/1`, { motivo: "tiempo", meses: mesesV1() });
  check("un replanteo que ya no es el vigente no se edita", r.status === 400, `→ ${r.status}`);
  r = await req("DELETE", `/obras/${obraId}/replanteos/1`);
  check("ni se borra", r.status === 400, `→ ${r.status}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Borrar ===");
  r = await req("DELETE", `/obras/${obraId}/replanteos/2`);
  check("el replanteo vigente se borra entero", r.status === 200, `→ ${r.status}`);
  check("y avisa que el adicional sigue en el pliego", r.data?.adicionales_en_pliego === 1, `→ ${r.data?.adicionales_en_pliego}`);
  c = await curva();
  check("vuelve a regir el replanteo 1", serie(c, 1)?.esVigente === true && !serie(c, 2));

  r = await req("DELETE", `/obras/${obraId}/planificacion/${await filaV1()}`);
  check("un mes del replanteo no se borra suelto", r.status === 400, `→ ${r.status}`);
  r = await req("DELETE", `/obras/${obraId}/planificacion/${id.original[3]}`);
  check("un mes del original se puede borrar", r.status === 200, `→ ${r.status}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Migración de los replanteos cargados antes ===");
  await sql(`INSERT INTO planificaciones (obra_id, nombre, fecha_desde, fecha_hasta, estado, tipo, motivo, version, createdAt, updatedAt)
             VALUES (${obraId}, 'viejo', '2026-06-01', '2026-06-30', 'abierta', 'replanteo', 'tiempo', 0, NOW(), NOW())`);
  await migrar({ silencioso: true });
  const viejo = (await sql(`SELECT version, fecha_corte FROM planificaciones WHERE obra_id = ${obraId} AND nombre = 'viejo'`))[0];
  check("un replanteo viejo pasa a versión propia", Number(viejo.version) === 2, `→ ${viejo.version}`);
  check("con corte el día anterior a su mes", String(viejo.fecha_corte).slice(0, 10) === "2026-05-31", `→ ${viejo.fecha_corte}`);
  await migrar({ silencioso: true });
  const otraVez = (await sql(`SELECT version FROM planificaciones WHERE obra_id = ${obraId} AND nombre = 'viejo'`))[0];
  check("la migración es idempotente", Number(otraVez.version) === 2, `→ ${otraVez.version}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (obraId) {
    await sql(`DELETE FROM planificacion_items WHERE planificacion_id IN (SELECT id FROM planificaciones WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM planificaciones WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM avance_obra_items WHERE avance_obra_id IN (SELECT id FROM avance_obras WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
    await sql(`DELETE FROM obras WHERE id = ${obraId}`);
  }
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}%'`);
  const q = await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}%'`);
  check("no quedó basura de prueba", Number(q[0].n) === 0, `→ ${q[0].n}`);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
