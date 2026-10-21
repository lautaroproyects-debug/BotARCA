import { config } from '../config.js';
import { logger } from './logger.js';

const RENDER_API_KEY = 'rnd_xfxmD9gW1Rf9g2HEW9AI9Ps4UhnW';
const SERVICE_ID = 'srv-dasuvcd9fdbs73f80ckg';

export class RenderPersistenceService {
  /**
   * Guarda de forma atómica una variable de entorno en el Web Service de Render
   */
  public static async persistEnvVar(key: string, value: string): Promise<boolean> {
    try {
      // 1. Obtener variables actuales
      const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
        headers: { 'Authorization': `Bearer ${RENDER_API_KEY}` }
      });

      if (!res.ok) {
        logger.warn('RENDER-PERSIST', `Fallo al leer env-vars de Render: HTTP ${res.status}`);
        return false;
      }

      const list: any[] = (await res.json()) as any[];
      const currentVars = list.map(item => ({
        key: item.envVar.key,
        value: item.envVar.value,
      }));

      // 2. Modificar o agregar la clave
      const existingIdx = currentVars.findIndex(v => v.key === key);
      if (existingIdx !== -1) {
        currentVars[existingIdx].value = value;
      } else {
        currentVars.push({ key, value });
      }

      // 3. Escribir de forma atómica
      const putRes = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${RENDER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(currentVars),
      });

      if (putRes.ok) {
        logger.success('RENDER-PERSIST', `Variable ${key} persistida exitosamente en Render Cloud.`);
        return true;
      } else {
        logger.warn('RENDER-PERSIST', `Error al escribir env-vars en Render: HTTP ${putRes.status}`);
        return false;
      }
    } catch (e: any) {
      logger.error('RENDER-PERSIST', `Excepción al persistir en Render: ${e.message}`);
      return false;
    }
  }

  /**
   * Persiste la lista completa de cuentas CUIT en Render para que sobrevivan cualquier redeploy o reinicio
   */
  public static async persistAccounts(accounts: any[]): Promise<boolean> {
    try {
      const sanitized = accounts.map(a => ({
        id: a.id,
        cuit: a.cuit,
        razonSocial: a.razonSocial,
        cuitRepresentante: a.cuitRepresentante,
        nombreRepresentante: a.nombreRepresentante,
        emailNotificaciones: a.emailNotificaciones,
        encryptedClaveFiscal: a.encryptedClaveFiscal,
        puntoVentaDefault: a.puntoVentaDefault,
        activa: a.activa,
        createdAt: a.createdAt,
      }));
      return await this.persistEnvVar('ARCA_ACCOUNTS', JSON.stringify(sanitized));
    } catch (e: any) {
      return false;
    }
  }

  /**
   * Persiste la lista de clientes CRM en Render
   */
  public static async persistClientes(clientes: any[]): Promise<boolean> {
    try {
      return await this.persistEnvVar('BOTARCA_CLIENTES', JSON.stringify(clientes));
    } catch (e: any) {
      return false;
    }
  }
}
