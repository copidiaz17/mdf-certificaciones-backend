# Sistema de Certificaciones — MDF y Falube

Documento de arranque. Si estás empezando una conversación nueva sobre este sistema,
leé esto primero y **no vuelvas a explorar el código entero**: acá está el mapa.

> Este archivo es el mismo en **los cuatro repos** (MDF y Falube, backend y frontend) y describe a
> las dos empresas por igual. Si lo editás, copialo a los otros tres, como todo el resto del código.

Última actualización: **21/09/2026**.

---

## 1. Qué es

Sistema de gestión de obra pública para dos empresas constructoras de Santiago del Estero
(**MDF Obras Civiles** y **Falube**). Cubre el circuito completo de una obra:

```
Pliego (contrato)
  └─ Plan de trabajos (versionado: original + replanteos)
       └─ Avance de obra real (sin tope → excedentes)
            └─ Certificación (lo que se factura, topado al 100%)
                 └─ Informes de avance con fotos
       └─ Subcontratistas (circuito aparte: OC + certificados propios)
  └─ API entre sistemas (la consume el sistema de costos)
```

Son **dos sistemas gemelos**: mismo código, dos empresas, dos bases, cuatro repos.

---

## 2. Dónde está todo

| Qué | Carpeta local | Repo GitHub (`copidiaz17/`) |
|---|---|---|
| Falube backend | `C:\certificaciones\certificacion-backend` | `certificaciones-falube-backend` |
| Falube frontend | `C:\certificaciones\certificacion-frontend` | `certificaciones-falube-frontend` |
| MDF backend | `C:\certificacion-mdf\mdf-backend` | `mdf-certificaciones-backend` |
| MDF frontend | `C:\certificacion-mdf\mdf-frontend` | `mdf-certificaciones-frontend` |

Rama en los cuatro: `master`. Producción: **Render** + **MySQL en Aiven**.
Backends: `certificaciones-falube-backend.onrender.com` y `mdf-certificaciones-backend.onrender.com`.

### ⚠️ Regla de oro: son gemelos

Todo cambio va a **los dos**: se edita uno, se copia al otro, se corren las pruebas en ambos.
Hoy los **backends son idénticos archivo por archivo** salvo: `.gitignore`, `package.json`
(MDF tiene `start` y devDependencies), `CrearUsuario.js` (solo Falube), `.env.example` (solo MDF).
En los **frontends** las únicas diferencias legítimas son la marca:
`DashboardView.vue`, `LoginView.vue`, `assets/css/Dashboard.css`, `assets/css/Loguin.css`,
y el logo (`logo-mdf.jpg`).

### ⚠️ Render NO despliega solo

Los servicios de certificaciones tienen el auto-deploy **apagado**. Después de pushear hay que
entrar a Render → **Manual Deploy → Deploy latest commit**, **backend primero** (por las migraciones).
Para verificar que salió el código nuevo: pegarle a una ruta nueva sin token →
**401 = código nuevo**, **404 = código viejo**.

---

## 3. Stack

- **Backend**: Node + Express (ESM), Sequelize, MySQL. Auth JWT (`Bearer`), roles por middleware.
- **Frontend**: Vue 3 (Options API), vue-router, Pinia, chart.js/auto, vue-toastification, Vite.
  El token vive en `localStorage`; un 401 lo borra y vuelve al login (`src/config/axios.Config.js`).
- **Fotos**: Cloudinary (el disco de Render se borra en cada despliegue).

### Migraciones

Una sola definición: **`migraciones.mjs`**, idempotente (`agregarColumna`, `ajustarColumna`).
Corre al arrancar, después de `sequelize.sync()` (que solo crea tablas nuevas).
Está protegida por `utils/guardaEsquema.js`: **solo migra si la base es local o si
`MIGRAR_EN_ARRANQUE=true`** (así está en Render). Contra Aiven desde la máquina de desarrollo el
servidor levanta y atiende, pero no toca el esquema. Si una migración falla de verdad, el arranque se corta.

---

## 4. Cómo correr y probar en local

```bash
# 1) base local, una sola vez
mysql -u root -e "CREATE DATABASE certificaciones_prueba CHARACTER SET utf8mb4"
# necesita al menos una fila en itemgenerals:
#   INSERT INTO itemgenerals (nombre, unidadMedida, createdAt, updatedAt)
#   VALUES ('Catalogo base de prueba','gl',NOW(),NOW());

# 2) servidor apuntado ahí (Falube 3080, MDF 3081) — SIEMPRE en segundo plano
NODE_ENV=development DB_HOST=localhost DB_PORT=3306 \
  DB_NAME=certificaciones_prueba DB_USER=root DB_PASSWORD= DB_SSL=false \
  API_TOKEN=prueba-token PORT=3080 node server.js

# 3) cada suite, con API_BASE apuntando al puerto de ESE servidor
NODE_ENV=development DB_HOST=localhost DB_PORT=3306 \
  DB_NAME=certificaciones_prueba DB_USER=root DB_PASSWORD= DB_SSL=false \
  API_TOKEN=prueba-token API_BASE=http://localhost:3080/api node pruebas/subcontratos.mjs
```

Detalles que hacen perder tiempo si no se saben:

- Las suites **se niegan a correr** si `DB_HOST` no es local o si `DB_NAME` no dice "prueba". Bien así.
- Cada suite trae su **puerto por defecto distinto** (3080, 3098…). Pasar siempre `API_BASE`.
  Un `fetch failed` casi siempre es eso, no un bug.
- En Falube hace falta `DB_SSL=false` (el `.env` apunta a Aiven, que usa SSL).
- El JWT lo firman las pruebas leyendo `JWT_SECRET` del `.env`.
- Arrancar el servidor como tarea de fondo aparte; con `&` en la misma línea se colgó una vez.
- **Nunca contra producción.**

### Suites (`pruebas/`) — 324 casos, verdes en los dos backends

| Suite | Qué cubre |
|---|---|
| `subcontratos.mjs` (83) | Circuito del subcontratista: OC, certificados, adicionales, confirmación |
| `replanteo.mjs` (64) | Plan por versiones: disponible, curva, edición, borrado, migración de replanteos viejos |
| `informe-avance.mjs` (51) | Informe de avance y trabajos fuera del pliego |
| `excedente-a-item.mjs` (43) | Convertir excedente en ítem sin precio + API entre sistemas |
| `anular-certificacion.mjs` (27) | Anular y que deje de contar |
| `excedentes.mjs` (26) | El avance puede superar el pliego, avisa, queda en cantidad |
| `avance-ruta-real.mjs` (21) | `POST /obras/:id/avances`, la que usa la app (distinta de `/avanceObra`) |
| `fotos-informe.mjs` (9) | Fotos del informe |

---

## 5. Modelo de datos

```
obras ──┬── pliegoitems ── (itemgenerals = catálogo)
        ├── planificaciones ── planificacion_items
        ├── avance_obras ── avance_obra_items
        ├── certificaciones ── certificacion_items
        ├── informes_avance ── fotos_informe
        └── subcontratos ──┬── subcontrato_items
                           └── subcontrato_certificados ──┬── subcontrato_certificado_items
                                                          └── subcontrato_descuentos
usuarios (roles)
```

Asociaciones en `models/Associations.js`. Ojo: los nombres de tabla están fijados con
`tableName` + `freezeTableName` (`pliegoitems`, `itemgenerals`, `usuarios`… sin guiones bajos).

### Campos que cargan significado

- `pliegoitems.origen`: `original` | `adicional` | `excedente`. `item_origen_id` dice de qué ítem
  salió un excedente. Un excedente nace **sin precio**.
- `obras.reparticion`: `municipalidad_sgo` | `direccion_arquitectura` → define la fórmula financiera.
- `obras.solo_costo_total`: obras contratadas por precio total, sin desglose (antes era una lista
  de números de obra escrita a mano en la pantalla).
- `planificaciones.version`: `0` = plan original; `1, 2…` = cada replanteo, con `fecha_corte`.
- `certificaciones.anulada`: no se borra, se marca; queda fuera del acumulado.
- `subcontrato_items.origen` + `tipo_adicional` (`de_mas` | `nuevo`) + `item_origen_id` +
  `creado_en_certificado_id`.

---

## 6. Las reglas de negocio (esto es lo que no hay que romper)

### Avance ≠ Certificación

- **Certificación**: lo que se factura. **Topada al 100%** de cada ítem del pliego.
- **Avance de obra**: lo que se ejecutó de verdad. **Sin tope**. El pliego decía 50 m³ y se
  excavaron 200: eso pasa y se registra.
- Lo ejecutado de más es un **excedente**: se guarda en **cantidad y sin precio**. Cuánto vale se
  negocia después; recién ahí se convierte en ítem del pliego.
  Regla compartida en `utils/excedentes.js` (hay dos rutas que crean avances y ya pasó que la
  misma regla escrita dos veces dijera cosas distintas).

### Fórmula financiera del certificado (`routes/certificaciones.js → calcularTotales`)

Se calcula **en el servidor**, que es la fuente de verdad; el frontend replica la misma fórmula
para mostrarla, y los totales que manda el navegador se ignoran.

- `municipalidad_sgo`: −40 % anticipo, −5 % fondo de reparo, −3 % tasa de inspección,
  y se re-suma la sustitución del fondo de reparo.
- `direccion_arquitectura`: +15 % gastos generales, +10 % beneficios, luego −21 % IVA y −2,5 % IIBB.
- Sin repartición: `total_neto = subtotal`.

El importe de cada ítem sale **del pliego** (`cantidad × costoUnitario × %`), no de lo que mande la pantalla.

### Plan de trabajos por versiones y replanteo (`utils/planVersiones.js`)

- El eje es **mensual**: los avances quincenales consolidan en un punto por mes.
- Un replanteo es una **versión completa** (todos sus meses juntos), no un mes suelto.
  Rige **desde el día siguiente a la fecha de corte**; antes del corte manda el avance real.
- Para replantear hace falta **avance cargado hasta el último mes cerrado** (bloquea);
  la certificación solo avisa.
- **Lo hecho, hecho está**: el remanente se redistribuye en los meses que quedan, incluidos meses nuevos.
- La curva del replanteo **arranca siguiendo la curva de avance real** y sigue por lo replanificado.
- En el gráfico: el replanteo vigente es la **banda más ancha, atrás de todo** (width 20,
  `rgba(251,146,60,0.42)`, `order: 12`); el plan original queda **atenuado** y punteado
  (`rgba(56,189,248,0.13)`, `order: 14`). En chart.js, **mayor `order` = se dibuja más atrás**.

### Subcontratistas (rehecho el 20/09/2026)

Circuito **aparte** de las curvas de la obra: una orden de compra con ítems (normalmente del
pliego, pero con **cantidad y precio propios** del sub) y certificados por período de fechas libres,
calcados de la planilla de Excel de Carlos Loza.

- **No tiene plan de trabajo.** El avance se registra directo contra la OC.
- **Los extras no se cargan antes.** Al certificar, si un rubro pasa lo contratado o aparece uno
  que no existía, el servidor responde **409 `requiere_confirmacion`** con el detalle de cada cosa
  y su clase; recién con `confirmar_extras: true` lo registra como adicional.
  - `de_mas` → más cantidad de un rubro que ya estaba (dice cuál agranda).
  - `nuevo` → un rubro que no existía (se crea con `creado_en_certificado_id`).
- Lo certificado por encima de lo contratado sale como **renglón propio**: el rubro original nunca
  pasa del 100 %.
- **El precio se congela** al certificar: cambiar el precio del ítem no revalúa lo ya certificado.
- Solo se corrige o anula el **último** certificado (cambiar uno del medio alteraría el "anterior"
  de los siguientes, que ya se pagaron). Al corregir/anular, los ítems nuevos que ese certificado
  creó lo acompañan.
- **Descuentos**: líneas libres (adelanto de dinero, herramientas, otro) con el importe convenido.
- Estadísticas: `original` / `de_mas` / `nuevo` / `contrato` (acordado a la fecha) / `pendiente` /
  `avance` / `certificado` / `descuentos` / `neto_pagado`.
- Los tres errores de la planilla de Excel que el sistema evita: el % que ponderaba un **rango fijo
  de filas** (informaba 14,31 % cuando el real era 23,86 %), el "anterior" copiado a mano que no
  cerraba, y el precio que **revaluaba lo ya certificado**.

### API entre sistemas (`routes/publica.js`)

La consume el sistema de costos, con token compartido `X-API-Token` (si falta `API_TOKEN`, la API
queda **cerrada**, no abierta). Cruzan: pliego, certificado, y avance **topado al 100 %**.
**El excedente NO cruza nunca**: no es un activo hasta que el comitente lo reconoce (RT 54 / NIIF 15).

---

## 7. Mapa de la API

Todo bajo `/api`. Auth: `Authorization: Bearer <jwt>`.
Roles normalizados en `middlewares/authorization.js`: `admin`/`administrador`,
`operator`/`usuario`, `viewer`/`lector`.

| Archivo | Rutas |
|---|---|
| `auth.js` | `POST /auth/login` (con rate-limit) |
| `obras.js` (1.573 líneas) | CRUD de obras, `/:obraId/pliego`, `/planificacion`, **`/curva-avance`**, `/avances`, `/avance-items`, `/items-disponible-planificacion`, `/certificaciones`, `/items-certificados`, `/items-disponible-replanteo`, `/planificaciones/:id`, `/avances/:id` |
| `pliegos.js` | `POST|PUT|DELETE /:obraId/pliego-item`, `GET /:obraId/pliego` |
| `certificaciones.js` | `GET|POST /obras/:obraId/certificaciones`, `/acumulado`, `/:id/detalle`, `PUT /:certId`, `POST /:certId/anular`, `/reactivar` |
| `avanceObra.js` | `POST /:obraId/items`, `/previsualizar`, `GET /:obraId/excedentes`, `POST /:obraId/excedentes/:id/convertir` |
| `replanteos.js` | `GET /:obraId/replanteos/contexto`, `POST /:obraId/replanteos`, `PUT|DELETE /:obraId/replanteos/:version` |
| `subcontratos.js` | `/:obraId/subcontratos*`, `/subcontratos-pliego`, `/:subId/certificados/{nuevo,:certId}`, `POST|PUT` certificados, `/anular` |
| `informesAvance.js` | `/:obraId/informes-avance*` + fotos |
| `publica.js` | `/publica/obras`, `/publica/obras/:id/avance`, `/publica/obras/:id/certificados` |
| `catalogo.js`, `usuarios.js` | catálogo de ítems generales, alta de usuarios |

---

## 8. Mapa del frontend (`src/views/`)

| Vista | Para qué |
|---|---|
| `ObraDetalleView` (897) | La pantalla madre: curvas, tabla mensual, accesos a todo |
| `AddAvanceObraView` (881) | Cargar avance real |
| `InformesAvanceView` (792) | Informes + fotos |
| `ReplanteoView` (683) | Replanteo como versión del plan |
| `CertificacionDetalleView` (658) / `AddCertificacionView` (657) / `EditCertificacionView` | Certificados |
| `AddPlanificacionView` (548) | Plan original (solo versión 0) |
| `CargarPliegoView` (502) | Pliego, importación |
| `SubcontratoCertificadoView` (442) | Planilla del certificado del sub |
| `SubcontratoFormView` / `SubcontratoDetalleView` / `SubcontratosObraView` | OC, estadísticas, lista |
| `ExcedentesObraView` (279) | Excedentes y su conversión a ítem |
| `PliegoCompletoView`, `CrearObraView`, `GestionarCatalogoView`, `CrearUsuarioView`, `DashboardView`, `LoginView` | Resto |

Compartido de subcontratos: `src/utils/subcontratos.js` (formatos, `CLASES`, `desglosar` espejo del
servidor) y `src/assets/css/subcontratos.css` (todo con prefijo `.sc-`).

---

## 9. Estado al 21/09/2026

- ✅ Replanteo por versiones: terminado y probado.
- ✅ Subcontratistas sin plan, con adicionales `de_mas`/`nuevo` y confirmación: terminado y probado.
- ⏳ **Los commits de replanteo y subcontratistas están sin pushear en los cuatro repos.**
  (`git log origin/master..HEAD` dice cuántos son en cada uno.)
- ⏳ **Nada de esto está en producción todavía.** Cuando se pushee hay que hacer el
  **Manual Deploy en Render, backend primero**. Ese deploy aplica las migraciones nuevas
  (`planificaciones.version`, `fecha_corte`, `motivo='ambos'`; `subcontratos.*`;
  `subcontrato_items.tipo_adicional`, `item_origen_id`, `creado_en_certificado_id`) y crea las
  tablas de subcontratos, que en producción **todavía no existen**.
- ⏳ Pendiente ofrecido: importar los **17 certificados de Loza** después del deploy.
- 🔴 **Rotar la contraseña de producción**: quedó en texto plano en scripts locales no versionados
  (`scripts/*_prod.js` en Falube, `scripts/cargar-planificacion-escuela22.mjs` en MDF).
  El `.gitignore` de Falube ya bloquea `scripts/*_prod.js` y `scripts/*.json`. **No imprimirla ni commitearla.**

### Acceso a producción

Autorizado **solo lectura**. Cualquier escritura o borrado necesita confirmación explícita de José.
Lo único que se borró hasta ahora: el replanteo 43 (Paul Groussac), con respaldo previo.

---

## 10. Deudas y riesgos detectados (análisis)

Ninguno es urgente; están ordenados por lo que más duele si crece el uso.

1. **`routes/obras.js` tiene 1.573 líneas** y concentra obras + pliego + plan + avances +
   certificaciones + curvas. La curva de avance es la función más delicada del sistema y vive ahí,
   mezclada. Candidata natural a partirse en `routes/curvas.js` / `utils/curvaObra.js`.
2. **La fórmula financiera está escrita dos veces** (servidor y `AddCertificacionView`). El servidor
   manda, así que un desvío no corrompe datos, pero sí muestra números distintos a los guardados.
   Lo mismo pasa ahora, a propósito y documentado, con `desglosar` en subcontratos.
3. **No hay índices creados por migración.** Todo depende de los que MySQL crea por PK/FK.
   Las consultas por `obraId` sobre `pliegoitems`, `avance_obra_items` y `certificacion_items` van
   a ser lo primero que se note.
4. **`GET /:obraId/subcontratos` hace N+1**: carga cada subcontrato completo para calcular sus
   totales. Con pocos subs por obra es irrelevante; con muchos, no.
5. **Sin paginación** en ningún listado (obras, certificados, avances, informes).
6. **Rate-limit solo en el login.** El resto de la API no tiene freno.
7. **El JWT vive en `localStorage`** (expuesto a XSS) y **no hay refresh**: al expirar, redirección
   al login perdiendo lo que se estaba cargando. En pantallas largas como el avance eso duele.
8. **No hay pruebas de la fórmula financiera** de certificación por repartición — justo la parte
   que mueve plata. Una suite chica ahí valdría mucho.
9. **Sin backup automatizado propio** más allá de lo que da Aiven.
10. **Quedan tablas huérfanas** de la versión anterior de subcontratos
    (`subcontrato_plan_periodos`, `subcontrato_plan_items`) en las bases locales de prueba.
    En producción no existen (esa versión nunca se desplegó), así que no hay nada que limpiar allá.
11. **`CrearUsuario.js` existe solo en Falube**: script suelto de alta de usuarios.

---

## 11. Cómo trabajar en la próxima ventana (para gastar menos)

- **Una conversación por tema.** No mezclar stock, certificaciones y otros proyectos.
- Arrancar con: *"Leé el `SISTEMA.md` del repo y trabajemos sobre \<tema\>"*
  (está en la raíz de los cuatro; por ejemplo `C:\certificaciones\certificacion-backend\SISTEMA.md`).
- Pedir que se lean **archivos puntuales**, no carpetas enteras. `routes/obras.js` y
  `ObraDetalleView.vue` son caros: pedir rangos de líneas.
- **No volcar tablas ni resultados largos** de la base al chat; pedir conteos y muestras de 3 filas.
- Recordá el orden de siempre: **cambiar uno → copiar al gemelo → correr las 324 pruebas en los dos
  → compilar los dos frontends → commitear los cuatro repos → pedir permiso para pushear**.
- Y después del push: **Manual Deploy en Render, backend primero**.
