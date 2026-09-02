# Pruebas

**Nunca correrlas contra producción.** El `.env` de este proyecto apunta a
Aiven, que es la base en uso. Las pruebas crean y borran obras, ítems y
avances: contra producción dejarían basura y, peor, correrían migraciones.

Se corren contra una base local vacía:

```bash
# una sola vez: crear la base
mysql -u root -e "CREATE DATABASE certificaciones_prueba CHARACTER SET utf8mb4"

# levantar el servidor apuntado ahí (crea el esquema solo)
NODE_ENV=development DB_HOST=localhost DB_PORT=3306 \
  DB_NAME=certificaciones_prueba DB_USER=root DB_PASSWORD= \
  API_TOKEN=prueba-token PORT=3080 node server.js

# y en otra consola, cada suite
NODE_ENV=development DB_HOST=localhost DB_PORT=3306 \
  DB_NAME=certificaciones_prueba DB_USER=root DB_PASSWORD= \
  API_TOKEN=prueba-token node pruebas/excedentes.mjs
```

| Suite | Qué verifica |
|---|---|
| `excedentes.mjs` | El avance puede superar el pliego, avisa, y el excedente queda en cantidad |
| `excedente-a-item.mjs` | Convertir el excedente en un ítem nuevo sin precio, y la API entre sistemas |
| `avance-ruta-real.mjs` | La ruta que USA la aplicación (`POST /obras/:id/avances`), que es distinta de `/avanceObra` |
