// Fotos que respaldan un informe de avance.
//
// Un informe que dice "se hormigonó el sector B" no prueba nada; la foto del
// sector B hormigonado, con su fecha, sí. Es lo que se discute cuando el
// comitente pregunta qué se hizo, y lo que hace falta cuando la obra ya no
// está en ese estado y no se puede volver a mirar.
//
// ── Dónde se guardan ─────────────────────────────────────────────────────
//
// En Cloudinary, el mismo patrón que ya usa el sistema de costos: el archivo
// nunca toca el disco del servidor. En Render el disco se borra en cada
// despliegue, así que una foto guardada ahí desaparece sola.
//
// Se sube ANTES de abrir la transacción y, si la base falla, se borra el
// archivo remoto: el orden inverso dejaría fotos huérfanas en Cloudinary que
// nadie va a limpiar nunca.

import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// La carpeta lleva el nombre de la empresa para que las dos no se mezclen en
// la misma cuenta de Cloudinary.
const CARPETA = `certificaciones/${process.env.EMPRESA_CARPETA || "obras"}/informes`;

export function cloudinaryConfigurado() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

/** Sube una foto desde un buffer en memoria. */
export function subirFoto(buffer, originalname) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CARPETA,
        resource_type: "image",
        use_filename: true,
        unique_filename: true,
        // Las fotos de obra salen del teléfono a 12 megapíxeles y pesan 6 MB.
        // Guardarlas así hace que la pantalla tarde en abrir y no aporta:
        // 2000 px de lado alcanzan de sobra para ver un muro terminado.
        transformation: [{ width: 2000, height: 2000, crop: "limit", quality: "auto:good" }],
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url: result.secure_url,
          public_id: result.public_id,
          ancho: result.width,
          alto: result.height,
          bytes: result.bytes,
        });
      }
    );
    stream.end(buffer);
  });
}

/** Borra una foto. Si falla, se avisa pero no se rompe: el registro ya no está. */
export async function borrarFoto(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (e) {
    console.error("No se pudo borrar la foto de Cloudinary:", publicId, e.message);
  }
}

/**
 * La miniatura para la grilla.
 *
 * Cloudinary la genera al vuelo insertando la transformación en la URL, así
 * que no hay que guardar dos archivos ni recortar nada al subir.
 */
export function miniatura(url, ancho = 400) {
  if (!url || !url.includes("/upload/")) return url;
  return url.replace("/upload/", `/upload/w_${ancho},q_auto,f_auto/`);
}
