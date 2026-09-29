import express from 'express';
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

// Confianza en proxies (Render, Cloudflare, Load Balancers)
app.set('trust proxy', 1);

// 1. Blindaje de cabeceras HTTP y Content-Security-Policy (CSP)
app.use(securityHeaders);

// 2. CORS Estricto y validación de orígenes autorizados
app.use(secureCors);

// 3. Parsers con límites de carga seguros (50MB para adjuntos y planillas)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    db.syncFromSupabase().catch(() => {});
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
