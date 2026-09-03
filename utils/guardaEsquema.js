// El freno que evita tocar el esquema de producción sin querer.
//
// ── Por qué existe ───────────────────────────────────────────────────────
//
// Este servidor sincroniza tablas y corre migraciones AL ARRANCAR. Eso es lo
// correcto en Render: se despliega y el esquema queda al día solo.
//
// El problema es la otra punta. El .env de la máquina de desarrollo apunta a
// la base de producción —porque es cómodo para mirar datos reales— y entonces
// un `npm start` distraído, o una prueba, aplica migraciones en producción.
//
// Ya pasó una vez. La migración era inofensiva (una columna nueva en NULL),
// pero pudo no serlo.
//
// ── Qué hace ─────────────────────────────────────────────────────────────
//
// Si la base NO es local y nadie lo autorizó explícitamente, el servidor
// arranca igual y atiende normalmente, pero NO toca el esquema. Se puede
// seguir mirando y cargando datos reales desde la máquina de desarrollo; lo
// único que no se puede es cambiar la estructura por accidente.
//
// En Render se pone MIGRAR_EN_ARRANQUE=true y todo sigue como antes.
//
// Se eligió "arranca pero no migra" en vez de "no arranca" a propósito: cortar
// el arranque rompería el despliegue si alguien olvida la variable, y un
// sistema caído es peor que un esquema sin actualizar.

const HOSTS_LOCALES = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];

export function esBaseLocal(host = process.env.DB_HOST) {
  const h = String(host || "").trim().toLowerCase();
  // Sin host, NO se asume local. Es cierto que sequelize usaria localhost,
  // pero el caso real en que esto pasa es otro: que se consulte el freno antes
  // de que dotenv haya cargado el .env. Ahi la base ES remota y el freno no lo
  // sabe. No saber contra que base se esta no puede significar que si.
  if (!h) return false;
  return HOSTS_LOCALES.includes(h);
}

export function autorizadoAMigrar() {
  return String(process.env.MIGRAR_EN_ARRANQUE || "").toLowerCase() === "true";
}

/**
 * ¿Se puede tocar el esquema en este arranque?
 *
 * @returns {Object} { permitido, motivo }
 */
export function puedeTocarEsquema() {
  if (esBaseLocal()) {
    return { permitido: true, motivo: "la base es local" };
  }
  if (autorizadoAMigrar()) {
    return { permitido: true, motivo: "MIGRAR_EN_ARRANQUE=true" };
  }
  return {
    permitido: false,
    motivo:
      `La base (${process.env.DB_HOST || "sin DB_HOST definido"}) no es local, o no se pudo ` +
      `saber cual es, y MIGRAR_EN_ARRANQUE no está en "true". ` +
      `El servidor va a atender normalmente pero NO va a tocar el esquema: sincronizar tablas ` +
      `o migrar contra una base remota desde una máquina de desarrollo es la forma más fácil ` +
      `de romper producción sin querer. Si esto ES el servidor de producción, poné ` +
      `MIGRAR_EN_ARRANQUE=true en sus variables de entorno.`,
  };
}

/** Lo grita al arrancar, para que nadie se entere tarde. */
export function avisarEnConsola() {
  const r = puedeTocarEsquema();
  if (r.permitido) {
    console.log(`🔓 Esquema: se puede actualizar (${r.motivo})`);
  } else {
    console.warn("\n🔒 ESQUEMA BLOQUEADO");
    console.warn("   " + r.motivo.replace(/\. /g, ".\n   ") + "\n");
  }
  return r;
}
