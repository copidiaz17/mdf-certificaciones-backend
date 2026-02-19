// backend/routes/catalogo.js
import express from 'express';
import ItemGeneral from '../models/ItemGeneral.js'; // 🟢 Modelo a traer
import { authMiddleware } from "./auth.js";
import { hasRole, ROLES } from "../middlewares/authorization.js";

const router = express.Router();

/* ================================================
   LISTAR ITEMS GENERALES (GET /) - PERMITIDO: Todos
   ================================================ */
router.get("/", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]), async (req, res) => {
    try {
        const items = await ItemGeneral.findAll({
            // Solo necesitamos id, nombre y unidadMedida para el select
            attributes: ['id', 'nombre', 'unidadMedida'], 
            order: [['nombre', 'ASC']]
        });
        res.json(items);
    } catch (error) {
        console.error("Error al listar catálogo:", error);
        res.status(500).json({ message: "Error al obtener items del catálogo." });
    }
});

/* ================================================
   CREAR NUEVO ITEM GENERAL (POST /) - RESTRINGIDO: Solo Admin, Operador
   ================================================ */
router.post("/", authMiddleware, hasRole([ROLES.ADMIN, ROLES.OPERATOR]), async (req, res) => {
    try {
        const { nombre, unidadMedida } = req.body;

        if (!nombre || !unidadMedida) {
            return res.status(400).json({ message: "El nombre y la unidad son obligatorios." });
        }

        const newItem = await ItemGeneral.create({ nombre, unidadMedida });
        res.status(201).json(newItem);
    } catch (error) {
        console.error("Error al crear item general:", error);
        if (error.name === 'SequelizeUniqueConstraintError') {
             return res.status(409).json({ message: "Este nombre de item ya existe en el catálogo." });
        }
        res.status(500).json({ message: "Error interno al guardar el item.", detail: error.message });
    }
});

export default router;