import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

export interface BotCredentials {
  cuit: string;
  encryptedClaveFiscal: string;
  puntoVentaDefault?: number;
  razonSocial?: string;
  lastLoginAt?: string;
  sessionValid?: boolean;
}

export interface TaskRecord {
  id: string;
  type: 'login_test' | 'facturacion' | 'comprobantes' | 'monotributo' | 'notificaciones' | 'keep_alive' | 'sync_auto';
  status: 'pending' | 'running' | 'success' | 'failed';
  startedAt: string;
  completedAt?: string;
  resultSummary?: string;
  details?: any;
  error?: string;
}

export interface AppDatabase {
  credentials: BotCredentials;
  settings: {
    keepAliveEnabled: boolean;
    keepAliveIntervalMinutes: number;
    externalUrl: string;
    autoSyncEnabled: boolean;
    autoSyncCron: string;
    uptimeRobotApiKey?: string;
    uptimeRobotMonitorId?: string;
  };
  tasks: TaskRecord[];
  sessionCookies: any[];
  lastKeepAliveAt?: string;
}

const DB_FILE = path.join(config.paths.dataDir, 'botarca_db.json');

class DatabaseManager {
  private data: AppDatabase;

  constructor() {
    this.ensureDataDir();
    this.data = this.load();
  }

  private ensureDataDir() {
    if (!fs.existsSync(config.paths.dataDir)) {
      fs.mkdirSync(config.paths.dataDir, { recursive: true });
    }
  }

  private load(): AppDatabase {
    const defaultData: AppDatabase = {
      credentials: {
        cuit: '',
        encryptedClaveFiscal: '',
        puntoVentaDefault: 1,
        sessionValid: false,
      },
      settings: {
        keepAliveEnabled: config.keepAlive.enabled,
        keepAliveIntervalMinutes: config.keepAlive.intervalMinutes,
        externalUrl: config.keepAlive.externalUrl,
        autoSyncEnabled: false,
        autoSyncCron: config.scheduler.cronExpression,
        uptimeRobotApiKey: config.uptimeRobotApiKey,
      },
      tasks: [],
      sessionCookies: [],
    };

    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        return { ...defaultData, ...JSON.parse(raw) };
      } catch (e) {
        console.error('Error al leer base de datos local, inicializando nueva:', e);
        return defaultData;
      }
    } else {
      this.save(defaultData);
      return defaultData;
    }
  }

  private save(dataToSave: AppDatabase = this.data) {
    try {
      this.ensureDataDir();
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(dataToSave, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (e) {
      console.error('Error guardando base de datos:', e);
    }
  }

  public getCredentials(): { cuit: string; claveFiscal: string; puntoVentaDefault: number; razonSocial?: string; sessionValid?: boolean; lastLoginAt?: string } {
    return {
      cuit: this.data.credentials.cuit,
      claveFiscal: decrypt(this.data.credentials.encryptedClaveFiscal),
      puntoVentaDefault: this.data.credentials.puntoVentaDefault || 1,
      razonSocial: this.data.credentials.razonSocial,
      sessionValid: this.data.credentials.sessionValid,
      lastLoginAt: this.data.credentials.lastLoginAt,
    };
  }

  public setCredentials(cuit: string, claveFiscal: string, puntoVentaDefault: number = 1, razonSocial?: string) {
    this.data.credentials.cuit = cuit.replace(/\D/g, '');
    if (claveFiscal) {
      this.data.credentials.encryptedClaveFiscal = encrypt(claveFiscal);
    }
    this.data.credentials.puntoVentaDefault = puntoVentaDefault;
    if (razonSocial) {
      this.data.credentials.razonSocial = razonSocial;
    }
    this.save();
  }

  public updateSessionStatus(valid: boolean, lastLoginAt?: string, razonSocial?: string) {
    this.data.credentials.sessionValid = valid;
    if (lastLoginAt) this.data.credentials.lastLoginAt = lastLoginAt;
    if (razonSocial) this.data.credentials.razonSocial = razonSocial;
    this.save();
  }

  public getSettings() {
    return this.data.settings;
  }

  public updateSettings(settings: Partial<AppDatabase['settings']>) {
    this.data.settings = { ...this.data.settings, ...settings };
    this.save();
  }

  public getSessionCookies() {
    return this.data.sessionCookies || [];
  }

  public setSessionCookies(cookies: any[]) {
    this.data.sessionCookies = cookies;
    this.save();
  }

  public addTask(task: Omit<TaskRecord, 'id' | 'startedAt' | 'status'> & { status?: TaskRecord['status'] }): TaskRecord {
    const record: TaskRecord = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      startedAt: new Date().toISOString(),
      status: task.status || 'pending',
      ...task,
    };
    this.data.tasks.unshift(record);
    // Limitar historial a últimas 100 tareas
    if (this.data.tasks.length > 100) {
      this.data.tasks = this.data.tasks.slice(0, 100);
    }
    this.save();
    return record;
  }

  public updateTask(id: string, update: Partial<TaskRecord>) {
    const idx = this.data.tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      this.data.tasks[idx] = { ...this.data.tasks[idx], ...update };
      if (update.status === 'success' || update.status === 'failed') {
        this.data.tasks[idx].completedAt = new Date().toISOString();
      }
      this.save();
      return this.data.tasks[idx];
    }
    return null;
  }

  public getTasks(limit: number = 20): TaskRecord[] {
    return this.data.tasks.slice(0, limit);
  }

  public setLastKeepAlive(time: string) {
    this.data.lastKeepAliveAt = time;
    this.save();
  }

  public getLastKeepAlive(): string | undefined {
    return this.data.lastKeepAliveAt;
  }
}

export const db = new DatabaseManager();
