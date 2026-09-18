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
// Reglas del negocio que se verifican:
//   · el eje es MENSUAL: dos avances quincenales del mismo mes suman un punto
//   · sin el avance de obra al día (último mes cerrado) no se puede replantear;
//     la certificación solo avisa
//   · la curva del replanteo recorre el mismo camino que el avance real y desde
//     el corte sigue lo replanificado, hasta terminar la obra
//
// Las fechas son RELATIVAS al último mes cerrado, para que la suite no caduque.
//   mes 0 = último mes cerrado · negativos = pasado · positivos = futuro
//
// Obra de $1.000.000:  A $400k · B $300k · C $200k · D $100k
// Original mensual:    m-3 A50 · m-2 A50+B50 · m-1 B50+C100 · m0 D100
// Avance real:         m-3 A30 (12%) · m0 A20+B10 (11%)  → 23% al cierre de m0
//
// Corre SOLO contra una base local de prueba. Ver pruebas/LEEME.md.
import { sequelize } from "../database.js";
import { migrar } from "../migraciones.mjs";
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

// ── Calendario relativo ────────────────────────────────────────────────
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const pad = (n) => String(n).padStart(2, "0");
const HOY = new Date();
const mesDe = (o) => new Date(HOY.getFullYear(), HOY.getMonth() - 1 + o, 1); // o=0 → último mes cerrado
const desde = (o) => { const d = mesDe(o); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };
const hasta = (o) => { const d = mesDe(o); const u = new Date(d.getFullYear(), d.getMonth() + 1, 0); return `${u.getFullYear()}-${pad(u.getMonth() + 1)}-${pad(u.getDate())}`; };
const eje = (o) => { const d = mesDe(o); return `${MESES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; };

const SUF = "RP" + Date.now().toString().slice(-6);
let obraId = null, obraAtrasada = null;
const id = {};

const curva = async () => (await req("GET", `/obras/${obraId}/curva-avance`)).data;
const en = (c, datos, etiqueta) => datos[c.labels.indexOf(etiqueta)];
const serie = (c, version) => c.planificacionesCurvas.find((s) => s.version === version);
const maximo = (datos) => Math.max(...datos.filter((v) => v != null));

const mesesV1 = () => [
  { fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.A, porcentaje: 30 }, { pliego_item_id: id.B, porcentaje: 40 }] },
  { fecha_desde: desde(2), fecha_hasta: hasta(2), items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 50 }, { pliego_item_id: id.C, porcentaje: 60 }] },
  { fecha_desde: desde(3), fecha_hasta: hasta(3), items: [{ pliego_item_id: id.C, porcentaje: 40 }, { pliego_item_id: id.D, porcentaje: 100 }] },
];

async function crearObra(nombre) {
  await sql(`INSERT INTO obras (nombre, solo_costo_total, createdAt, updatedAt) VALUES ('${nombre}', 0, NOW(), NOW())`);
  return (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
}

try {
  console.log("=== Preparando la obra ===");
  obraId = await crearObra(`REPLANTEO ${SUF}`);
  if (!(await sql("SELECT id FROM itemgenerals LIMIT 1")).length) {
    await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt) VALUES ('Generico ${SUF}', 'gl', NOW(), NOW())`);
  }
  const gen = (await sql("SELECT id FROM itemgenerals LIMIT 1"))[0].id;
  for (const [k, costo] of [["A", 400000], ["B", 300000], ["C", 200000], ["D", 100000]]) {
    await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
               VALUES (${obraId}, ${gen}, '${k}', 'Item ${k}', 'gl', 1, ${costo}, ${costo}, 'original')`);
    id[k] = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  }
  id.original = [];
  for (const [o, its] of [[-3, [["A", 50]]], [-2, [["A", 50], ["B", 50]]], [-1, [["B", 50], ["C", 100]]], [0, [["D", 100]]]]) {
    const r = await req("POST", `/obras/${obraId}/planificacion`, {
      fecha_desde: desde(o), fecha_hasta: hasta(o),
      items: its.map(([k, p]) => ({ pliego_item_id: id[k], porcentaje_planificado: p })),
    });
    if (r.status !== 201) throw new Error(`original ${o} → ${r.status} ${r.data?.message}`);
    id.original.push(r.data.planificacion_id);
  }

  // El mes 0 se carga en DOS avances quincenales: en la curva tienen que ser
  // un solo punto mensual.
  id.avances = [];
  const avances = [
    [1, desde(-3), hasta(-3), [["A", 30]]],
    [2, desde(0), `${desde(0).slice(0, 8)}15`, [["A", 20]]],
    [3, `${desde(0).slice(0, 8)}16`, hasta(0), [["B", 10]]],
  ];
  for (const [n, d, h, its] of avances) {
    const r = await req("POST", `/obras/${obraId}/avances`, {
      numero_avance: n, fecha_avance: h, periodo_desde: d, periodo_hasta: h,
      items: its.map(([k, p]) => ({ pliego_item_id: id[k], avance_porcentaje: p })),
    });
    if (r.status !== 201) throw new Error(`avance ${n} → ${r.status} ${r.data?.message}`);
    id.avances.push(r.data.id);
  }

  console.log("\n=== El eje es mensual ===");
  let c = await curva();
  check("las dos quincenas del mes son UN punto", c.labels.filter((l) => l === eje(0)).length === 1, `→ ${JSON.stringify(c.labels)}`);
  check("y suman juntas: 12 + 11 = 23", cerca(en(c, c.avance, eje(0)), 23), `→ ${en(c, c.avance, eje(0))}`);
  check("el eje trae la fecha de cierre de cada punto", c.labelsHasta?.[c.labels.indexOf(eje(0))] === hasta(0), `→ ${c.labelsHasta?.[c.labels.indexOf(eje(0))]}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== El plan original se valida en el servidor ===");
  let r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: desde(4), fecha_hasta: hasta(4), tipo: "replanteo",
    items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("un replanteo suelto por la ruta vieja se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: desde(4), fecha_hasta: hasta(4), items: [{ pliego_item_id: 999999999, porcentaje_planificado: 10 }],
  });
  check("un ítem de otra obra se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: desde(4), fecha_hasta: hasta(4), items: [{ pliego_item_id: id.C, porcentaje_planificado: 150 }],
  });
  check("un porcentaje de 150 se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/planificacion`, {
    fecha_desde: desde(4), fecha_hasta: hasta(4), items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("planificar un ítem por encima del 100% sumando meses se rechaza", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Sin avance al día no se replantea ===");
  obraAtrasada = await crearObra(`ATRASADA ${SUF}`);
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen)
             VALUES (${obraAtrasada}, ${gen}, '1', 'Unico', 'gl', 1, 100000, 100000, 'original')`);
  const itemAtrasado = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await req("POST", `/obras/${obraAtrasada}/planificacion`, {
    fecha_desde: desde(-3), fecha_hasta: hasta(-3), items: [{ pliego_item_id: itemAtrasado, porcentaje_planificado: 100 }],
  });
  await req("POST", `/obras/${obraAtrasada}/avances`, {
    numero_avance: 1, fecha_avance: hasta(-3), periodo_desde: desde(-3), periodo_hasta: hasta(-3),
    items: [{ pliego_item_id: itemAtrasado, avance_porcentaje: 20 }],
  });
  r = await req("GET", `/obras/${obraAtrasada}/replanteos/contexto`);
  check("la pantalla avisa que falta avance", !!r.data?.bloqueo, `→ ${r.data?.bloqueo}`);
  check("y dice hasta qué mes hace falta", r.data?.al_dia?.mes_exigido === hasta(0), `→ ${r.data?.al_dia?.mes_exigido}`);
  console.log(`     "${r.data?.bloqueo}"`);
  r = await req("POST", `/obras/${obraAtrasada}/replanteos`, {
    motivo: "tiempo", fecha_corte: hasta(-3),
    meses: [{ fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: itemAtrasado, porcentaje: 80 }] }],
  });
  check("el servidor también lo bloquea", r.status === 400, `→ ${r.status}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== El contexto de la grilla ===");
  r = await req("GET", `/obras/${obraId}/replanteos/contexto`);
  const ctx = r.data;
  const disp = Object.fromEntries(ctx.items.map((i) => [i.id, i.disponible]));
  check("con el avance al día no hay bloqueo", ctx.bloqueo === null, `→ ${ctx.bloqueo}`);
  check("corte sugerido = cierre del último mes", ctx.fecha_corte === hasta(0), `→ ${ctx.fecha_corte}`);
  check("avisa que la certificación no está al día", ctx.al_dia.certificacion_al_dia === false);
  check("avance real de la obra al corte = 23%", cerca(ctx.avance_real_obra, 23), `→ ${ctx.avance_real_obra}`);
  check("disponible: A 50 · B 90 · C 100 · D 100",
    disp[id.A] === 50 && disp[id.B] === 90 && disp[id.C] === 100 && disp[id.D] === 100, `→ ${JSON.stringify(disp)}`);
  check("la próxima versión es la 1", ctx.proxima_version === 1, `→ ${ctx.proxima_version}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Crear el replanteo se valida entero ===");
  const base = { motivo: "tiempo", fecha_corte: hasta(0) };
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.A, porcentaje: 40 }] },
    { fecha_desde: desde(2), fecha_hasta: hasta(2), items: [{ pliego_item_id: id.A, porcentaje: 20 }] },
  ] });
  check("R1 · A planificado 60% entre dos meses con 50% libre → rechazado", r.status === 400, `→ ${r.status}`);
  console.log(`     "${r.data?.message}"`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: desde(0), fecha_hasta: hasta(0), items: [{ pliego_item_id: id.A, porcentaje: 10 }] },
  ] });
  check("un mes anterior al corte se rechaza", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/replanteos`, { ...base, meses: [
    { fecha_desde: desde(1), fecha_hasta: hasta(2), items: [{ pliego_item_id: id.A, porcentaje: 10 }] },
    { fecha_desde: desde(2), fecha_hasta: hasta(3), items: [{ pliego_item_id: id.B, porcentaje: 10 }] },
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
  check("el replanteo (3 meses siguientes) se guarda", r.status === 201 && r.data?.version === 1, `→ ${r.status} ${r.data?.message}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== La curva del replanteo ===");
  c = await curva();
  let v1 = serie(c, 1);
  check("R2 · la curva del replanteo no pasa el 100%", maximo(v1.datos) <= 100.01, `→ ${maximo(v1.datos)}`);
  check("recorre el mismo camino que el avance real: 12% en el primer mes",
    cerca(en(c, v1.datos, eje(-3)), 12) && cerca(en(c, v1.datos, eje(-3)), en(c, c.avance, eje(-3))),
    `→ ${en(c, v1.datos, eje(-3))} vs avance ${en(c, c.avance, eje(-3))}`);
  check("R5 · no se corta en los meses sin avance", cerca(en(c, v1.datos, eje(-2)), 12) && cerca(en(c, v1.datos, eje(-1)), 12),
    `→ ${en(c, v1.datos, eje(-2))} · ${en(c, v1.datos, eje(-1))}`);
  check("llega al corte con el avance real (23%)", cerca(en(c, v1.datos, eje(0)), 23), `→ ${en(c, v1.datos, eje(0))}`);
  check("R7 · y desde ahí reparte mes a mes: 47 · 82 · 100",
    cerca(en(c, v1.datos, eje(1)), 47) && cerca(en(c, v1.datos, eje(2)), 82) && cerca(en(c, v1.datos, eje(3)), 100),
    `→ ${en(c, v1.datos, eje(1))} · ${en(c, v1.datos, eje(2))} · ${en(c, v1.datos, eje(3))}`);
  check("es la vigente", v1.esVigente === true);
  check("la original sigue dibujada y llega a 100", cerca(maximo(serie(c, 0).datos), 100), `→ ${maximo(serie(c, 0).datos)}`);
  check("R3 · 'planificado' no pasa el 100%", maximo(c.planificado) <= 100.01, `→ ${maximo(c.planificado)}`);
  check("'planificado' antes del corte es el original (55%)", cerca(en(c, c.planificado, eje(-2)), 55), `→ ${en(c, c.planificado, eje(-2))}`);
  check("'planificado' después del corte es el replanteo (47%)", cerca(en(c, c.planificado, eje(1)), 47), `→ ${en(c, c.planificado, eje(1))}`);

  console.log("\n=== El historial ===");
  r = await req("GET", `/obras/${obraId}/planificaciones`);
  const hist = r.data;
  check("R4 · ningún acumulado pasa el 100%", hist.every((h) => h.total_porcentaje_acum <= 100.01), `→ ${Math.max(...hist.map((h) => h.total_porcentaje_acum))}`);
  const filasV1 = hist.filter((h) => h.version === 1);
  check("el replanteo acumula desde el 23%: 47 · 82 · 100",
    filasV1.length === 3 && cerca(filasV1[0].total_porcentaje_acum, 47) && cerca(filasV1[2].total_porcentaje_acum, 100),
    `→ ${filasV1.map((f) => f.total_porcentaje_acum).join(" · ")}`);
  check("el original muestra hasta 100", cerca(hist.filter((h) => h.version === 0).at(-1).total_porcentaje_acum, 100));

  const fila = (await sql(`SELECT * FROM planificaciones WHERE obra_id = ${obraId} AND version = 1 ORDER BY fecha_desde LIMIT 1`))[0];
  check("R9 · queda encadenado al plan que reemplaza", fila.planificacion_padre_id === id.original[0], `→ ${fila.planificacion_padre_id}`);
  check("R9 · con el avance del corte", id.avances.includes(fila.avance_corte_id), `→ ${fila.avance_corte_id}`);

  r = await req("GET", `/obras/${obraId}/items-disponible-planificacion`);
  check("el disponible del original no cuenta el replanteo", r.status === 200 && !(r.data || []).some((i) => i.porcentajeDisponible < 0));

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Editar ===");
  const editado = [
    { fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.A, porcentaje: 30 }, { pliego_item_id: id.B, porcentaje: 40 }] },
    { fecha_desde: desde(2), fecha_hasta: hasta(2), items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 50 }] },
    { fecha_desde: desde(3), fecha_hasta: hasta(3), items: [{ pliego_item_id: id.C, porcentaje: 100 }, { pliego_item_id: id.D, porcentaje: 100 }] },
  ];
  r = await req("PUT", `/obras/${obraId}/replanteos/1`, { motivo: "tiempo", meses: editado });
  check("R6 · el replanteo se puede editar", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  c = await curva(); v1 = serie(c, 1);
  check("la edición se refleja: 70 · 100", cerca(en(c, v1.datos, eje(2)), 70) && cerca(en(c, v1.datos, eje(3)), 100),
    `→ ${en(c, v1.datos, eje(2))} · ${en(c, v1.datos, eje(3))}`);
  r = await req("PUT", `/obras/${obraId}/replanteos/1`, { motivo: "tiempo", meses: [
    { fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.B, porcentaje: 95 }] },
  ] });
  check("una edición inválida se rechaza", r.status === 400, `→ ${r.status}`);
  check("y no toca lo guardado", Number((await sql(`SELECT COUNT(*) n FROM planificaciones WHERE obra_id = ${obraId} AND version = 1`))[0].n) === 3);

  r = await req("PUT", `/obras/${obraId}/planificacion/${id.original[1]}`, {
    fecha_desde: desde(-2), fecha_hasta: hasta(-2),
    items: [{ pliego_item_id: id.A, porcentaje_planificado: 50 }, { pliego_item_id: id.B, porcentaje_planificado: 40 }],
  });
  check("un mes del original se puede editar aunque haya replanteo", r.status === 200, `→ ${r.status} ${r.data?.message}`);
  const filaV1 = async () => (await sql(`SELECT id FROM planificaciones WHERE obra_id = ${obraId} AND version = 1 ORDER BY fecha_desde LIMIT 1`))[0].id;
  r = await req("PUT", `/obras/${obraId}/planificacion/${await filaV1()}`, {
    fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.A, porcentaje_planificado: 10 }],
  });
  check("un mes del replanteo NO se edita suelto", r.status === 400, `→ ${r.status}`);

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== Replanteo 2: con adicional y motivo 'ambos' ===");
  r = await req("POST", `/obras/${obraId}/avances`, {
    numero_avance: 4, fecha_avance: hasta(0), periodo_desde: desde(0), periodo_hasta: hasta(0),
    items: [{ pliego_item_id: id.A, avance_porcentaje: 30 }, { pliego_item_id: id.B, avance_porcentaje: 20 }],
  });
  id.avances.push(r.data.id);
  const ctx2 = (await req("GET", `/obras/${obraId}/replanteos/contexto`)).data;
  const disp2 = Object.fromEntries(ctx2.items.map((i) => [i.id, i.disponible]));
  check("el disponible se recalcula con el avance nuevo: A 20 · B 70",
    disp2[id.A] === 20 && disp2[id.B] === 70, `→ ${JSON.stringify(disp2)}`);

  const itemsAntes = Number((await sql(`SELECT COUNT(*) n FROM pliegoitems WHERE obraId = ${obraId}`))[0].n);
  const adicional = { clave: "rampa", descripcionItem: `Rampa ${SUF}`, unidadMedida: "m2", cantidad: 10, costoUnitario: 25000 };
  r = await req("POST", `/obras/${obraId}/replanteos`, {
    motivo: "ambos", fecha_corte: hasta(0), adicionales: [adicional],
    meses: [{ fecha_desde: desde(0), fecha_hasta: hasta(1), items: [{ clave: "rampa", porcentaje: 100 }] }],
  });
  check("R10 · si el replanteo falla, el adicional NO queda en el pliego",
    r.status === 400 && Number((await sql(`SELECT COUNT(*) n FROM pliegoitems WHERE obraId = ${obraId}`))[0].n) === itemsAntes,
    `→ ${r.status}`);

  r = await req("POST", `/obras/${obraId}/replanteos`, {
    motivo: "ambos", fecha_corte: hasta(0), adicionales: [adicional],
    meses: [
      { fecha_desde: desde(1), fecha_hasta: hasta(1), items: [{ pliego_item_id: id.A, porcentaje: 20 }, { pliego_item_id: id.B, porcentaje: 70 }, { clave: "rampa", porcentaje: 50 }] },
      { fecha_desde: desde(2), fecha_hasta: hasta(2), items: [{ pliego_item_id: id.C, porcentaje: 100 }, { pliego_item_id: id.D, porcentaje: 100 }, { clave: "rampa", porcentaje: 50 }] },
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
             VALUES (${obraId}, 'viejo', '${desde(5)}', '${hasta(5)}', 'abierta', 'replanteo', 'tiempo', 0, NOW(), NOW())`);
  await migrar({ silencioso: true });
  const viejo = (await sql(`SELECT version, fecha_corte FROM planificaciones WHERE obra_id = ${obraId} AND nombre = 'viejo'`))[0];
  check("un replanteo viejo pasa a versión propia", Number(viejo.version) === 2, `→ ${viejo.version}`);
  check("con corte el día anterior a su mes", String(viejo.fecha_corte).slice(0, 10) === hasta(4), `→ ${viejo.fecha_corte}`);
  await migrar({ silencioso: true });
  const otraVez = (await sql(`SELECT version FROM planificaciones WHERE obra_id = ${obraId} AND nombre = 'viejo'`))[0];
  check("la migración es idempotente", Number(otraVez.version) === 2, `→ ${otraVez.version}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  for (const o of [obraId, obraAtrasada]) {
    if (!o) continue;
    await sql(`DELETE FROM planificacion_items WHERE planificacion_id IN (SELECT id FROM planificaciones WHERE obra_id = ${o})`);
    await sql(`DELETE FROM planificaciones WHERE obra_id = ${o}`);
    await sql(`DELETE FROM avance_obra_items WHERE avance_obra_id IN (SELECT id FROM avance_obras WHERE obra_id = ${o})`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${o}`);
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
