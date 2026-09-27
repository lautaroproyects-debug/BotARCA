import { Router, Request, Response } from 'express';
import { logger } from '../services/logger.js';

const router = Router();

// Server-Sent Events (SSE) Stream para transmitir logs en tiempo real a la interfaz web
router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  logger.addClient(res);

  // Ping periódico en el socket SSE para mantener la conexión viva
  const keepAliveInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    logger.removeClient(res);
  });
});

// Obtener registros de log recientes
router.get('/', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json({ logs: logger.getRecentLogs(limit) });
});

export default router;
