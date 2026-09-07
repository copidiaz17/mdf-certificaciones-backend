// models/FotoInforme.js
//
// Una foto que respalda un informe de avance.
//
// ── Por qué el epígrafe es lo más importante de la fila ──────────────────
//
// Una foto sin texto, dentro de seis meses, es un muro que nadie sabe cuál
// es. "Sector B, losa terminada" convierte esa misma foto en prueba. Por eso
// el epígrafe se pide al subir y no queda como un opcional escondido.
//
// ── Por qué no rompe que el informe esté congelado ───────────────────────
//
// Los NÚMEROS del informe están congelados: son los que se entregaron. Las
// fotos se pueden seguir agregando después —el jefe de obra las saca en obra
// y las sube cuando vuelve— y cada una guarda cuándo se subió y quién. Es
// evidencia adjunta, no una parte del cálculo.

import { sequelize, DataTypes } from "../database.js";

const FotoInforme = sequelize.define(
  "FotoInforme",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    informe_id: { type: DataTypes.INTEGER, allowNull: false },

    url: { type: DataTypes.STRING(500), allowNull: false },

    // Lo que hace falta para poder borrarla de Cloudinary. Sin esto, borrar
    // la fila deja el archivo colgado para siempre.
    public_id: { type: DataTypes.STRING(300), allowNull: true },

    // Qué se ve en la foto.
    epigrafe: { type: DataTypes.STRING(300), allowNull: true },

    nombre_archivo: { type: DataTypes.STRING(255), allowNull: true },

    // El orden en que se muestran, para poder armar una secuencia que se
    // entienda: el antes, el durante y el después de un mismo frente.
    orden: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    subido_por_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "fotos_informe",
    freezeTableName: true,
    timestamps: true,
  }
);

export default FotoInforme;
