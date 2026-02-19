// models/ItemGeneral.js
import { DataTypes } from 'sequelize';
import { sequelize } from '../database.js'; 

const ItemGeneral = sequelize.define(
  'ItemGeneral',
  {
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    unidadMedida: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: 'itemgenerals',
    freezeTableName: true,
  }
);

export default ItemGeneral;
