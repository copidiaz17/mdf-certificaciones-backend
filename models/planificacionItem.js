// models/PlanificacionItem.js
import { sequelize, DataTypes } from "../database.js";

const PlanificacionItem = sequelize.define(
  "PlanificacionItem",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    planificacion_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    pliego_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    porcentaje_planificado: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
    },
  },
  {
    tableName: "planificacion_items",
    timestamps: false,
  }
);

export default PlanificacionItem;
