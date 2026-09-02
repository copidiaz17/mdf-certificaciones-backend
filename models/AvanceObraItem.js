import { DataTypes } from "sequelize";
import { sequelize } from "../database.js";

const AvanceObraItem = sequelize.define(
  "AvanceObraItem",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    avance_obra_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    pliego_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    // Porcentaje de avance del ítem para ESTE avance.
    // PUEDE SUPERAR 100: el avance de obra registra lo que se ejecutó de
    // verdad, no lo que estaba presupuestado. La certificación sí está topada.
    avance_porcentaje: {
      type: DataTypes.DECIMAL(9, 2),
      allowNull: false,
      defaultValue: 0,
    },

    // La cantidad realmente ejecutada en este avance, en la unidad del ítem
    // (m3, m2, un...). Es la fuente de verdad cuando está cargada: el
    // porcentaje se deriva de acá.
    //
    // Por qué hace falta además del porcentaje: el excedente se discute en
    // obra en metros cúbicos, no en porcentaje. "150 m3 de excavación de más"
    // se entiende; "400% de avance" no le dice nada a nadie.
    cantidad_ejecutada: {
      type: DataTypes.DECIMAL(15, 5),
      allowNull: true,
    },

    // ⚠️ LEGADO (si todavía existen en la tabla)
    // Podés eliminarlas cuando migres 100% a porcentaje.
    cantidad: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    precio_unitario: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    importe: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
  },
  {
    tableName: "avance_obra_items",
    timestamps: false,
  }
);

export default AvanceObraItem;
