import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Contrato con el subcontratista que ejecuta la obra (o parte de ella).
// Se le paga por avance de los ítems que tiene a cargo, semana a semana.
const Subcontrato = sequelize.define(
  "Subcontrato",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

    obra_id: { type: DataTypes.INTEGER, allowNull: false },

    subcontratista: { type: DataTypes.STRING, allowNull: false },
    cuit: { type: DataTypes.STRING, allowNull: true },

    fecha_contrato: { type: DataTypes.DATEONLY, allowNull: true },

    estado: {
      type: DataTypes.ENUM("vigente", "finalizado", "anulado"),
      allowNull: false,
      defaultValue: "vigente",
    },

    observaciones: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "subcontratos",
    freezeTableName: true,
    timestamps: true,
  }
);

export default Subcontrato;
