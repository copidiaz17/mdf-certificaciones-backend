// Corre las migraciones de esquema a mano:  node migrar.mjs
// (el servidor las corre solas al arrancar; esto sirve para bases que no son
//  a la que apunta el .env, o para verificar antes de deployar)
import { sequelize } from "./database.js";
import { migrar } from "./migraciones.mjs";

try {
  await sequelize.authenticate();
  console.log(`Base: ${sequelize.config.database} @ ${sequelize.config.host}\n`);
  await migrar();
  process.exit(0);
} catch (err) {
  console.error("❌ La migración falló:", err.message);
  process.exit(1);
}
