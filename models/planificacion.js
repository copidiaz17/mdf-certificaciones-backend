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

    // ── Replanteo ────────────────────────────────────────────────────────
    // Un replanteo es una planificación nueva que reemplaza a la anterior a
    // partir de un punto de corte. No pisa la original: queda encadenada por
    // planificacion_padre_id, para poder comparar lo prometido con lo real.
    tipo: {
      type: DataTypes.ENUM("original", "replanteo"),
      allowNull: false,
      defaultValue: "original",
    },

    // Por qué se replantea: se atrasó la obra, o entraron ítems adicionales.
    motivo: {
      type: DataTypes.ENUM("tiempo", "adicional_item"),
      allowNull: true,
    },

    planificacion_padre_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    // Avance de obra en el que se hizo el corte.
    avance_corte_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "planificaciones",
    timestamps: true,
  }
);

export default Planificacion;
