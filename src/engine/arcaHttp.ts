import axios, { AxiosInstance } from 'axios';
import { db } from '../database.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

export class ArcaHttpClient {
  private client: AxiosInstance;

  constructor(cookies?: any[]) {
    const sessionCookies = cookies || db.getSessionCookies();
    const cookieHeader = sessionCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');

    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': config.engine.userAgent,
        'Accept': 'application/json, text/html, application/xhtml+xml, */*',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Cookie': cookieHeader,
        'X-Requested-With': 'XMLHttpRequest',
      },
      validateStatus: () => true, // Para inspeccionar respuestas HTTP sin lanzar excepciones abruptas
    });
  }

  /**
   * Ejecuta una petición GET inspeccionando el backend de ARCA
   */
  public async get(url: string, params?: any) {
    logger.info('HTTP-ARCA', `Petición GET directa a: ${url}`);
    const res = await this.client.get(url, { params });
    logger.info('HTTP-ARCA', `Respuesta HTTP ${res.status} de ${url}`);
    return res;
  }

  /**
   * Ejecuta una petición POST con payload JSON o form-data
   */
  public async post(url: string, data?: any, customHeaders?: Record<string, string>) {
    logger.info('HTTP-ARCA', `Petición POST directa a: ${url}`);
    const res = await this.client.post(url, data, {
      headers: { ...customHeaders },
    });
    logger.info('HTTP-ARCA', `Respuesta HTTP ${res.status} de ${url}`);
    return res;
  }
}
