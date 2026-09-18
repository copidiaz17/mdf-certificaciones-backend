import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Contrato (orden de compra) con un subcontratista.
//
// Es un circuito APARTE del de la obra: tiene sus propios ítems, cantidades y
// precios, su propio plan de trabajo y sus propios certificados. No se mezcla
// con la planificación, el avance ni la certificación de la obra.
//
// Antes el pago al subcontratista se calculaba a partir del avance de obra de
// la empresa, con un solo precio "por el ítem terminado": no había cantidades,
// ni ítems propios, ni forma de certificarle a él lo que hizo.
const Subcontrato = sequelize.define(
  "Subcontrato",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

    obra_id: { type: DataTypes.INTEGER, allowNull: false },

    subcontratista: { type: DataTypes.STRING, allowNull: false },
    cuit: { type: DataTypes.STRING, allowNull: true },

    // Número de la orden de compra, como figura en la planilla ("OC N° 1").
    numero_oc: { type: DataTypes.STRING, allowNull: true },

    fecha_contrato: { type: DataTypes.DATEONLY, allowNull: true },

    // Desde cuándo trabaja: de acá salen los períodos del plan.
    fecha_inicio: { type: DataTypes.DATEONLY, allowNull: true },

    // Cada cuánto se le certifica. Sirve para proponer los períodos del plan
    // y el siguiente certificado; las fechas reales se pueden ajustar.
    periodicidad: {
      type: DataTypes.ENUM("quincenal", "semanal"),
      allowNull: false,
      defaultValue: "quincenal",
    },

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
