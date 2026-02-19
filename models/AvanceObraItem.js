import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

const AvanceObraItem = sequelize.define(
  "AvanceObraItem",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    avance_obra_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    pliego_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    // ✅ NUEVO: porcentaje de avance del ítem para ESTE avance
    avance_porcentaje: {
      type: DataTypes.DECIMAL(7, 2),
      allowNull: false,
      defaultValue: 0,
    },

    // ⚠️ LEGADO (si todavía existen en la tabla)
    // Podés eliminarlas cuando migres 100% a porcentaje.
    cantidad: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    precio_unitario: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    importe: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
  },
  {
    tableName: "avance_obra_items",
    timestamps: false,
  }
);

export default AvanceObraItem;
