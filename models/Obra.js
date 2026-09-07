// models/Obra.js
import { sequelize, DataTypes } from "../database.js";

const Obra = sequelize.define(
  "Obra",
  {
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    ubicacion: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    // 👇 NUEVO CAMPO
    reparticion: {
      type: DataTypes.ENUM("municipalidad_sgo", "direccion_arquitectura"),
      allowNull: true,
    },

    // Hay obras contratadas por un precio total, sin el desglose de gastos
    // generales, beneficios, IVA e ingresos brutos. En esas, mostrar el
    // desglose es inventar una apertura que el contrato no tiene.
    //
    // Antes esto era una lista de números de obra escrita a mano en el código
    // de la pantalla —`const OBRAS_SOLO_TOTAL = [2]`— con su propio TODO
    // pidiendo justamente esto. El 2 es una obra distinta en cada empresa, así
    // que esa lista no se podía ni copiar de un sistema al otro.
    solo_costo_total: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "obras",
    timestamps: true, // dejalo así si ya usás createdAt / updatedAt
  }
);

export default Obra;
