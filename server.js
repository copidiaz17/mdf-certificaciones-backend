// server.js (PRODUCCIÓN - RENDER READY)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// Importación de la conexión a la DB
import { sequelize } from "./database.js";

// ===============================================
// 1. IMPORTAR MODELOS (SOLO BACKEND)
// ===============================================
import "./models/Usuario.js";
import "./models/Obra.js";
import "./models/PliegoItem.js";
import "./models/Certificacion.js";
import "./models/CertificacionItem.js";
import "./models/Associations.js";
import "./models/planificacion.js";
import "./models/planificacionItem.js";
import "./models/AvanceObra.js";
import "./models/AvanceObraItem.js";

// Importar rutas
import authRoutes from "./routes/auth.js";
import obrasRoutes from "./routes/obras.js";
import pliegosRoutes from "./routes/pliegos.js";
import catalogoRoutes from "./routes/catalogo.js";
import certificacionesRoutes from "./routes/certificaciones.js";
import avanceobraRoutes from "./routes/avanceObra.js";
import usuariosRouter from "./routes/usuarios.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Render.com (y proxies en general) añaden X-Forwarded-For.
// Sin esto, express-rate-limit lanza ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);

// ===============================================
// 2. CORS (PRODUCCIÓN)
// ===============================================
// Render / browsers mandan preflight OPTIONS.
// NO uses app.options('*', ...) porque en algunas combinaciones rompe con path-to-regexp.
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const allowedOrigins = [
  FRONTEND_URL,
  "https://mdf-certificaciones-frontend.onrender.com",
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin: (origin, cb) => {
      // Permite requests sin Origin (health checks, Postman, etc.)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS bloqueado para origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===============================================
// 3. MIDDLEWARES
// ===============================================
app.use(express.json());

// ===============================================
// 4. RUTAS
// ===============================================
app.use("/api/auth", authRoutes);
app.use("/api/obras", obrasRoutes);
app.use("/api/obras", pliegosRoutes); // pliego-item CRUD bajo /api/obras
app.use("/api/pliegos", pliegosRoutes);
app.use("/api/catalogo", catalogoRoutes);
app.use("/api/certificaciones", certificacionesRoutes);
app.use("/api/avanceObra", avanceobraRoutes);
app.use("/api/usuarios", usuariosRouter);

// Health / ping
app.get("/", (req, res) => {
  res.send("Servidor de Certificación Backend funcionando.");
});

// ===============================================
// 5. MANEJADOR GLOBAL DE ERRORES
// ===============================================
app.use((err, req, res, next) => {
  console.error("⛔ ERROR EN EXPRESS ⛔", err);
  res.status(500).json({ message: "Error interno del servidor." });
});

// ===============================================
// 6. VALIDACIONES DE ENTORNO (AVISO)
// ===============================================
console.log("🔍 Variables de entorno cargadas:");
console.log("   NODE_ENV:", process.env.NODE_ENV || "(no definido)");
console.log("   PORT:", process.env.PORT || "(no definido)");
console.log("   DB_HOST:", process.env.DB_HOST || "(no definido)");
console.log("   DB_PORT:", process.env.DB_PORT || "(no definido)");
console.log("   DB_NAME:", process.env.DB_NAME || "(no definido)");
console.log("   DB_USER:", process.env.DB_USER || "(no definido)");
console.log("   DB_PASSWORD:", process.env.DB_PASSWORD ? "✅ definido" : "❌ NO definido");
console.log("   JWT_SECRET:", process.env.JWT_SECRET ? "✅ definido" : "❌ NO definido");
console.log("   FRONTEND_URL:", process.env.FRONTEND_URL || "(no definido)");

if (!process.env.JWT_SECRET) {
  console.error("⛔ JWT_SECRET no está definido. El servidor no puede arrancar de forma segura.");
  process.exit(1);
}
if (!process.env.FRONTEND_URL) {
  console.warn("⚠️ FRONTEND_URL no está definido. En producción debe estar en ENV.");
}

// ===============================================
// 7. CONECTAR DB + LEVANTAR SERVIDOR
// ===============================================
console.log("🔄 Intentando conectar a la base de datos...");

sequelize
  .authenticate()
  .then(() => {
    console.log("✅ Conexión a la base de datos OK");
    return sequelize.sync();
  })
  .then(() => {
    console.log("✅ Tablas sincronizadas");
    app.listen(PORT, () => {
      console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("⛔ Error de conexión DB:", err.message || err);
    // Dar tiempo a que los logs se escriban antes de salir
    setTimeout(() => process.exit(1), 1000);
  });
