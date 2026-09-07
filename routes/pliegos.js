// backend/routes/pliegos.js
import express from 'express';
import PliegoItem from '../models/PliegoItem.js'; 
import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();


/* ================================================
   1. CREAR ITEM DE PLIEGO (POST /obras/:obraId/pliego-item)
   ================================================ */
router.post("/:obraId/pliego-item", 
    authMiddleware, 
    hasRole([ROLES.ADMIN, ROLES.OPERATOR]), 
    async (req, res) => {
        const { obraId } = req.params;
        const { ItemGeneralId, numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, origen, fecha_incorporacion } = req.body;

        try {
            // El ítem maestro es obligatorio: el modelo no lo admite nulo. Se
            // comprueba acá para devolver un mensaje que se entienda, en vez
            // de dejar que falle en el insert con un error de la librería.
            const finalItemGeneralId = parseInt(ItemGeneralId);

            if (isNaN(finalItemGeneralId) || finalItemGeneralId === 0) {
                 return res.status(400).json({ message: "El ID del ítem maestro no es válido." });
            }

            if (!cantidad || !costoUnitario) {
                return res.status(400).json({ message: "Datos de cantidad y costo unitario incompletos." });
            }

            if (!descripcionItem) {
                return res.status(400).json({ message: "La descripción del ítem es obligatoria." });
            }

            const origenValido = ["original", "adicional"].includes(origen) ? origen : "original";

            const newItem = await PliegoItem.create({
                obraId,
                ItemGeneralId: finalItemGeneralId,
                numeroItem,
                descripcionItem,
                unidadMedida,
                cantidad,
                costoUnitario,
                costoParcial,
                origen: origenValido,
                fecha_incorporacion: origenValido === "adicional" ? (fecha_incorporacion || null) : null,
            });
            res.status(201).json(newItem);
        } catch (error) {
            console.error("Error al crear ItemPliego:", error);
            res.status(500).json({ message: "Error al guardar el ítem de pliego." });
        }
    }
);

/* ================================================
   2. LISTAR ITEMS DE PLIEGO (GET /obras/:obraId/pliego)
   ================================================ */
router.get("/:obraId/pliego", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
    try {
        const obraId = req.params.obraId;
        const items = await PliegoItem.findAll({ 
            where: { obraId },
            order: [['numeroItem', 'ASC']]
        });
        res.json(items);
    } catch (error) {
        console.error("Error al listar items de pliego:", error);
        res.status(500).json({ message: "Error al obtener la plantilla de pliego." });
    }
});

/* ================================================
   2. ACTUALIZAR ITEM DE PLIEGO (PUT /:obraId/pliego-item/:itemId)
   ================================================ */
router.put("/:obraId/pliego-item/:itemId",
    authMiddleware,
    hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
    async (req, res) => {
        const { itemId } = req.params;
        const { numeroItem, descripcionItem, unidadMedida, cantidad, costoUnitario, costoParcial, ItemGeneralId, origen, fecha_incorporacion } = req.body;
        try {
            const item = await PliegoItem.findByPk(itemId);
            if (!item) return res.status(404).json({ message: "Ítem no encontrado." });
            const origenValido = ["original", "adicional"].includes(origen) ? origen : item.origen;
            await item.update({
                numeroItem,
                descripcionItem,
                unidadMedida,
                cantidad,
                costoUnitario,
                costoParcial,
                ItemGeneralId: ItemGeneralId ? parseInt(ItemGeneralId) : item.ItemGeneralId,
                origen: origenValido,
                fecha_incorporacion: fecha_incorporacion !== undefined ? fecha_incorporacion : item.fecha_incorporacion,
            });
            res.json(item);
        } catch (error) {
            console.error("Error al actualizar PliegoItem:", error);
            res.status(500).json({ message: "Error al actualizar el ítem de pliego." });
        }
    }
);

/* ================================================
   3. ELIMINAR ITEM DE PLIEGO (DELETE /:obraId/pliego-item/:itemId)
   ================================================ */
router.delete("/:obraId/pliego-item/:itemId",
    authMiddleware,
    hasRole([ROLES.ADMIN, ROLES.OPERATOR]),
    async (req, res) => {
        const { itemId } = req.params;
        try {
            const item = await PliegoItem.findByPk(itemId);
            if (!item) return res.status(404).json({ message: "Ítem no encontrado." });
            await item.destroy();
            res.status(204).send();
        } catch (error) {
            console.error("Error al eliminar PliegoItem:", error);
            res.status(500).json({ message: "Error al eliminar el ítem de pliego." });
        }
    }
);

export default router;