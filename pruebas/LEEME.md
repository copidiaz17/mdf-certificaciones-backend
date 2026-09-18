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

> Las suites necesitan **al menos un `itemgenerals` cargado**. En una base recién
> creada, la primera corrida explota con `Cannot read properties of undefined
> (reading 'id')`. Se resuelve así:
>
> ```sql
> INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
> VALUES ('Catalogo base de prueba','gl',NOW(),NOW());
> ```

| Suite | Qué verifica |
|---|---|
| `replanteo.mjs` | El replanteo como versión del plan: disponible, curva, edición, borrado, ítems adicionales y la migración de los replanteos viejos |
| `excedentes.mjs` | El avance puede superar el pliego, avisa, y el excedente queda en cantidad |
| `excedente-a-item.mjs` | Convertir el excedente en un ítem nuevo sin precio, y la API entre sistemas |
| `avance-ruta-real.mjs` | La ruta que USA la aplicación (`POST /obras/:id/avances`), que es distinta de `/avanceObra` |
| `anular-certificacion.mjs` | Anular una certificación y que deje de contar |
| `informe-avance.mjs` | El informe de avance y los trabajos que no estaban en el pliego |
| `fotos-informe.mjs` | Las fotos del informe |
