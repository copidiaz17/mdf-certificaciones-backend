import { sequelize, DataTypes } from "../database.js";

const Usuario = sequelize.define(
  "Usuario",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rol: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "usuario",
    },
  },
  {
    tableName: "usuarios",       // ✅ exacto como en MySQL
    freezeTableName: true,       // ✅ NO pluraliza / NO cambia case
    timestamps: true,            // si tu tabla tiene createdAt/updatedAt
    // underscored: true,        // solo si tus columnas fueran created_at, etc.
  }
);

export default Usuario;
