# 🤖 BotArca (ERP & Automatización Headless ARCA)

**BotArca** es un sistema integral de **ERP Contable y Automatización Headless** para **ARCA (ex-AFIP)**, preparado para desplegarse en **Render** con soporte de persistencia en **Supabase (PostgreSQL Cloud)** y sincronización financiera en vivo con **[ArgentinaDatos](https://argentinadatos.com/)**.

Diseñado para operar **100% por backend**, sin screen scraping visual ni dependencias de interfaz frágiles, implementando **evasión avanzada contra cortafuegos (WAFs / Cloudflare / Anti-Bot)** de ARCA con tipeo humano estocástico e ingreso directo con **Clave Fiscal**.

---

## 🌟 Características Principales

### 1. 🛡️ Capaz de Vencer Cortafuegos de ARCA (Anti-Bot & WAF Bypass)
- **Playwright Headless Stealth**: Evasión profunda de `navigator.webdriver`, emulación de plugins reales, spoofing de WebGL Renderer/Vendor (`Intel UHD Graphics`), hardware concurrency y audio/canvas noise.
- **Tipeo y Clicks Humanos**: Tipeo estocástico con jitter variable (demora entre 35ms y 95ms por carácter) y movimientos curvos de cursor para no disparar los filtros biométricos de los WAFs de ARCA.
- **Sin Certificado Digital**: Ingreso ágil mediante CUIT y Clave Fiscal encriptada con **AES-256-GCM**.

### 2. 📈 Conexión en Vivo con ArgentinaDatos (api.argentinadatos.com)
- **Cotizaciones de Dólar en Vivo**: Dólar Oficial (Compra/Venta para facturación), Dólar Blue, MEP / Bolsa, CCL, Cripto y Tarjeta con auto-refresh en segundo plano.
- **Indicadores Económicos**: Inflación mensual e interanual (IPC) y evolución de la unidad UVA.
- **Calculadora Multimoneda**: Conversión automática de productos cotizados en USD a pesos argentinos (ARS) al facturar.

### 3. ☁️ Almacenamiento Persistente en Supabase (PostgreSQL)
- Sincronización en la nube de **Clientes (CRM)**, **Catálogo de Productos**, **Comprobantes Emitidos** y **Cobranzas**.
- Modo híbrido con **fallback automático local (SQLite / JSON atómico)**: Si Supabase no está configurado, el sistema funciona de inmediato en local sin interrupciones.
- Script SQL listo para ejecutar en el SQL Editor de Supabase en [`supabase/schema.sql`](file:///C:/Users/LENOVO/.gemini/antigravity/scratch/BotArca/supabase/schema.sql).

### 4. 💼 Matices de ERP Completo
- 👥 **CRM de Clientes**: Directorio con CUIT, Razón Social, Condición IVA, emails, domicilios y saldos de cuentas corrientes.
- 📦 **Catálogo de Productos y Servicios**: Precios en ARS y USD con ajuste automático de tipo de cambio según ArgentinaDatos.
- 🧾 **Facturador Inteligente**: Selección en 1 click de cliente del CRM y productos del catálogo, cálculo de impuestos y autorización directa en ARCA con obtención de CAE y Vencimiento.
- 📂 **Mis Comprobantes**: Consulta y filtrado de comprobantes emitidos y recibidos.
- 🏛️ **Monotributo & DFE**: Control de deuda CCMA, categoría, límite de facturación anual y lector de Domicilio Fiscal Electrónico.

### 5. ⏰ Keep-Alive Anti-Sleep (Render 24/7)
- Rutina de auto-ping periódico para mantener la instancia de Render despierta.
- Compatible con **UptimeRobot**, **Cron-Job.org** y **BetterStack** mediante los endpoints `/api/ping` y `/healthz`.
- **Terminal de Logs en Vivo** en el panel web mediante Server-Sent Events (SSE).

---

## 🛠️ Stack Tecnológico

- **Backend**: Node.js 20+ / TypeScript, Express.js
- **Motor Headless**: Playwright con Chromium + Stealth Evasions
- **Datos Económicos**: ArgentinaDatos REST API (`https://api.argentinadatos.com/v1`)
- **Base de Datos Cloud**: Supabase (`@supabase/supabase-js`) / PostgreSQL
- **Frontend**: HTML5, Tailwind CSS, FontAwesome, Server-Sent Events (SSE)
- **Despliegue**: Docker Multi-stage / Render Blueprint (`render.yaml`)

---

## 📦 Instalación y Uso Local

1. **Ingresar a la carpeta del proyecto:**
   ```bash
   cd C:\Users\LENOVO\.gemini\antigravity\scratch\BotArca
   ```
2. **Instalar navegadores de Playwright:**
   ```bash
   npx playwright install chromium
   ```
3. **Iniciar en modo desarrollo:**
   ```bash
   npm run dev
   ```
4. **Abrir el panel web en el navegador:**
   👉 `http://localhost:3000`

---

## ☁️ Despliegue en Render

1. Sube este repositorio a **GitHub** o **GitLab**.
2. En **Render.com**:
   - Crea un **New Web Service** conectando tu repositorio.
   - Selecciona **Runtime**: `Docker`.
   - Asigna las variables de entorno (`APP_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY`, `KEEP_ALIVE_ENABLED=true`, `RENDER_EXTERNAL_URL`).
3. Para mantenerlo activo 24/7 sin costo, agrega tu URL (ej: `https://tu-botarca.onrender.com/api/ping`) en un monitor gratuito de [UptimeRobot.com](https://uptimerobot.com).
