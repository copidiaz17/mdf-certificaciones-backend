// models/associations.js

import Usuario from "./Usuario.js";
import Obra from "./Obra.js";
import PliegoItem from "./PliegoItem.js";
import ItemGeneral from "./ItemGeneral.js";
import Certificacion from "./Certificacion.js";
import CertificacionItem from "./CertificacionItem.js";
// ⚠️ Si tu archivo del modelo se llama planificacion.js en minúscula:
import Planificacion from "./planificacion.js";
import PlanificacionItem from "./planificacionItem.js";
import AvanceObra from "./AvanceObra.js";
import AvanceObraItem from "./AvanceObraItem.js";

/* ======================================================
   🔹 OBRAS Y PLIEGO
====================================================== */

Obra.hasMany(PliegoItem, {
  foreignKey: "obraId",      // atributo del modelo PliegoItem
  as: "pliegoItems",
});

PliegoItem.belongsTo(Obra, {
  foreignKey: "obraId",
  as: "obra",
});

ItemGeneral.hasMany(PliegoItem, {
  foreignKey: "ItemGeneralId",
  as: "pliegoItems",
});

PliegoItem.belongsTo(ItemGeneral, {
  foreignKey: "ItemGeneralId",
  as: "itemGeneral",
});

/* ======================================================
   🔹 CERTIFICACIONES
====================================================== */

Obra.hasMany(Certificacion, {
  foreignKey: "obra_id",      // atributo JS del modelo Certificacion
  as: "certificaciones",
});

Certificacion.belongsTo(Obra, {
  foreignKey: "obra_id",
  as: "obra",
});

Certificacion.hasMany(CertificacionItem, {
  foreignKey: "CertificacionId",  // atributo del modelo CertificacionItem
  as: "items",
});

CertificacionItem.belongsTo(Certificacion, {
  foreignKey: "CertificacionId",
  as: "items",
});

PliegoItem.hasMany(CertificacionItem, {
  foreignKey: "PliegoItemId",
  as: "certificaciones",
});

CertificacionItem.belongsTo(PliegoItem, {
  foreignKey: "PliegoItemId",
  as: "pliegoItem",
});

/* ======================================================
   🔹 PLANIFICACIONES
====================================================== */

Obra.hasMany(Planificacion, {
  foreignKey: "obraId",     // atributo del modelo Planificacion
  as: "planificaciones",
});

Planificacion.belongsTo(Obra, {
  foreignKey: "obraId",
  as: "obra",
});

Planificacion.hasMany(PlanificacionItem, {
  foreignKey: "planificacion_id",   // atributo del modelo PlanificacionItem
  as: "items",                      // 🔴 ESTE ALIAS ES EL QUE USAMOS EN include
});

PlanificacionItem.belongsTo(Planificacion, {
  foreignKey: "planificacion_id",
  as: "planificacion",
});

PliegoItem.hasMany(PlanificacionItem, {
  foreignKey: "pliego_item_id",
  as: "planificaciones",
});

PlanificacionItem.belongsTo(PliegoItem, {
  foreignKey: "pliego_item_id",
  as: "pliegoItem",
});

/* ======================================================
   🔹 AVANCES DE OBRA
====================================================== */

// AvanceObra: modelo corregido con atributo obraId (field: "obra_id")
Obra.hasMany(AvanceObra, {
  foreignKey: "obra_id",
  as: "avances",
});

AvanceObra.belongsTo(Obra, {
  foreignKey: "obra_id",
  as: "obra",
});

// AvanceObraItem: atributos snake_case (avance_obra_id, pliego_item_id)
AvanceObra.hasMany(AvanceObraItem, {
  foreignKey: "avance_obra_id",
  as: "items",
});

AvanceObraItem.belongsTo(AvanceObra, {
  foreignKey: "avance_obra_id",
  as: "avance",
});

PliegoItem.hasMany(AvanceObraItem, {
  foreignKey: "pliego_item_id",
  as: "avances",
});

AvanceObraItem.belongsTo(PliegoItem, {
  foreignKey: "pliego_item_id",
  as: "pliegoItem",
});

console.log("✅ Asociaciones Sequelize definidas correctamente");
