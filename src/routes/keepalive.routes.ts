import { Router, Request, Response } from 'express';
import { keepAliveService } from '../services/keepAlive.js';
import { db } from '../database.js';
import { logger } from '../services/logger.js';

const router = Router();

// Endpoint de ping público (compatible con UptimeRobot, cron-job.org, BetterStack, Render, etc.)
router.get('/ping', (req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  db.setLastKeepAlive(timestamp);
  res.json({
    status: 'pong',
    service: 'BotArca',
    timestamp,
    message: 'Servicio BotArca activo y respondiendo.',
  });
});

// Endpoint de salud y diagnóstico
router.get('/health', (req: Request, res: Response) => {
  const stats = keepAliveService.getStats();
  res.json(stats);
});

// Guardar configuración de Keep-Alive
router.post('/config', (req: Request, res: Response) => {
  const { keepAliveEnabled, keepAliveIntervalMinutes, externalUrl, autoSyncEnabled, autoSyncCron } = req.body;

  const current = db.getSettings();
  const updated = {
    keepAliveEnabled: keepAliveEnabled !== undefined ? Boolean(keepAliveEnabled) : current.keepAliveEnabled,
    keepAliveIntervalMinutes: keepAliveIntervalMinutes !== undefined ? Math.max(1, parseInt(keepAliveIntervalMinutes, 10)) : current.keepAliveIntervalMinutes,
    externalUrl: externalUrl !== undefined ? String(externalUrl).trim() : current.externalUrl,
    autoSyncEnabled: autoSyncEnabled !== undefined ? Boolean(autoSyncEnabled) : current.autoSyncEnabled,
    autoSyncCron: autoSyncCron !== undefined ? String(autoSyncCron).trim() : current.autoSyncCron,
  };

  db.updateSettings(updated);

  // Reiniciar o ajustar servicio de Keep-Alive
  if (updated.keepAliveEnabled) {
    keepAliveService.start(updated.keepAliveIntervalMinutes);
  } else {
    keepAliveService.stop();
  }

  logger.info('CONFIG', 'Configuración de Keep-Alive y tareas automáticas actualizada.');
  res.json({ success: true, message: 'Configuración guardada correctamente.', settings: updated });
});

// Ejecutar un ping manual ahora
router.post('/trigger', async (req: Request, res: Response) => {
  const result = await keepAliveService.executePing('manual_ui');
  res.json(result);
});

export default router;
