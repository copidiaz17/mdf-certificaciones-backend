import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Plan de trabajo del subcontratista, por período (quincena o semana).
//
// Es una grilla ítems × períodos en CANTIDADES (m2, m3...), que es como se
// habla en obra: "esta quincena 200 m2 de tabique". El porcentaje se deriva.

export const SubcontratoPlanPeriodo = sequelize.define(
  "SubcontratoPlanPeriodo",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    subcontrato_id: { type: DataTypes.INTEGER, allowNull: false },
    numero: { type: DataTypes.INTEGER, allowNull: false },
    desde: { type: DataTypes.DATEONLY, allowNull: false },
    hasta: { type: DataTypes.DATEONLY, allowNull: false },
  },
  { tableName: "subcontrato_plan_periodos", freezeTableName: true, timestamps: false }
);

export const SubcontratoPlanItem = sequelize.define(
  "SubcontratoPlanItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    plan_periodo_id: { type: DataTypes.INTEGER, allowNull: false },
    subcontrato_item_id: { type: DataTypes.INTEGER, allowNull: false },
    cantidad: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
  },
  { tableName: "subcontrato_plan_items", freezeTableName: true, timestamps: false }
);
