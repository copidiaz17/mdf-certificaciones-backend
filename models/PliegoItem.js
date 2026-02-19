// models/PliegoItem.js
import { sequelize, DataTypes } from "../database.js";

const PliegoItem = sequelize.define(
  "PliegoItem",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    obraId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    ItemGeneralId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    numeroItem: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    descripcionItem: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    unidadMedida: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    cantidad: {
      type: DataTypes.DECIMAL(15, 5),
      allowNull: false,
    },

    costoUnitario: {
      type: DataTypes.DECIMAL(15, 5),
      allowNull: false,
    },

    costoParcial: {
      type: DataTypes.DECIMAL(15, 5),
      allowNull: false,
    },
  },
  {
    tableName: "pliegoitems",   // 🔴 CLAVE
    freezeTableName: true,      // 🔴 CLAVE
    timestamps: false,
  }
);

export default PliegoItem;
