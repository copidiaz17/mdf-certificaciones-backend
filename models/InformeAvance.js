// models/InformeAvance.js
//
// El informe de avance de obra que arma el jefe de obra cuando lo necesita:
// qué se ejecutó entre dos fechas, ítem por ítem, con el acumulado a esa fecha.
//
// ── Por qué guarda los números y no solo el rango ────────────────────────
//
// Un informe que recalcula al abrirse no es un informe: es una consulta. Si
// el mes que viene alguien carga un avance atrasado, o corrige uno viejo, el
// "informe del 15 de marzo" pasaría a decir otra cosa que la que se entregó.
//
// Por eso `datos` guarda la foto completa —los ítems con sus cantidades y
// porcentajes, los totales y qué avances entraron— tal como estaban al
// generarlo. El rango y la obra quedan en columnas propias para poder
// buscarlos; el resto va adentro del JSON porque no se consulta, se lee.
//
// Lo que SÍ cambia después es el pliego: si a un ítem le cambian la
// descripción, el informe viejo sigue mostrando la que tenía. Es lo correcto:
// se entregó ese papel, no otro.

import { sequelize, DataTypes } from "../database.js";

const InformeAvance = sequelize.define(
  "InformeAvance",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    obra_id: { type: DataTypes.INTEGER, allowNull: false },

    // El rango que cubre el informe. Es lo primero que se pregunta de un
    // informe viejo: "¿este de qué período era?".
    fecha_desde: { type: DataTypes.DATEONLY, allowNull: false },
    fecha_hasta: { type: DataTypes.DATEONLY, allowNull: false },

    // Cuándo se emitió, que no es lo mismo que el período que cubre: un
    // informe de marzo se puede emitir en abril.
    fecha_informe: { type: DataTypes.DATEONLY, allowNull: false },

    titulo: { type: DataTypes.STRING, allowNull: true },

    // Lo que el jefe de obra quiera dejar dicho: por qué se atrasó, qué
    // frentes se abrieron, qué está trabado esperando materiales. Es la parte
    // que ningún cálculo puede producir y la que se lee primero.
    observaciones: { type: DataTypes.TEXT, allowNull: true },

    // La foto congelada. LONGTEXT y no JSON: MySQL 5.7 y MariaDB viejo no
    // tienen el tipo JSON, y estos sistemas corren sobre las dos.
    datos: { type: DataTypes.TEXT("long"), allowNull: false },

    creado_por_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "informes_avance",
    freezeTableName: true,
    timestamps: true,
  }
);

export default InformeAvance;
