import cron from 'node-cron';
import { db } from '../database.js';
import { logger } from './logger.js';
import { arcaSession } from '../engine/arcaSession.js';
import { notificacionesModule } from '../engine/modules/notificaciones.js';
import { comprobantesModule } from '../engine/modules/comprobantes.js';

class SchedulerService {
  private currentJob: cron.ScheduledTask | null = null;

  constructor() {
    this.init();
  }

  public init() {
    const settings = db.getSettings();
    if (settings.autoSyncEnabled && settings.autoSyncCron) {
      this.schedule(settings.autoSyncCron);
    }
  }

  public schedule(cronExpression: string) {
    this.stop();

    if (!cron.validate(cronExpression)) {
      logger.error('SCHEDULER', `Expresión cron inválida: "${cronExpression}"`);
      return false;
    }

    logger.info('SCHEDULER', `Programando sincronización automática con cron: "${cronExpression}"`);

    this.currentJob = cron.schedule(cronExpression, async () => {
      logger.info('SCHEDULER', 'Ejecutando tarea programada automática de BotArca...');
      const creds = db.getCredentials();

      if (!creds.cuit || !creds.claveFiscal) {
        logger.warn('SCHEDULER', 'No hay credenciales de ARCA configuradas para la tarea programada.');
        return;
      }

      const task = db.addTask({
        type: 'sync_auto',
        status: 'running',
        resultSummary: 'Iniciando sincronización programada',
      });

      try {
        // 1. Validar / Autenticar sesión en ARCA
        const session = await arcaSession.ensureActiveSession(creds.cuit, creds.claveFiscal);
        if (!session.success) {
          throw new Error(`Fallo de inicio de sesión: ${session.message}`);
        }

        // 2. Comprobar notificaciones del Domicilio Fiscal Electrónico
        logger.info('SCHEDULER', 'Consultando Domicilio Fiscal Electrónico...');
        const notifs = await notificacionesModule.checkNotifications(session);

        // 3. Consultar últimos comprobantes emitidos
        logger.info('SCHEDULER', 'Verificando últimos comprobantes del mes...');
        const comp = await comprobantesModule.getRecentSummary(session);

        db.updateTask(task.id, {
          status: 'success',
          resultSummary: `Sync completado. ${notifs.unreadCount || 0} notificaciones pendientes. ${comp.totalEmitted || 0} comprobantes emitidos en el período.`,
          details: { notificaciones: notifs, comprobantes: comp },
        });

        logger.success('SCHEDULER', `Sincronización automática finalizada con éxito.`);
      } catch (err: any) {
        logger.error('SCHEDULER', `Error en tarea programada: ${err.message}`);
        db.updateTask(task.id, {
          status: 'failed',
          error: err.message,
          resultSummary: 'Error durante la ejecución programada',
        });
      }
    });

    return true;
  }

  public stop() {
    if (this.currentJob) {
      this.currentJob.stop();
      this.currentJob = null;
      logger.info('SCHEDULER', 'Tareas automáticas programadas pausadas.');
    }
  }

  public getStatus() {
    const settings = db.getSettings();
    return {
      active: !!this.currentJob,
      cronExpression: settings.autoSyncCron,
      enabled: settings.autoSyncEnabled,
    };
  }
}

export const schedulerService = new SchedulerService();
