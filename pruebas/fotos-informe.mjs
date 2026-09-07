// Fotos que respaldan un informe de avance.
//
// Sube imágenes DE VERDAD a Cloudinary y después las borra. Si faltan las
// credenciales, verifica lo otro que importa: que el sistema lo diga en vez
// de aceptar la subida y perder el archivo.
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
const HAY_CLOUDINARY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

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

// Un PNG de 1x1 real, para no depender de un archivo del disco.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const subirFotos = async (ruta, tk, fotos) => {
  const fd = new FormData();
  for (const f of fotos) {
    fd.append("fotos", new Blob([PNG], { type: "image/png" }), f.nombre);
    fd.append("epigrafes", f.epigrafe ?? "");
  }
  const r = await fetch(API + ruta, {
    method: "POST",
    headers: { ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: fd,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};

const SUF = "FT" + Date.now().toString().slice(-6);
let obraId = null, informeId = null;
const publicIds = [];

try {
  const base = sequelize.config.database;
  if (!/prueba|test/i.test(base)) {
    console.error(`⛔ La base "${base}" no parece de prueba. Cancelo.`);
    process.exit(1);
  }
  await sequelize.authenticate();
  console.log(`Base de prueba: ${base}`);
  console.log(HAY_CLOUDINARY ? "Cloudinary: configurado (se suben fotos reales)\n"
                             : "Cloudinary: SIN configurar (se verifica el aviso)\n");

  const hash = await bcrypt.hash("Prueba12345", 10);
  await sql(`INSERT INTO usuarios (nombre, email, password, rol, createdAt, updatedAt)
             VALUES ('Jefe ${SUF}', 'f${SUF}@t.com', '${hash}', 'administrador', NOW(), NOW())`);
  const usuarioId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  const token = jwt.sign({ id: usuarioId, email: `f${SUF}@t.com`, rol: "administrador" }, SECRET, { expiresIn: "1h" });

  await sql(`INSERT INTO obras (nombre, reparticion, createdAt, updatedAt)
             VALUES ('Obra ${SUF}', 'municipalidad_sgo', NOW(), NOW())`);
  obraId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;

  await sql(`INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
             VALUES ('Gen ${SUF}', 'm3', NOW(), NOW())`);
  const genId = (await sql("SELECT LAST_INSERT_ID() id"))[0].id;
  await sql(`INSERT INTO pliegoitems (obraId, ItemGeneralId, numeroItem, descripcionItem,
                                      unidadMedida, cantidad, costoUnitario, costoParcial)
             VALUES (${obraId}, ${genId}, '1', 'Excavacion', 'm3', 100, 5000, 500000)`);

  let r = await req("POST", `/obras/${obraId}/informes-avance`,
    { fecha_desde: "2026-03-01", fecha_hasta: "2026-03-31", titulo: `Informe ${SUF}` }, token);
  check("informe creado", r.status === 201, `→ ${r.status} ${r.data?.error}`);
  informeId = r.data?.id;

  const RUTA = `/obras/${obraId}/informes-avance/${informeId}/fotos`;

  if (!HAY_CLOUDINARY) {
    console.log("=== Sin Cloudinary, lo dice en vez de perder el archivo ===");
    r = await subirFotos(RUTA, token, [{ nombre: "a.png", epigrafe: "x" }]);
    check("responde 503", r.status === 503, `→ ${r.status}`);
    check("y explica que falta", /cloudinary/i.test(r.data?.message || ""), `→ ${r.data?.message}`);
  } else {
    console.log("=== Subir dos fotos con su epigrafe ===");
    r = await subirFotos(RUTA, token, [
      { nombre: "sector-b.png", epigrafe: "Sector B, losa terminada" },
      { nombre: "frente-sur.png", epigrafe: "Frente sur, encofrado" },
    ]);
    check("las sube", r.status === 201, `→ ${r.status} ${r.data?.message}`);
    check("devuelve las dos", r.data?.fotos?.length === 2, `→ ${r.data?.fotos?.length}`);
    for (const f of r.data?.fotos || []) if (f.public_id) publicIds.push(f.public_id);

    const f1 = r.data?.fotos?.[0];
    check("con URL de Cloudinary", /res\.cloudinary\.com/.test(f1?.url || ""), `→ ${f1?.url}`);
    check("y una miniatura mas chica", /w_400/.test(f1?.miniatura || ""), `→ ${f1?.miniatura}`);
    check("guarda el epigrafe", f1?.epigrafe === "Sector B, losa terminada", `→ ${f1?.epigrafe}`);
    check("y quien la subio", Number(f1?.subido_por_id) === Number(usuarioId));

    console.log("\n=== La imagen esta de verdad en Cloudinary ===");
    const resp = await fetch(f1.url);
    check("se puede descargar", resp.ok, `→ ${resp.status}`);
    check("y es una imagen", /^image\//.test(resp.headers.get("content-type") || ""),
      `→ ${resp.headers.get("content-type")}`);

    console.log("\n=== Viajan con el informe ===");
    r = await req("GET", `/obras/${obraId}/informes-avance/${informeId}`, null, token);
    check("el informe las trae", r.data?.fotos?.length === 2, `→ ${r.data?.fotos?.length}`);
    check("en orden", r.data?.fotos?.[0]?.orden === 0 && r.data?.fotos?.[1]?.orden === 1);
    check("con el nombre de quien las subio", !!r.data?.fotos?.[0]?.subidaPor?.nombre,
      `→ ${JSON.stringify(r.data?.fotos?.[0]?.subidaPor)}`);

    console.log("\n=== Avisa de las que quedaron sin epigrafe ===");
    r = await subirFotos(RUTA, token, [{ nombre: "sin-texto.png", epigrafe: "" }]);
    check("la sube igual", r.status === 201, `→ ${r.status}`);
    check("pero lo dice", /sin epígrafe/i.test(r.data?.message || ""), `→ ${r.data?.message}`);
    const sinT = r.data?.fotos?.[0];
    if (sinT?.public_id) publicIds.push(sinT.public_id);

    console.log("\n=== Se le puede poner el epigrafe despues ===");
    r = await req("PUT", `${RUTA}/${sinT.id}`, { epigrafe: "Vereda norte" }, token);
    check("lo cambia", r.status === 200 && r.data?.foto?.epigrafe === "Vereda norte", `→ ${r.data?.foto?.epigrafe}`);

    console.log("\n=== Borrar una foto ===");
    const urlBorrada = sinT.url;
    r = await req("DELETE", `${RUTA}/${sinT.id}`, null, token);
    check("la borra", r.status === 200, `→ ${r.status}`);
    r = await req("GET", `/obras/${obraId}/informes-avance/${informeId}`, null, token);
    check("y quedan dos", r.data?.fotos?.length === 2, `→ ${r.data?.fotos?.length}`);
    const idx = publicIds.indexOf(sinT.public_id);
    if (idx >= 0) publicIds.splice(idx, 1);
    // Cloudinary tarda un instante en propagar el borrado por la CDN, así que
    // no se verifica que la URL muera: se verifica que la fila se fue, que es
    // lo que el sistema controla.
    check("la fila ya no esta",
      Number((await sql(`SELECT COUNT(*) n FROM fotos_informe WHERE id = ${sinT.id}`))[0].n) === 0);
  }

  console.log("\n=== El listado dice cuantas fotos tiene cada informe ===");
  // Sin esto habria que abrir uno por uno para saber a cual le falta el
  // respaldo, que es justo lo que uno quiere ver de un vistazo.
  r = await req("GET", `/obras/${obraId}/informes-avance`, null, token);
  const enLista = (r.data || []).find((x) => x.id === informeId);
  check("lo informa", enLista !== undefined && enLista.fotos !== undefined,
    `→ ${JSON.stringify(enLista)}`);
  check("con el numero correcto", enLista?.fotos === (HAY_CLOUDINARY ? 2 : 0),
    `→ ${enLista?.fotos}`);

  console.log("\n=== Lo que no deja ===");
  r = await subirFotos(`/obras/${obraId}/informes-avance/${informeId}/fotos`, null, [{ nombre: "a.png" }]);
  check("sin sesion", r.status === 401 || r.status === 403, `→ ${r.status}`);
  r = await subirFotos(`/obras/${obraId}/informes-avance/999999/fotos`, token, [{ nombre: "a.png" }]);
  check("un informe que no existe", r.status === 404 || r.status === 503, `→ ${r.status}`);

  // Un archivo que no es imagen: el filtro de multer lo rechaza.
  const fd = new FormData();
  fd.append("fotos", new Blob([Buffer.from("no soy una imagen")], { type: "text/plain" }), "nota.txt");
  const rt = await fetch(API + `/obras/${obraId}/informes-avance/${informeId}/fotos`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  check("un archivo que no es imagen", rt.status >= 400, `→ ${rt.status}`);

} catch (e) {
  console.error("EXPLOTO:", e.message, e.stack?.split("\n")[1]); fail++;
} finally {
  console.log("\nLimpiando...");
  // Las fotos que quedaron en Cloudinary se borran con el informe.
  if (informeId) {
    const S = process.env.JWT_SECRET;
    const tk = jwt.sign({ id: 1, email: "limpieza@t.com", rol: "administrador" }, S, { expiresIn: "5m" });
    await req("DELETE", `/obras/${obraId}/informes-avance/${informeId}`, null, tk);
  }
  if (obraId) {
    await sql(`DELETE FROM fotos_informe WHERE informe_id IN (SELECT id FROM informes_avance WHERE obra_id = ${obraId})`);
    await sql(`DELETE FROM informes_avance WHERE obra_id = ${obraId}`);
    await sql(`DELETE FROM pliegoitems WHERE obraId = ${obraId}`);
  }
  await sql(`DELETE FROM obras WHERE nombre LIKE '%${SUF}'`);
  await sql(`DELETE FROM usuarios WHERE email LIKE '%${SUF}%'`);
  await sql(`DELETE FROM itemgenerals WHERE nombre LIKE '%${SUF}%'`);
  check("no quedo basura de prueba",
    Number((await sql(`SELECT COUNT(*) n FROM obras WHERE nombre LIKE '%${SUF}'`))[0].n) === 0);
  // Que borrar el informe se lleve las fotos de Cloudinary es parte de lo que
  // hay que verificar: si no, cada informe borrado deja archivos que nadie va
  // a poder relacionar con nada. Se comprueba de verdad, no se avisa "por las
  // dudas".
  if (HAY_CLOUDINARY && publicIds.length) {
    const { v2: cloudinary } = await import("cloudinary");
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    let vivas = 0;
    for (const id of publicIds) {
      try { await cloudinary.api.resource(id); vivas++; } catch { /* ya no está: bien */ }
    }
    check("borrar el informe se llevo las fotos de Cloudinary", vivas === 0,
      `→ quedaron ${vivas} de ${publicIds.length}`);
  }
  console.log(`\n${"=".repeat(52)}\n${ok} pasaron, ${fail} fallaron`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
}
