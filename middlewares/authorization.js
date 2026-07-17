// middlewares/authorization.js

// 🔹 Niveles canónicos que usan las rutas
const ROLES = {
  ADMIN: "admin",
  OPERATOR: "operator",
  VIEWER: "viewer",
};

// 🔹 Alias: los roles reales de la app (los que se crean desde el panel:
//    "administrador" / "usuario", más "lector") se mapean a los niveles canónicos.
//    - administrador → admin (todo)
//    - usuario       → operator (ve y opera; igual que canModify en el frontend)
//    - lector        → viewer (solo lectura)
const ROL_ALIAS = {
  admin: "admin",
  administrador: "admin",
  operator: "operator",
  operador: "operator",
  usuario: "operator",
  viewer: "viewer",
  lector: "viewer",
  visualizador: "viewer",
};

function normalizarRol(rol) {
  const r = String(rol || "").toLowerCase().trim();
  return ROL_ALIAS[r] || r;
}

/**
 * Middleware para restringir el acceso basado en el rol del usuario.
 * Normaliza tanto el rol del usuario como los roles permitidos, así funcionan
 * ambos vocabularios (admin/operator/viewer y administrador/usuario/lector).
 */
function hasRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.rol) {
      return res
        .status(403)
        .json({ error: "Permiso denegado. Rol no definido en el token." });
    }

    const userRole = normalizarRol(req.user.rol);

    const rolesToCheck = Array.isArray(allowedRoles)
      ? allowedRoles
      : allowedRoles
      ? [allowedRoles]
      : [];

    // Si no se pasó ninguna lista de roles, dejo pasar a cualquiera logueado
    if (!rolesToCheck.length) {
      return next();
    }

    const permitidos = rolesToCheck.map((role) => normalizarRol(role));

    if (permitidos.includes(userRole)) {
      return next();
    }

    return res.status(403).json({
      error: "Permiso denegado. Su rol no tiene autorización para esta acción.",
    });
  };
}

export { hasRole, ROLES, normalizarRol };
