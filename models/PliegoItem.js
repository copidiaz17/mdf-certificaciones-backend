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

    // De dónde salió este ítem.
    //   original   venía en el pliego licitado
    //   adicional  se incorporó en un replanteo por adicionales
    //   excedente  nació de haber ejecutado más de lo presupuestado en otro
    //              ítem. Se crea SIN precio: cuánto vale se negocia después.
    origen: {
      type: DataTypes.ENUM("original", "adicional", "excedente"),
      allowNull: false,
      defaultValue: "original",
    },

    // Solo para origen = "excedente": de qué ítem del pliego salió.
    // Es lo que lo hace rastreable. Sin esto, un "1.1 EXC" con precio 0 es un
    // misterio dentro de seis meses.
    item_origen_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    fecha_incorporacion: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  },
  {
    tableName: "pliegoitems",   // 🔴 CLAVE
    freezeTableName: true,      // 🔴 CLAVE
    timestamps: false,
  }
);

export default PliegoItem;
