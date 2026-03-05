// database.js
import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";
dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    dialect: "mysql",
    logging: false,
    dialectOptions: isProduction
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
