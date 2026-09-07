// Informe de avance de obra.
//
// El jefe de obra elige un rango y el sistema arma lo que se ejecutó en ese
// período. Lo que se fija acá, sobre todo, es que el informe quede CONGELADO:
// si después alguien carga un avance atrasado, el informe viejo tiene que
// seguir diciendo lo mismo que se entregó.
//
// Contra una base DE PRUEBA, nunca producción.

import { fileURLToPath } from "url";
import * as _path from "path";
const _RAIZ = _path.join(_path.dirname(fileURLToPath(import.meta.url)), "..");

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

const SUF = "IA" + Date.now().toString().slice(-6);
let obraId = null, itemA = null, itemB = null, informeId = null;

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
             VALUES ('Jefe ${SUF}', 'j${SUF}@t.com', '${hash}', 'administrador', NOW(), NOW())`);
  const usuarioId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  const token = jwt.sign({ id: usuarioId, email: `j${SUF}@t.com`, nombre: `Jefe ${SUF}`, rol: "administrador" }, SECRET, { expiresIn: "1h" });

  await sql(`INSERT INTO obras (nombre, reparticion, createdAt, updatedAt)
             VALUES ('Obra ${SUF}', 'municipalidad_sgo', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
             VALUES ('Gen ${SUF}', 'm3', NOW(), NOW())`);
  const genId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  const nuevoItem = async (num, desc, unidad, cant, precio) => {
    await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem,
                                        unidadMedida, cantidad, costoUnitario, costoParcial)
               VALUES (${obraId}, ${genId}, '${num}', '${desc}', '${unidad}', ${cant}, ${precio}, ${cant * precio})`);
    return (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  };
  // Dos ítems de $500.000 cada uno: el contrato son $1.000.000.
  itemA = await nuevoItem("1", "Excavacion", "m3", 100, 5000);
  itemB = await nuevoItem("2", "Hormigon", "m2", 50, 10000);
  // Un tercero que NO se va a tocar nunca: no debe aparecer en el detalle.
  await nuevoItem("3", "Pintura", "m2", 200, 500);
  console.log("Pliego: 100 m3 + 50 m2 + 200 m2 sin tocar · contrato $1.100.000\n");

  const cargarAvance = async (numero, fecha, items) => {
    const r = await req("POST", `/obras/${obraId}/avances`, {
      numero_avance: numero, fecha_avance: fecha,
      periodo_desde: fecha, periodo_hasta: fecha, items,
    }, token);
    if (r.status !== 201) throw new Error(`avance ${numero}: ${r.status} ${JSON.stringify(r.data)}`);
  };

  // Febrero: 30 m3. Marzo: 20 m3 más y 25 m2.
  await cargarAvance(1, "2026-02-20", [{ pliego_item_id: itemA, cantidad_ejecutada: 30 }]);
  await cargarAvance(2, "2026-03-10", [{ pliego_item_id: itemA, cantidad_ejecutada: 20 }]);
  await cargarAvance(3, "2026-03-25", [{ pliego_item_id: itemB, cantidad_ejecutada: 25 }]);

  console.log("=== Informe de marzo: solo lo de marzo, con el acumulado ===");
  let r = await req("POST", `/obras/${obraId}/informes-avance/previsualizar`,
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31" }, token);
  check("responde", r.status === 200, `→ ${r.status} ${r.data?.error}`);

  const inf = r.data?.informe;
  check("dice el rango", inf?.periodo?.desde === "2026-03-01" && inf?.periodo?.hasta === "2026-03-31");
  check("deja afuera el item que nunca se toco", inf?.items?.length === 2, `→ ${inf?.items?.length}`);
  check("y lo aclara en los totales",
    inf?.totales?.items_del_pliego === 3 && inf?.totales?.items_con_movimiento === 2,
    `→ ${inf?.totales?.items_del_pliego}/${inf?.totales?.items_con_movimiento}`);

  const a = inf?.items?.find((x) => x.pliego_item_id === itemA);
  check("la excavacion: 20 m3 en el periodo", Math.abs(a?.cantidad_periodo - 20) < 0.001, `→ ${a?.cantidad_periodo}`);
  check("venia de 30% de febrero", Math.abs(a?.porcentaje_previo - 30) < 0.01, `→ ${a?.porcentaje_previo}`);
  check("y queda en 50% acumulado", Math.abs(a?.porcentaje_acumulado - 50) < 0.01, `→ ${a?.porcentaje_acumulado}`);
  check("con la unidad del item", a?.unidad === "m3", `→ ${a?.unidad}`);

  const b = inf?.items?.find((x) => x.pliego_item_id === itemB);
  check("el hormigon: 25 m2, sin nada previo",
    Math.abs(b?.cantidad_periodo - 25) < 0.001 && b?.porcentaje_previo === 0, `→ ${b?.cantidad_periodo} / ${b?.porcentaje_previo}`);

  // Marzo: 20 m3 × $5.000 = $100.000 + 25 m2 × $10.000 = $250.000 → $350.000
  check("el ejecutado del periodo",
    Math.abs(inf?.totales?.ejecutado_periodo_importe - 350000) < 1, `→ ${inf?.totales?.ejecutado_periodo_importe}`);
  // Acumulado: 50 m3 ($250.000) + 25 m2 ($250.000) = $500.000 sobre $1.100.000
  check("el acumulado",
    Math.abs(inf?.totales?.ejecutado_acumulado_importe - 500000) < 1, `→ ${inf?.totales?.ejecutado_acumulado_importe}`);
  check("y el porcentaje ponderado sobre el contrato",
    Math.abs(inf?.totales?.avance_acumulado_porcentaje - 45.45) < 0.05, `→ ${inf?.totales?.avance_acumulado_porcentaje}`);
  check("dice que avances entraron", inf?.avances_incluidos?.length === 2, `→ ${inf?.avances_incluidos?.length}`);

  console.log("\n=== Se guarda ===");
  r = await req("POST", `/obras/${obraId}/informes-avance`, {
    fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31",
    titulo: "Avance de marzo",
    observaciones: "Se abrio el frente sur. Falta material para el hormigon del sector B.",
  }, token);
  check("lo guarda", r.status === 201, `→ ${r.status} ${r.data?.error}`);
  informeId = r.data?.id;

  console.log("\n=== Y AHORA CARGO UN AVANCE ATRASADO DE MARZO ===");
  // Es el caso que justifica congelar: si el informe recalculara, el que ya
  // se entregó pasaria a decir otra cosa.
  await cargarAvance(4, "2026-03-28", [{ pliego_item_id: itemA, cantidad_ejecutada: 40 }]);

  r = await req("GET", `/obras/${obraId}/informes-avance/${informeId}`, null, token);
  check("el informe guardado se abre", r.status === 200, `→ ${r.status}`);
  const g = r.data?.datos;
  check("SIGUE diciendo lo mismo que cuando se entrego",
    Math.abs(g?.totales?.ejecutado_periodo_importe - 350000) < 1, `→ ${g?.totales?.ejecutado_periodo_importe}`);
  const ga = g?.items?.find((x) => x.pliego_item_id === itemA);
  check("la excavacion sigue en 20 m3, no 60", Math.abs(ga?.cantidad_periodo - 20) < 0.001, `→ ${ga?.cantidad_periodo}`);
  check("conserva las observaciones",
    /frente sur/i.test(r.data?.observaciones || ""), `→ ${r.data?.observaciones}`);
  check("y quien lo firmo", r.data?.autor?.id === usuarioId, `→ ${JSON.stringify(r.data?.autor)}`);

  console.log("\n=== Un informe nuevo del mismo rango SI ve el atrasado ===");
  r = await req("POST", `/obras/${obraId}/informes-avance/previsualizar`,
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31" }, token);
  check("ahora son 60 m3 en el periodo",
    Math.abs(r.data?.informe?.items?.find((x) => x.pliego_item_id === itemA)?.cantidad_periodo - 60) < 0.001,
    `→ ${r.data?.informe?.items?.find((x) => x.pliego_item_id === itemA)?.cantidad_periodo}`);

  console.log("\n=== El excedente se informa en su unidad ===");
  // 30 + 20 + 40 = 90, y despues 30 mas = 120 sobre un pliego de 100 m3.
  await cargarAvance(5, "2026-04-05", [{ pliego_item_id: itemA, cantidad_ejecutada: 30 }]);
  r = await req("POST", `/obras/${obraId}/informes-avance/previsualizar`,
    { fecha_desde: "2026-04-01", fecha_hasta: "2026-04-30" }, token);
  const ex = r.data?.informe?.items?.find((x) => x.pliego_item_id === itemA);
  check("120 m3 acumulados sobre un pliego de 100", Math.abs(ex?.cantidad_acumulada - 120) < 0.001, `→ ${ex?.cantidad_acumulada}`);
  check("informa 20 m3 de excedente", Math.abs(ex?.excedente - 20) < 0.001, `→ ${ex?.excedente}`);
  check("y los cuenta en los totales", r.data?.informe?.totales?.items_con_excedente === 1);
  // El ponderado se topa: 100% del item A ($500.000) + 25 m2 ($250.000)
  check("el acumulado NO cuenta el excedente como plata",
    Math.abs(r.data?.informe?.totales?.ejecutado_acumulado_importe - 750000) < 1,
    `→ ${r.data?.informe?.totales?.ejecutado_acumulado_importe}`);

  console.log("\n=== Lo que no deja hacer ===");
  r = await req("POST", `/obras/${obraId}/informes-avance`, { fecha_desde: "2026-05-31", fecha_hasta: "2026-05-01" }, token);
  check("un rango al reves", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/${obraId}/informes-avance`, { fecha_desde: "marzo" }, token);
  check("una fecha que no es fecha", r.status === 400, `→ ${r.status}`);
  r = await req("POST", `/obras/999999/informes-avance`, { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31" }, token);
  check("una obra que no existe", r.status === 404, `→ ${r.status}`);
  r = await req("GET", `/obras/${obraId}/informes-avance/${informeId}`);
  check("sin sesion no se lee", r.status === 401 || r.status === 403, `→ ${r.status}`);

  console.log("\n=== El listado ===");
  r = await req("GET", `/obras/${obraId}/informes-avance`, null, token);
  check("lo lista", Array.isArray(r.data) && r.data.length === 1, `→ ${r.data?.length}`);
  check("con su titulo y su rango",
    r.data?.[0]?.titulo === "Avance de marzo" && r.data?.[0]?.fecha_hasta?.slice(0, 10) === "2026-03-31");
  check("sin arrastrar los datos pesados", r.data?.[0]?.datos === undefined);

  console.log("\n=== Un periodo sin avances se puede informar igual ===");
  // "En este mes no se hizo nada" también es un informe, y a veces el que más
  // hay que poder mostrar.
  r = await req("POST", `/obras/${obraId}/informes-avance`,
    { fecha_desde: "2026-01-01", fecha_hasta: "2026-01-31", observaciones: "Obra parada por lluvia." }, token);
  check("lo guarda", r.status === 201, `→ ${r.status}`);
  check("y avisa que no hubo movimiento", /no hubo avances/i.test(r.data?.message || ""), `→ ${r.data?.message}`);

  console.log("\n=== Un trabajo que el pliego NO tiene ===");
  // Aparece en obra algo que no estaba contratado. Antes habia que salir de la
  // pantalla, ir al pliego y volver — y si no se volvia, no quedaba en ningun
  // lado.
  let ra = await req("POST", `/avanceObra/${obraId}/items`,
    { descripcion: `Demolicion ${SUF}`, unidad: "m3", cantidad: 40 }, token);
  check("lo agrega al pliego", ra.status === 201, `→ ${ra.status} ${ra.data?.message}`);
  const itemNuevo = ra.data?.item;
  check("SIN precio", Number(itemNuevo?.costoUnitario) === 0 && Number(itemNuevo?.costoParcial) === 0,
    `→ ${itemNuevo?.costoUnitario}`);
  check("marcado como adicional", itemNuevo?.origen === "adicional", `→ ${itemNuevo?.origen}`);
  check("con fecha de incorporacion", !!itemNuevo?.fecha_incorporacion);
  check("y numero automatico", /^A\d+$/.test(itemNuevo?.numeroItem || ""), `→ ${itemNuevo?.numeroItem}`);
  check("el aviso dice que va sin precio", /sin precio/i.test(ra.data?.message || ""), `→ ${ra.data?.message}`);

  console.log("\n=== Y se le puede cargar avance en el acto ===");
  await cargarAvance(6, "2026-05-10", [{ pliego_item_id: itemNuevo.id, cantidad_ejecutada: 15 }]);
  ra = await req("POST", `/obras/${obraId}/informes-avance/previsualizar`,
    { fecha_desde: "2026-05-01", fecha_hasta: "2026-05-31" }, token);
  const nvo = ra.data?.informe?.items?.find((x) => x.pliego_item_id === itemNuevo.id);
  check("aparece en el informe", !!nvo);
  check("con sus 15 m3", Math.abs(nvo?.cantidad_periodo - 15) < 0.001, `→ ${nvo?.cantidad_periodo}`);
  check("marcado como adicional", nvo?.origen === "adicional", `→ ${nvo?.origen}`);

  console.log("\n=== Sin precio NO ensucia el porcentaje de la obra ===");
  // Es lo que hace que se pueda registrar sin mentir: un item que vale 0 suma
  // 0 al contrato y 0 a lo ejecutado, asi que el avance de la obra no se mueve
  // por haber cargado trabajo no contratado.
  check("el precio de contrato no cambio",
    Math.abs(ra.data?.informe?.totales?.precio_contrato - 1100000) < 1,
    `→ ${ra.data?.informe?.totales?.precio_contrato}`);
  check("y el avance del periodo es 0% aunque se ejecutaron 15 m3",
    ra.data?.informe?.totales?.avance_periodo_porcentaje === 0,
    `→ ${ra.data?.informe?.totales?.avance_periodo_porcentaje}`);

  console.log("\n=== Lo que no deja al agregar ===");
  ra = await req("POST", `/avanceObra/${obraId}/items`, { unidad: "m3" }, token);
  check("sin descripcion", ra.status === 400, `→ ${ra.status}`);
  ra = await req("POST", `/avanceObra/${obraId}/items`, { descripcion: "Algo" }, token);
  check("sin unidad", ra.status === 400, `→ ${ra.status}`);
  check("y explica por que hace falta", /unidad/i.test(ra.data?.message || ""), `→ ${ra.data?.message}`);
  ra = await req("POST", `/avanceObra/${obraId}/items`,
    { descripcion: "Otra", unidad: "m2", numero_item: itemNuevo.numeroItem }, token);
  check("un numero repetido", ra.status === 400, `→ ${ra.status}`);
  ra = await req("POST", `/avanceObra/999999/items`, { descripcion: "X", unidad: "m2" }, token);
  check("una obra que no existe", ra.status === 404, `→ ${ra.status}`);
  ra = await req("POST", `/avanceObra/${obraId}/items`, { descripcion: "Y", unidad: "m2" });
  check("sin sesion", ra.status === 401 || ra.status === 403, `→ ${ra.status}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  if (obraId) {
    await sql(`DELETE FROM informes_avance WHERE obra_id = ${obraId}`);
    await sql(`DELETE ai FROM avance_obra_items ai JOIN avance_obras a ON a.id = ai.avance_obra_id WHERE a.obra_id = ${obraId}`);
    await sql(`DELETE FROM avance_obras WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
  }
  await sql(`DELETE FROM obras WHERE nombre LIKE '%${SUF}'`);
  await sql(`DELETE FROM usuarios WHERE email LIKE '%${SUF}%'`);
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}%'`);
  check("no quedo basura de prueba",
    Number((await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}'`))[0].n) === 0);
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
