import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Certificado del subcontratista: lo que hizo en un período, en cantidades.
//
// Solo se guarda la cantidad ACTUAL de cada ítem. El anterior, el acumulado,
// el pendiente y los importes se calculan: el anterior sale siempre de los
// certificados previos. En la planilla de Excel se copiaba a mano entre hojas
// y en varios certificados no coincidía con el acumulado del anterior.

export const SubcontratoCertificado = sequelize.define(
  "SubcontratoCertificado",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    subcontrato_id: { type: DataTypes.INTEGER, allowNull: false },
    numero: { type: DataTypes.INTEGER, allowNull: false },
    desde: { type: DataTypes.DATEONLY, allowNull: false },
    hasta: { type: DataTypes.DATEONLY, allowNull: false },
    fecha: { type: DataTypes.DATEONLY, allowNull: true },
    anulado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    observaciones: { type: DataTypes.TEXT, allowNull: true },
    creado_por_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  { tableName: "subcontrato_certificados", freezeTableName: true, timestamps: true }
);

export const SubcontratoCertificadoItem = sequelize.define(
  "SubcontratoCertificadoItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    certificado_id: { type: DataTypes.INTEGER, allowNull: false },
    subcontrato_item_id: { type: DataTypes.INTEGER, allowNull: false },
    cantidad: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
    // El precio con el que se certificó. Si después cambia el precio del
    // ítem, esto no se toca: lo ya certificado no se re-valúa.
    precio_unitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  },
  { tableName: "subcontrato_certificado_items", freezeTableName: true, timestamps: false }
);

// Descuentos acordados con el subcontratista en ese certificado: adelantos de
// dinero, herramientas compradas para su gente, etc. Se carga el importe ya
// convenido; no hay porcentajes automáticos.
export const SubcontratoDescuento = sequelize.define(
  "SubcontratoDescuento",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    certificado_id: { type: DataTypes.INTEGER, allowNull: false },
    tipo: {
      type: DataTypes.ENUM("adelanto", "herramientas", "otro"),
      allowNull: false,
      defaultValue: "otro",
    },
    concepto: { type: DataTypes.STRING, allowNull: true },
    importe: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  },
  { tableName: "subcontrato_descuentos", freezeTableName: true, timestamps: false }
);
