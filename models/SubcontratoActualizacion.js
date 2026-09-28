import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Actualización de precios del contrato del subcontratista.
//
// Los precios de la OC cambian con el tiempo (un acuerdo por inflación, una
// redeterminación). Cambiarlos editando la OC no dejaba rastro de cuándo ni
// desde cuándo rigen. Una actualización dice "desde tal fecha, estos ítems
// valen tanto": cada certificado toma los precios de la última actualización
// vigente al FIN de su período (lo definió José: un certificado del 25/5 al
// 7/6 con una actualización desde el 1/6 va entero con el precio nuevo).
//
// Solo puede regir DESPUÉS del último certificado emitido: lo ya certificado
// no se revalúa ni se ajusta después. Si una actualización llega tarde, se
// arregla a mano (también lo definió José).
//
// El precio de la OC (subcontrato_items.precio_unitario) queda como el precio
// ORIGINAL del contrato.
export const SubcontratoActualizacion = sequelize.define(
  "SubcontratoActualizacion",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    subcontrato_id: { type: DataTypes.INTEGER, allowNull: false },
    numero: { type: DataTypes.INTEGER, allowNull: false },
    // Desde qué día rigen los precios nuevos.
    fecha_vigencia: { type: DataTypes.DATEONLY, allowNull: false },
    motivo: { type: DataTypes.STRING(300), allowNull: true },
    creado_por_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  { tableName: "subcontrato_actualizaciones", freezeTableName: true, timestamps: true }
);

// El precio nuevo de cada ítem que cambia. Un ítem que no figura conserva el
// precio que tenía.
export const SubcontratoActualizacionItem = sequelize.define(
  "SubcontratoActualizacionItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    actualizacion_id: { type: DataTypes.INTEGER, allowNull: false },
    subcontrato_item_id: { type: DataTypes.INTEGER, allowNull: false },
    precio_unitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  },
  { tableName: "subcontrato_actualizacion_items", freezeTableName: true, timestamps: false }
);
