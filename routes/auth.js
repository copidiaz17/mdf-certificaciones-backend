// backend/routes/auth.js
import express from "express";
import rateLimit from "express-rate-limit";
import Usuario from "../models/Usuario.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = express.Router();

const SECRET = process.env.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // máximo 10 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos de login. Intentá en 15 minutos." },
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Email y password son requeridos" });
    }

    const user = await Usuario.findOne({ where: { email }, raw: true });
    if (!user) return res.status(400).json({ message: "Usuario no encontrado" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Contraseña incorrecta" });

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        rol: user.rol,
      },
      SECRET,
      { expiresIn: "1h" }
    );

    return res.json({ token });
  } catch (error) {
    console.error("Error en /login:", error);
    return res.status(500).json({ message: "Error en el servidor" });
  }
});

// Middleware auth
export const authMiddleware = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No autorizado" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Token inválido" });
    req.user = decoded;
    next();
  });
};

export default router;
