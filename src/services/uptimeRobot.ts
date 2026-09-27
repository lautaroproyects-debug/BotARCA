import axios from 'axios';
import { db } from '../database.js';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface UptimeRobotMonitor {
  id: number;
  friendly_name: string;
  url: string;
  type: number;
  status: number; // 0: paused, 1: not checked, 2: up, 8: seems down, 9: down
  all_time_uptime_ratio?: string;
  custom_uptime_ratio?: string;
  average_response_time?: number;
}

export class UptimeRobotService {
  private baseUrl = 'https://api.uptimerobot.com/v2';

  private getApiKey(): string {
    const settings = db.getSettings();
    return settings.uptimeRobotApiKey || config.uptimeRobotApiKey || 'u3807259-da5acf1c8d7f897703ff3f2b';
  }

  /**
   * Obtiene la lista y estado de los monitores configurados en la cuenta
   */
  public async getMonitors(): Promise<{ success: boolean; monitors?: UptimeRobotMonitor[]; error?: string }> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return { success: false, error: 'No se ha configurado la API Key de UptimeRobot.' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/getMonitors`,
        new URLSearchParams({
          api_key: apiKey,
          format: 'json',
          response_times: '1',
          custom_uptime_ratios: '1-7-30',
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
          },
          timeout: 10000,
        }
      );

      if (response.data && response.data.stat === 'ok') {
        const monitors: UptimeRobotMonitor[] = (response.data.monitors || []).map((m: any) => ({
          id: m.id,
          friendly_name: m.friendly_name,
          url: m.url,
          type: m.type,
          status: m.status,
          all_time_uptime_ratio: m.all_time_uptime_ratio,
          custom_uptime_ratio: m.custom_uptime_ratio,
          average_response_time: m.average_response_time,
        }));
        return { success: true, monitors };
      } else {
        const errMsg = response.data?.error?.message || 'Error en la respuesta de UptimeRobot';
        return { success: false, error: errMsg };
      }
    } catch (err: any) {
      logger.error('UPTIMEROBOT', `Error al consultar monitores: ${err.message}`);
      return { success: false, error: err.response?.data?.error?.message || err.message };
    }
  }

  /**
   * Crea o sincroniza automáticamente un monitor para la URL pública de BotArca en Render
   */
  public async syncOrRegisterMonitor(targetUrl?: string): Promise<{ success: boolean; message: string; monitor?: any }> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return { success: false, message: 'Falta la API Key de UptimeRobot.' };
    }

    const settings = db.getSettings();
    const publicUrl = targetUrl || settings.externalUrl || config.keepAlive.externalUrl;

    if (!publicUrl || !publicUrl.startsWith('http')) {
      return {
        success: false,
        message: 'Debes definir la URL pública de tu servicio en Render (ej: https://botarca.onrender.com) antes de registrar el monitor.',
      };
    }

    const pingUrl = publicUrl.endsWith('/api/ping') ? publicUrl : `${publicUrl.replace(/\/$/, '')}/api/ping`;
    const friendlyName = 'BotArca Render 24/7';

    try {
      // 1. Verificar si ya existe un monitor para esta URL
      const current = await this.getMonitors();
      if (current.success && current.monitors) {
        const existing = current.monitors.find(m => m.url === pingUrl || m.url === publicUrl);
        if (existing) {
          logger.info('UPTIMEROBOT', `Monitor existente detectado: ID ${existing.id} (${existing.friendly_name})`);
          db.updateSettings({ uptimeRobotMonitorId: String(existing.id) });
          return {
            success: true,
            message: `Monitor ya existente y activo (ID: ${existing.id}). Estado: ${this.getStatusLabel(existing.status)}`,
            monitor: existing,
          };
        }
      }

      // 2. Si no existe, crear un nuevo monitor HTTP(S) con intervalo de 5 minutos (300 seg)
      logger.info('UPTIMEROBOT', `Creando nuevo monitor HTTP(S) en UptimeRobot para: ${pingUrl}`);
      const createRes = await axios.post(
        `${this.baseUrl}/newMonitor`,
        new URLSearchParams({
          api_key: apiKey,
          format: 'json',
          type: '1', // 1 = HTTP(s)
          friendly_name: friendlyName,
          url: pingUrl,
          interval: '300', // 5 minutos para evitar que Render duerma
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );

      if (createRes.data && createRes.data.stat === 'ok') {
        const monitorId = createRes.data.monitor?.id;
        if (monitorId) {
          db.updateSettings({ uptimeRobotMonitorId: String(monitorId) });
        }
        logger.success('UPTIMEROBOT', `¡Monitor UptimeRobot creado con éxito! ID: ${monitorId} para ${pingUrl}`);
        return {
          success: true,
          message: `Monitor "${friendlyName}" creado exitosamente en UptimeRobot (ID ${monitorId}). Chequeo cada 5 minutos.`,
          monitor: createRes.data.monitor,
        };
      } else {
        const errorMsg = createRes.data?.error?.message || 'No se pudo crear el monitor.';
        logger.error('UPTIMEROBOT', `Fallo al crear monitor: ${errorMsg}`);
        return { success: false, message: errorMsg };
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || err.message;
      logger.error('UPTIMEROBOT', `Excepción al conectar con UptimeRobot: ${errMsg}`);
      return { success: false, message: errMsg };
    }
  }

  public getStatusLabel(status: number): string {
    switch (status) {
      case 0: return 'Pausado';
      case 1: return 'No verificado aún';
      case 2: return 'Operativo (UP)';
      case 8: return 'Parece caído';
      case 9: return 'Caído (DOWN)';
      default: return `Estado desconocido (${status})`;
    }
  }
}

export const uptimeRobotService = new UptimeRobotService();
