import express, { Request, Response, NextFunction } from 'express';
import { authenticateToken, requireOperator, requireAdmin, AuthenticatedRequest } from './middleware/auth.middleware.js';
import { obtenerArchivo } from './services/enlacesTemporales.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger } from './services/logger.js';
import { keepAliveService } from './services/keepAlive.js';
import { schedulerService } from './services/scheduler.js';
import { arcaSession } from './engine/arcaSession.js';

import authRoutes from './routes/auth.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import keepaliveRoutes from './routes/keepalive.routes.js';
import logsRoutes from './routes/logs.routes.js';
import finanzasRoutes from './routes/finanzas.routes.js';
import erpRoutes from './routes/erp.routes.js';
import usersRoutes from './routes/users.routes.js';
import queueRoutes from './routes/queue.routes.js';
import accountsRoutes from './routes/accounts.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import storageRoutes from './routes/storage.routes.js';

import {
  securityHeaders,
  secureCors,
  inputSanitizer,
  apiRateLimiter,
  authRateLimiter,
  heavyOperationRateLimiter
} from './middleware/security.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// En Render el pedido pasa por Cloudflare y por el balanceador de Render: dos saltos.
// Con 2, req.ip es la IP que anotó Cloudflare (la real del usuario); lo que el cliente
// mande en X-Forwarded-For queda a la izquierda y se ignora. Ajustable con TRUST_PROXY_HOPS.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || (process.env.NODE_ENV === 'production' ? 2 : 1));

// 1. Blindaje de cabeceras HTTP y Content-Security-Policy (CSP)
app.use(securityHeaders);

// 2. CORS Estricto y validación de orígenes autorizados
app.use(secureCors);

// 3. Parsers con límites de carga seguros (50MB para adjuntos y planillas)
app.use(express.json({ limit: '3mb' })); // alcanza para un logo de 400 KB y listas largas
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// 4. Sanitización global de entradas contra XSS y Prototype Pollution
app.use(inputSanitizer);

// 5. Archivos estáticos de la interfaz web
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// 6. Rate Limiting general para la API
app.use('/api', apiRateLimiter);

// 7. Rate Limiting estricto para rutas críticas de autenticación
app.use('/api/auth', authRateLimiter);
app.use('/api/users/login', authRateLimiter);
app.use('/api/users/register', authRateLimiter);

// 8. Rate Limiting para operaciones pesadas (ARCA / IA / Batch / Storage)
app.use('/api/tasks', heavyOperationRateLimiter);
app.use('/api/queue/process', heavyOperationRateLimiter);
app.use('/api/queue/parse-smart', heavyOperationRateLimiter);
app.use('/api/storage/upload', heavyOperationRateLimiter);
// Operaciones que llaman a ARCA o consumen CPU (emitir, probar conexión, generar clave RSA, armar PDF)
app.use('/api/erp/facturacion/emitir', heavyOperationRateLimiter);
app.use(/^\/api\/accounts\/\d{11}\/(ws\/probar|ws\/csr|diseno\/vista-previa)$/, heavyOperationRateLimiter);
app.use(/^\/api\/erp\/comprobantes\/[^/]+\/(enviar|enlace)$/, heavyOperationRateLimiter);

// 9. Autenticación obligatoria. Antes estas rutas respondían SIN login: cualquiera con la URL
//    podía listar cuentas, emitir comprobantes o procesar la cola.
//    Públicas: /api/auth, /api/users/login|register (propias), /api/finanzas (cotizaciones),
//    /api/ping y /api/keepalive/ping|health (monitores de uptime).
const soloOperadorParaEscrituras = (req: Request, res: Response, next: NextFunction) =>
  req.method === 'GET' ? next() : requireOperator(req as AuthenticatedRequest, res, next);

for (const ruta of ['/api/erp', '/api/queue', '/api/accounts']) {
  app.use(ruta, authenticateToken, soloOperadorParaEscrituras);
}
// Sistema y funciones viejas que operan sobre todos los usuarios: solo el administrador
for (const ruta of ['/api/tasks', '/api/logs', '/api/storage']) {
  app.use(ruta, authenticateToken, requireAdmin);
}
app.use('/api/keepalive', (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' && (req.path === '/ping' || req.path === '/health')) return next();
  return authenticateToken(req as AuthenticatedRequest, res, () => requireAdmin(req as AuthenticatedRequest, res, next));
});

// Rutas de la API
app.use('/api/users', usersRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/keepalive', keepaliveRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/finanzas', finanzasRoutes);
app.use('/api/erp', erpRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/storage', storageRoutes);

// Endpoint rápido /healthz y /ping para Render y UptimeRobot
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// PDFs por enlace temporal. Sin la política de seguridad del panel: con "object-src 'none'"
// el visor de PDF del navegador queda bloqueado y la pestaña sale en blanco.
app.get('/archivo/:ticket', (req, res) => {
  const a = obtenerArchivo(String(req.params.ticket));
  res.removeHeader('Content-Security-Policy');
  if (!a) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Enlace vencido</title><p style="font-family:sans-serif;padding:24px">Este enlace venció (duran 10 minutos). Volvé al panel y abrí el PDF de nuevo.</p>');
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nombre)}"`);
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.send(a.buffer);
});
app.get('/api/ping', (req, res) => {
  res.json({ status: 'pong', service: 'BotArca', timestamp: new Date().toISOString() });
});

// Fallback para SPA en la raíz
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Iniciar Servidor
const server = app.listen(config.port, () => {
  logger.success('SISTEMA', `🚀 BotArca iniciado correctamente en http://localhost:${config.port}`);
  logger.info('SISTEMA', `📦 Modo Headless: ${config.engine.headless ? 'Activado (Backend puro)' : 'Desactivado (Navegador visible)'}`);
  
  // Inicializar servicios
  keepAliveService.init();
  schedulerService.init();
  import('./database.js').then(({ db }) => {
    db.syncFromSupabase()
      .catch(() => {})
      .then(() => db.restoreWsFromSupabase())
      .then(() => import('./services/comprobantesService.js'))
      .then(({ comprobantesService }) => comprobantesService.restaurarDesdeSupabase())
      .catch(() => {});
  }).catch(() => {});
});

// Manejo de apagado graceful
const gracefulShutdown = async (signal: string) => {
  logger.info('SISTEMA', `Recibida señal ${signal}. Cerrando BotArca de forma segura...`);
  keepAliveService.stop();
  schedulerService.stop();
  await arcaSession.closeAll();
  server.close(() => {
    logger.info('SISTEMA', 'Servidor HTTP cerrado. Proceso terminado.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
