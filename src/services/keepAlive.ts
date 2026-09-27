import axios from 'axios';
import { db } from '../database.js';
import { logger } from './logger.js';
import { config } from '../config.js';

class KeepAliveService {
  private timer: NodeJS.Timeout | null = null;
  private pingCount = 0;
  private startTime = Date.now();

  constructor() {
    this.init();
  }

  public init() {
    const settings = db.getSettings();
    if (settings.keepAliveEnabled) {
      this.start(settings.keepAliveIntervalMinutes);
    }
  }

  public start(intervalMinutes: number = 10) {
    this.stop();
    const ms = Math.max(1, intervalMinutes) * 60 * 1000;
    
    logger.info('KEEP-ALIVE', `Sistema Keep-Alive activado. Intervalo: cada ${intervalMinutes} minutos.`);

    this.timer = setInterval(async () => {
      await this.executePing();
    }, ms);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('KEEP-ALIVE', 'Sistema Keep-Alive detenido.');
    }
  }

  public async executePing(source: string = 'internal_timer'): Promise<{ success: boolean; message: string; timestamp: string }> {
    this.pingCount++;
    const timestamp = new Date().toISOString();
    db.setLastKeepAlive(timestamp);

    const settings = db.getSettings();
    const externalUrl = settings.externalUrl || config.keepAlive.externalUrl;

    if (externalUrl && externalUrl.startsWith('http')) {
      try {
        const pingTarget = externalUrl.endsWith('/api/ping') ? externalUrl : `${externalUrl.replace(/\/$/, '')}/api/ping`;
        logger.info('KEEP-ALIVE', `Enviando Self-Ping a URL pública: ${pingTarget} (Ping #${this.pingCount})`);
        
        const response = await axios.get(pingTarget, { timeout: 10000 });
        logger.success('KEEP-ALIVE', `Ping exitoso [${response.status}]. Instancia en Render activa.`);
        return { success: true, message: `Ping público exitoso (${response.status})`, timestamp };
      } catch (err: any) {
        logger.warn('KEEP-ALIVE', `Fallo al hacer ping a URL pública (${err.message}). Manteniendo ciclo interno.`);
        return { success: false, message: `Fallo ping externo: ${err.message}`, timestamp };
      }
    } else {
      logger.info('KEEP-ALIVE', `Tick interno de actividad #${this.pingCount}. Memoria y proceso activos.`);
      return { success: true, message: `Tick de actividad interno #${this.pingCount}`, timestamp };
    }
  }

  public getStats() {
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;

    const memory = process.memoryUsage();

    return {
      status: 'active',
      uptimeFormatted: `${hours}h ${minutes}m ${seconds}s`,
      uptimeSeconds: uptimeSec,
      totalPings: this.pingCount,
      lastKeepAlive: db.getLastKeepAlive() || 'Sin pings aún',
      memoryUsageMB: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      },
      settings: db.getSettings(),
    };
  }
}

export const keepAliveService = new KeepAliveService();
