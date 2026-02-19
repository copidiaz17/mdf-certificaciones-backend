import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

const AvanceObra = sequelize.define("AvanceObra", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },

  obra_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  numero_avance: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  fecha_avance: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },

  periodo_desde: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },

  periodo_hasta: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
}, {
  tableName: "avance_obras",
  timestamps: true,
});

export default AvanceObra;
