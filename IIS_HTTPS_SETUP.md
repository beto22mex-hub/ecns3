# Guía de Despliegue en IIS con HTTPS y Proxy Reverso (Application Request Routing)

Esta guía detalla la configuración recomendada para desplegar **ECN Manager** en un servidor **Windows Server** utilizando **IIS (Internet Information Services)** con terminación **HTTPS (SSL/TLS)** y **Proxy Reverso** hacia el backend de Node.js / Express.

---

## 🏛️ Arquitectura de la Solución

```
       [ Navegador del Usuario ]
                  │
                  ▼ (HTTPS : 443 - Con Certificado SSL Corporativo)
      ┌──────────────────────────────────────────────────┐
      │  Internet Information Services (IIS)             │
      │  - Terminación SSL/TLS (Puerto 443)              │
      │  - Redirección automática HTTP (80) -> HTTPS     │
      │  - URL Rewrite + Application Request Routing     │
      │  - web.config (Reglas de Proxy y Seguridad)      │
      └──────────────────────────────────────────────────┘
                  │ (HTTP : 3000 internamente en 127.0.0.1)
                  │ Encabezados: X-Forwarded-Proto: https, X-ARR-SSL
                  ▼
      ┌──────────────────────────────────────────────────┐
      │  ECN Manager (Node.js / Express)                 │
      │  - app.set('trust proxy', true)                  │
      │  - Detección nativa de HTTPS y Host              │
      │  - Autenticación Azure AD SSO y APIs             │
      └──────────────────────────────────────────────────┘
```

---

## 📋 1. Requisitos Previos en Windows Server

1. **IIS (Internet Information Services)** instalado con las características:
   - *Herramientas de administración web*
   - *Características de desarrollo de aplicaciones* -> **WebSocket Protocol**
2. **Módulos obligatorios de IIS**:
   - **URL Rewrite Module 2.1** ([Descargar de Microsoft](https://www.iis.net/downloads/microsoft/url-rewrite))
   - **Application Request Routing (ARR) 3.0** ([Descargar de Microsoft](https://www.iis.net/downloads/microsoft/application-request-routing))
3. **Node.js** (v18 o superior) instalado en el servidor.
4. **PM2** (opcional pero recomendado para mantener Node.js corriendo como servicio de Windows):
   ```powershell
   npm install -g pm2 pm2-windows-service
   ```

---

## ⚙️ 2. Habilitar Proxy en ARR (Paso Crítico)

> ⚠️ **Importante**: Por defecto, ARR viene con la función de Proxy desactivada. Si no se activa, IIS devolverá el error `HTTP 500.52 URL Rewrite Module Error`.

### Opción A: Mediante el script automático de PowerShell (Recomendado)
Abre **Windows PowerShell como Administrador** dentro de la carpeta del proyecto y ejecuta:
```powershell
.\scripts\setup-iis-proxy.ps1
```

### Opción B: Desde la interfaz de IIS Manager
1. Abre **IIS Manager** (`inetmgr`).
2. En el panel izquierdo, selecciona el **nodo raíz del Servidor** (el nombre de tu servidor).
3. En el panel central, haz doble clic en **Application Request Routing Cache**.
4. En el panel derecho de Acciones, haz clic en **Server Proxy Settings...**.
5. Marca la casilla **Enable proxy**.
6. Asegúrate de que **Preserve client host in request header** esté marcado.
7. Haz clic en **Apply** (Aplicar) en la esquina superior derecha.

---

## 🔒 3. Configurar el Certificado SSL en IIS (Puerto 443)

1. En IIS Manager, importa tu certificado SSL corporativo en **Certificados de servidor** (Server Certificates).
2. Haz clic derecho en tu Sitio Web en IIS (ej. `Default Web Site` o `ECN-Manager`) > **Editar enlaces... (Edit Bindings...)**.
3. Haz clic en **Agregar... (Add...)**:
   - **Tipo**: `https`
   - **Dirección IP**: `Todas las no asignadas` (o tu IP fija)
   - **Puerto**: `443`
   - **Nombre de host**: `ecn-manager.tu-dominio.com` (opcional si es sitio único)
   - **Certificado SSL**: Selecciona tu certificado corporativo instalado.
4. Haz clic en **Aceptar**.

---

## 📁 4. Archivo `web.config`

El archivo `web.config` ya se encuentra en la raíz del proyecto y se encarga automáticamente de:
- **Redirección HTTP a HTTPS**: Si un usuario entra por `http://`, lo redirige permanentemente a `https://`.
- **Ruteo de Proxy Reverso**: Redirige todas las solicitudes a `http://127.0.0.1:3000/{R:0}`.
- **WebSocket Pass-Through**: Permite WebSockets continuos para monitoreo en vivo.
- **Límite de Carga de 50MB**: Para permitir la subida de planillas grandes de Excel de SAP sin errores `404.13`.
- **PassThrough de Errores**: Permite que las respuestas JSON de error de la API (400, 401, 500) se envíen intactas al navegador en lugar de ser sustituidas por páginas HTML genéricas de IIS.

---

## 🚀 5. Poner en Marcha la Aplicación Node.js

### Paso 1: Compilar la aplicación para producción
```bash
npm run build
```
Esto genera los archivos estáticos en `/dist` y empaqueta el servidor backend en `/dist/server.cjs`.

### Paso 2: Iniciar el servicio con PM2
Usa el archivo de configuración incluido `ecosystem.config.cjs`:
```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
```

Para verificar que el backend está corriendo y respondiendo:
```bash
curl http://127.0.0.1:3000/health
# Debe responder: OK
```

---

## 🔑 6. Configuración en `.env` para HTTPS y Azure AD

En tu archivo `.env` en producción, define:

```env
# Puerto interno donde escucha Node.js (detrás de IIS)
PORT=3000

# URL pública que ven los usuarios (HTTPS)
APP_URL=https://ecn-manager.tu-dominio.com

# Forzar HTTPS a nivel Node (opcional, IIS ya lo maneja mediante web.config)
FORCE_HTTPS=false

# Parámetros de Azure AD (Microsoft Entra ID)
AZURE_CLIENT_ID=27311486-b533-4356-bfda-9b1624299883
AZURE_TENANT_ID=96ece526-9c7d-48b0-8daf-8b93c90a5d18
AZURE_REDIRECT_URI=https://ecn-manager.tu-dominio.com/auth/azure/callback
```

> **Nota para Azure AD**: En el portal de Azure > *App Registrations* > *Authentication*, registra la URL de redirección exactamente con HTTPS:
> `https://ecn-manager.tu-dominio.com/auth/azure/callback`

---

## 🛠️ 7. Solución de Problemas Comunes

| Síntoma / Error | Causa | Solución |
|---|---|---|
| **HTTP 500.52 - URL Rewrite Module Error** | ARR Proxy deshabilitado a nivel servidor | Ejecuta `scripts\setup-iis-proxy.ps1` o ve a IIS > Server > ARR Cache > Server Proxy Settings > Marca **Enable proxy**. |
| **HTTP 502.3 - Bad Gateway** | Node.js no está corriendo en el puerto 3000 | Verifica con `pm2 status` o inicia la app con `npm start` / `pm2 start ecosystem.config.cjs`. |
| **HTTP 404.13 - Content Length Too Large** | Intento de subir un archivo Excel de más de 30MB | El `web.config` incluido ya tiene configurado `maxAllowedContentLength="52428800"` (50MB). Asegúrate de que el `web.config` esté en la raíz del sitio web de IIS. |
| **Cookie de sesión no persiste en login** | Falta de flag Secure en HTTPS | El servidor ya cuenta con `app.set('trust proxy', true)` y detección de `X-Forwarded-Proto` y `X-ARR-SSL`, emitiendo la cookie de sesión como `SameSite=None; Secure`. |
