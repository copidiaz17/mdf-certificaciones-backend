// database.js
import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";
dotenv.config();

// ── Cuándo se usa SSL ────────────────────────────────────────────────────
//
// Aiven exige SSL; MySQL local no lo soporta y rechaza la conexión si se lo
// piden. Así que hay que decidirlo, y los dos sistemas lo decidían distinto:
// uno miraba NODE_ENV y el otro una variable DB_SSL.
//
// Ninguno de los dos alcanzaba solo:
//
//   Por NODE_ENV     no se puede levantar el servidor en modo producción
//                    contra una base local — justo lo que hacen las pruebas.
//   Por DB_SSL       si la variable no está cargada en el panel de Render,
//                    la conexión a Aiven se cae al desplegar.
//
// Entonces: manda DB_SSL cuando está declarada, y si no está, se asume por el
// entorno. Los despliegues que hoy no tienen DB_SSL siguen andando igual.
const ssl =
  process.env.DB_SSL !== undefined
    ? process.env.DB_SSL === "true"
    : process.env.NODE_ENV === "production";

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),   // ✅ Aiven usa puerto distinto
    dialect: "mysql",
    logging: false,
    dialectOptions: ssl
      ? {
          ssl: { require: true, rejectUnauthorized: false },
          connectTimeout: 30000,
        }
      : {
          connectTimeout: 30000,
        },
    pool: {
      max: 5,
      min: 1,
      acquire: 60000,
      idle: 30000,
      evict: 30000,
    },
  }
);

export { sequelize, DataTypes };
