// Migraciones de esquema — ÚNICA definición.
//
// Antes esto estaba duplicado en dos lugares (`server.js` y `migrate_replanteo.mjs`)
// y con tipos distintos: `motivo` era ENUM en uno y VARCHAR(50) en el otro, así que
// la columna quedaba de un tipo o de otro según qué se ejecutara primero.
//
// Además el arranque se tragaba los errores con `.catch(() => {})` y un
// "Error en migración (no crítico)", de modo que el servidor levantaba igual con
// el esquema desactualizado. Así se llegó a tener una base con datos que la
// aplicación no podía leer. Ahora un fallo real corta el arranque.
//
// Todo lo de acá es idempotente: se puede correr las veces que haga falta.

import { sequelize } from "./database.js";

async function columnaExiste(tabla, columna) {
  const [filas] = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabla AND COLUMN_NAME = :columna`,
    { replacements: { tabla, columna } }
  );
  return filas.length > 0;
}

async function tablaExiste(tabla) {
  const [filas] = await sequelize.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabla`,
    { replacements: { tabla } }
  );
  return filas.length > 0;
}

// Agrega la columna solo si falta. Si falla de verdad, el error sube.
async function agregarColumna(tabla, columna, definicion, log) {
  if (!(await tablaExiste(tabla))) {
    log(`   ↷ ${tabla} no existe todavía (la crea sync) — se omite ${columna}`);
    return;
  }
  if (await columnaExiste(tabla, columna)) return;
  await sequelize.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
  log(`   ✅ ${tabla}.${columna} agregada`);
}

// Ajusta el tipo de una columna que ya existe (para arreglar definiciones viejas).
async function ajustarColumna(tabla, columna, definicion, log) {
  if (!(await tablaExiste(tabla))) return;
  if (!(await columnaExiste(tabla, columna))) return;
  await sequelize.query(`ALTER TABLE \`${tabla}\` MODIFY COLUMN \`${columna}\` ${definicion}`);
}

export async function migrar({ silencioso = false } = {}) {
  const log = silencioso ? () => {} : (m) => console.log(m);
  log("🔧 Migraciones de esquema");

  // ── avance_obras ─────────────────────────────────────────────────────────
  await ajustarColumna("avance_obras", "periodo_desde", "DATE NULL DEFAULT NULL", log);
  await ajustarColumna("avance_obras", "periodo_hasta", "DATE NULL DEFAULT NULL", log);
  await ajustarColumna("avance_obras", "createdAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP", log);
  await ajustarColumna("avance_obras", "updatedAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", log);

  // ── avance_obra_items ────────────────────────────────────────────────────
  await agregarColumna("avance_obra_items", "avance_porcentaje", "DECIMAL(7,2) NOT NULL DEFAULT 0", log);
  // Columnas heredadas: se dejan nulas para poder omitirlas al insertar.
  await ajustarColumna("avance_obra_items", "cantidad", "DECIMAL(12,2) NULL DEFAULT NULL", log);
  await ajustarColumna("avance_obra_items", "precio_unitario", "DECIMAL(12,2) NULL DEFAULT NULL", log);
  await ajustarColumna("avance_obra_items", "importe", "DECIMAL(14,2) NULL DEFAULT NULL", log);

  // ── Excedentes de obra ────────────────────────────────────────
  // El avance de obra puede superar lo del pliego y la certificación no.
  // Ejemplo real: 50 m3 de excavación presupuestados y 200 ejecutados. Eso
  // existe, hay que registrarlo, y después se negocia en un replanteo.
  //
  // Hasta ahora el avance se guardaba SOLO en porcentaje y además se truncaba
  // a 100 en silencio, así que ese dato se perdía. Con la cantidad ejecutada
  // el excedente se puede expresar donde tiene sentido: en m3, no en "400%".
  //
  // `avance_porcentaje` pasa a DECIMAL(9,2) para que entre un acumulado alto
  // sin desbordar (7,2 topaba en 99.999,99).
  await agregarColumna("avance_obra_items", "cantidad_ejecutada", "DECIMAL(15,5) NULL DEFAULT NULL", log);
  await ajustarColumna("avance_obra_items", "avance_porcentaje", "DECIMAL(9,2) NOT NULL DEFAULT 0", log);

  // ── certificaciones: auditoría y anulación ───────────────────────────────
  // Estaba suelto en el arranque de server.js; se centraliza acá.
  await agregarColumna("certificaciones", "creado_por_id", "INT NULL DEFAULT NULL", log);
  await agregarColumna("certificaciones", "editado_por_id", "INT NULL DEFAULT NULL", log);
  await agregarColumna("certificaciones", "anulada", "TINYINT(1) NOT NULL DEFAULT 0", log);
  await agregarColumna("certificaciones", "anulada_por_id", "INT NULL DEFAULT NULL", log);

  // ── obras: contratadas por un precio total ───────────────────────────────
  // Reemplaza a una lista de números de obra escrita a mano en la pantalla.
  // El número de obra es distinto en cada empresa, así que esa lista no se
  // podía ni copiar de un sistema al otro.
  await agregarColumna("obras", "solo_costo_total", "TINYINT(1) NOT NULL DEFAULT 0", log);

  // La única obra que estaba en esa lista, marcada por NOMBRE y no por id:
  // así esto corre en los dos sistemas y en el que no la tiene no hace nada.
  // Y solo si todavía no hay ninguna marcada, para no pisar lo que alguien
  // haya decidido después desde la pantalla.
  if (await tablaExiste("obras")) {
    const [yaMarcadas] = await sequelize.query(
      "SELECT COUNT(*) n FROM obras WHERE solo_costo_total = 1"
    );
    if (Number(yaMarcadas[0].n) === 0) {
      const [, meta] = await sequelize.query(
        `UPDATE obras SET solo_costo_total = 1
          WHERE REPLACE(LOWER(nombre), ' ', '') LIKE '%arcoiris%'`
      );
      const filas = meta?.affectedRows ?? 0;
      if (filas) log(`   ✅ ${filas} obra(s) marcadas como "solo costo total"`);
    }
  }

  // ── pliegoitems: ítems adicionales ───────────────────────────────────────
  await agregarColumna("pliegoitems", "origen", "ENUM('original','adicional') NOT NULL DEFAULT 'original'", log);
  // ── Ítems nacidos de un excedente ──────────────────────────────────
  // Cuando se ejecuta más de lo que decía el pliego, eso NO se resuelve
  // agrandándole la cantidad al ítem original: se crea un ítem nuevo, porque el
  // precio de lo ejecutado de más todavía no se sabe y se negocia aparte.
  //
  // `item_origen_id` es lo que lo hace rastreable: dice de qué ítem salió. Sin
  // eso, un ítem "1.1 EXC" con precio 0 es un misterio dentro de seis meses.
  await ajustarColumna("pliegoitems", "origen", "ENUM('original','adicional','excedente') NOT NULL DEFAULT 'original'", log);
  await agregarColumna("pliegoitems", "item_origen_id", "INT NULL DEFAULT NULL", log);
  await agregarColumna("pliegoitems", "fecha_incorporacion", "DATE NULL DEFAULT NULL", log);

  // ── planificaciones: replanteo ───────────────────────────────────────────
  // Las planificaciones que ya existían quedan como 'original' por el default,
  // que es exactamente lo que corresponde.
  await agregarColumna("planificaciones", "tipo", "ENUM('original','replanteo') NOT NULL DEFAULT 'original'", log);
  await agregarColumna("planificaciones", "motivo", "ENUM('tiempo','adicional_item') NULL DEFAULT NULL", log);
  await agregarColumna("planificaciones", "planificacion_padre_id", "INT NULL DEFAULT NULL", log);
  await agregarColumna("planificaciones", "avance_corte_id", "INT NULL DEFAULT NULL", log);

  // Si una base vieja quedó con `motivo` como VARCHAR (lo definía así el arranque),
  // se lo lleva al ENUM para que las dos bases digan lo mismo.
  const [tipoMotivo] = await sequelize.query(
    `SELECT COLUMN_TYPE t FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'planificaciones' AND COLUMN_NAME = 'motivo'`
  );
  if (tipoMotivo.length && !String(tipoMotivo[0].t).startsWith("enum")) {
    await sequelize.query(
      `ALTER TABLE planificaciones MODIFY COLUMN motivo ENUM('tiempo','adicional_item') NULL DEFAULT NULL`
    );
    log("   ✅ planificaciones.motivo unificada a ENUM");
  }

  log("✅ Esquema al día");
}

export default migrar;
