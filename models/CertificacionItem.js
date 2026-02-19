import { sequelize, DataTypes } from "../database.js";

const CertificacionItem = sequelize.define(
  "CertificacionItem",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    CertificacionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "certificacion_id",
    },

    PliegoItemId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "pliego_item_id",
    },

    avance_porcentaje: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "avance_porcentaje",
    },

    importe: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
    },
  },
  {
    tableName: "certificacion_items",
    freezeTableName: true,
    timestamps: false,
  }
);

export default CertificacionItem;
