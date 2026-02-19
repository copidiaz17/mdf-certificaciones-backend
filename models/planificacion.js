// models/Planificacion.js
import { sequelize, DataTypes } from "../database.js";

const Planificacion = sequelize.define(
  "Planificacion",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    obraId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "obra_id",
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    fecha_desde: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    fecha_hasta: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    estado: {
      type: DataTypes.ENUM("abierta", "cerrada"),
      allowNull: false,
      defaultValue: "abierta",
    },
  },
  {
    tableName: "planificaciones",
    timestamps: true,
  }
);

export default Planificacion;
