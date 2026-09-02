// Aviso al sistema de costos cuando se emite un certificado.
//
// ── Por qué existe ───────────────────────────────────────────────────────
//
// El sistema de costos ya sabe armar la factura de un certificado: calcula el
// importe (subtotal menos la devolución del anticipo), arma el concepto con el
// período, y saca el CUIT y la razón social del receptor según la repartición
// de la obra. Lo único que le faltaba era ENTERARSE de que hay un certificado
// nuevo: hasta ahora había que ir a la pantalla de facturación y apretar
// "Importar".
//
// Con este aviso, el certificado que se emite acá aparece del otro lado listo
// para facturar, sin que nadie se acuerde de sincronizar.
//
// ── Cómo está hecho, y por qué así ───────────────────────────────────────
//
// El aviso NO manda los datos del certificado: manda "hay novedades en la obra
// N". Costos después los busca por la API pública. Dos razones:
//
//   1. Si el aviso trajera los importes, cualquiera con el token podría
//      inventar un certificado del otro lado. Así, costos solo lee de una
//      fuente que ya controla.
//   2. Un aviso que se pierde no rompe nada: el próximo aviso —o el botón de
//      importar de siempre— trae todo igual, porque costos sincroniza la obra
//      entera, no el certificado suelto.
//
// Y sobre todo: es a la intemperie y NUNCA tira. Si costos está caído, si el
// token está mal, si no hay red — el certificado se emite igual. Emitir un
// certificado es el trabajo de este sistema; avisarle a otro es una cortesía.
// Que la cortesía falle no puede hacer fallar el trabajo.

const TIMEOUT_MS = 8000;

export function estaConfigurado() {
  return Boolean(process.env.COSTOS_API_URL && process.env.COSTOS_API_TOKEN);
}

/**
 * Avisa que una obra tiene certificados nuevos. No espera respuesta útil y no
 * propaga errores: se llama después del commit y se olvida.
 *
 * @param {Object} datos
 * @param {number} datos.obraId        la obra de ESTE sistema
 * @param {string} datos.evento        "certificado_emitido" | "certificado_anulado"
 * @param {number} [datos.certificadoId]  solo informativo, para el log
 */
export async function avisarCertificado({ obraId, evento, certificadoId = null }) {
  if (!estaConfigurado()) return { avisado: false, motivo: "no configurado" };

  const url = String(process.env.COSTOS_API_URL).replace(/\/+$/, "") +
    "/api/facturacion/aviso-certificado";

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Token": process.env.COSTOS_API_TOKEN,
      },
      body: JSON.stringify({ origen_obra_id: obraId, evento, origen_certificado_id: certificadoId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!r.ok) {
      console.warn(`⚠️  El sistema de costos respondió ${r.status} al aviso de certificado.`);
      return { avisado: false, motivo: `respondió ${r.status}` };
    }
    let d = null;
    try { d = await r.json(); } catch { /* no importa qué devolvió */ }
    console.log(`📤 Aviso a costos: obra ${obraId} — ${evento}`);
    return { avisado: true, respuesta: d };
  } catch (e) {
    // A propósito un warn y no un error: no se rompió nada de este lado.
    console.warn(`⚠️  No se pudo avisar al sistema de costos: ${e.message}`);
    return { avisado: false, motivo: e.message };
  }
}

/**
 * La versión para usar dentro de una ruta: se dispara y no se espera.
 *
 * Va DESPUÉS del commit, nunca adentro de la transacción: si el aviso tardara
 * ocho segundos adentro, la transacción quedaría abierta ocho segundos
 * trabando la tabla por algo que ni siquiera es de este sistema.
 */
export function avisarSinEsperar(datos) {
  avisarCertificado(datos).catch(() => {});
}
