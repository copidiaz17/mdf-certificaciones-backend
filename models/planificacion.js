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
    // "ambos" lo ofrecía la pantalla desde el principio, pero la columna no lo
    // admitía y se guardaba vacío sin avisar.
    motivo: {
      type: DataTypes.ENUM("tiempo", "adicional_item", "ambos"),
      allowNull: true,
    },

    // ── Versión del plan de trabajos ─────────────────────────────────────
    // 0 es el plan original. Cada replanteo es una versión nueva (1, 2, ...)
    // formada por TODOS sus meses, que se crean, editan y borran juntos.
    //
    // Sin esto el sistema no podía saber qué filas forman un mismo replanteo:
    // replantear mes a mes volvía a ofrecer el mismo disponible en cada mes y
    // la curva pasaba del 100%.
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    // Hasta qué fecha manda el avance real. La versión rige desde el día
    // siguiente: lo anterior al corte ya está ejecutado y no se replanifica.
    fecha_corte: {
      type: DataTypes.DATEONLY,
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
