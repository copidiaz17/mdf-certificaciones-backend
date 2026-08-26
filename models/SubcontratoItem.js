import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Ítem del pliego que toma a cargo el subcontratista, con el precio negociado.
//
// `precio_acordado` es lo que se le paga por el ítem TERMINADO (al 100%).
// El pago de cada semana sale de ahí: precio_acordado × (% avanzado esa semana).
//
// Ese precio es el negociado con el subcontratista y no tiene por qué coincidir
// con el del pliego. La diferencia entre ambos NO es la utilidad: para saberla
// habría que imputarle a cada ítem los materiales que se consumieron, y eso el
// sistema hoy no lo tiene. Por eso no se calcula ni se muestra.
const SubcontratoItem = sequelize.define(
  "SubcontratoItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

    subcontrato_id: { type: DataTypes.INTEGER, allowNull: false },
    pliego_item_id: { type: DataTypes.INTEGER, allowNull: false },

    precio_acordado: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "subcontrato_items",
    freezeTableName: true,
    timestamps: false,
    indexes: [
      // Un ítem no puede estar dos veces en el mismo subcontrato.
      { unique: true, fields: ["subcontrato_id", "pliego_item_id"] },
    ],
  }
);

export default SubcontratoItem;
