import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

// Ítem de la orden de compra del subcontratista.
//
// Normalmente sale del pliego de la obra (pliego_item_id), pero con cantidad y
// precio PROPIOS del subcontrato: lo que se le paga al sub no es lo que la
// obra cobra. También puede ser un ítem que el pliego no tiene (pliego_item_id
// nulo), como "descarga de materiales".
//
// El precio de acá es el VIGENTE. Cada certificado guarda el precio con el que
// se certificó: si el precio cambia, lo ya certificado no se re-valúa. En la
// planilla de Excel pasaba lo contrario y el "anterior" dejaba de cerrar.
const SubcontratoItem = sequelize.define(
  "SubcontratoItem",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

    subcontrato_id: { type: DataTypes.INTEGER, allowNull: false },

    // Nulo cuando el ítem no está en el pliego de la obra.
    pliego_item_id: { type: DataTypes.INTEGER, allowNull: true },

    numero: { type: DataTypes.STRING, allowNull: true },
    descripcion: { type: DataTypes.STRING(600), allowNull: true },
    unidad: { type: DataTypes.STRING(30), allowNull: true },

    // Cantidad contratada, en la unidad del ítem.
    cantidad: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },

    precio_unitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },

    // contrato  estaba en la OC original
    // adicional se agregó después ("Adicional de excavación...")
    origen: {
      type: DataTypes.ENUM("contrato", "adicional"),
      allowNull: false,
      defaultValue: "contrato",
    },

    // Qué clase de adicional es. En la planilla de Excel todo figuraba como
    // "Adicional", pero eran dos cosas distintas:
    //   de_mas  más cantidad de un rubro que ya estaba en la OC
    //           ("Adicional de excavación cimientos a mano")
    //   nuevo   un rubro que no existía ("Descarga de materiales de Icaño")
    tipo_adicional: {
      type: DataTypes.ENUM("de_mas", "nuevo"),
      allowNull: true,
    },

    // Para un adicional "de más": qué rubro de la OC agranda.
    item_origen_id: { type: DataTypes.INTEGER, allowNull: true },

    // Si el ítem nació al certificar (un rubro nuevo cargado directo en el
    // certificado), cuál certificado lo creó. Su cantidad acordada es la que
    // se certificó: si ese certificado se corrige o se anula, el ítem acompaña.
    creado_en_certificado_id: { type: DataTypes.INTEGER, allowNull: true },

    orden: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // ⚠️ LEGADO: el modelo anterior guardaba acá un precio "por el ítem
    // terminado". Ya no se usa; queda en la tabla para no tener que borrarla.
    precio_acordado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "subcontrato_items",
    freezeTableName: true,
    timestamps: false,
  }
);

export default SubcontratoItem;
