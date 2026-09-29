import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

export interface ArcaAccountRecord {
  id: string;
  cuit: string;
  razonSocial?: string;
  encryptedClaveFiscal: string;
  puntoVentaDefault: number;
  activa: boolean;
  createdAt: string;
}

export interface InvoicingQueueItem {
  id: string;
  cuitEmisor?: string;
  razonSocialEmisor?: string;
  puntoVenta: number;
  tipoComprobante: string;
  concepto: number; // 1, 2, 3
  docTipo: string;
  docNro: string;
  razonSocial: string;
  condicionIva: string;
  condicionVenta: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  importeTotal: number;
  email?: string;
  estado: 'pendiente' | 'procesando' | 'emitida' | 'error';
  cae?: string;
  caeVencimiento?: string;
  comprobanteNro?: string;
  errorMensaje?: string;
  createdAt: string;
  procesadaAt?: string;
}

export interface ClienteRecord {
  id: string;
  cuit: string;
  tipoDoc: string;
  razonSocial: string;
  condicionIva: string;
  domicilio?: string;
  email?: string;
  telefono?: string;
  createdAt: string;
}

export interface ComprobanteRecord {
  id: string;
  tipoOperacion: string;
  tipoComprobante: string;
  puntoVenta: number;
  numero: number;
  comprobanteFormato: string;
  fechaEmision: string;
  cuitEmisor?: string;
  razonSocialEmisor?: string;
  cuitReceptor?: string;
  razonSocialReceptor?: string;
  condicionIvaReceptor?: string;
  importeTotal: number;
  cae?: string;
  caeVencimiento?: string;
  estado: string;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'operator' | 'viewer';
  active: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  startedAt: string;
  completedAt?: string;
  resultSummary?: string;
  details?: any;
  error?: string;
}

export interface AppDatabase {
  credentials: {
    cuit: string;
    encryptedClaveFiscal: string;
    puntoVentaDefault: number;
    razonSocial?: string;
    lastLoginAt?: string;
    sessionValid?: boolean;
  };
  accounts: ArcaAccountRecord[];
  users: UserRecord[];
  queue: InvoicingQueueItem[];
  clientes: ClienteRecord[];
  comprobantes: ComprobanteRecord[];
  settings: {
    keepAliveEnabled: boolean;
    keepAliveIntervalMinutes: number;
    externalUrl: string;
    autoSyncEnabled: boolean;
    autoSyncCron: string;
    uptimeRobotApiKey?: string;
    uptimeRobotMonitorId?: string;
    mailProvider?: 'resend' | 'brevo' | 'auto' | 'simulation';
    resendApiKey?: string;
    brevoApiKey?: string;
    mailSenderEmail?: string;
    mailSenderName?: string;
    adminNotifyEmail?: string;
    groqApiKey?: string;
  };
  tasks: TaskRecord[];
  sessionCookies: any[];
  lastKeepAliveAt?: string;
}

const DB_FILE = path.join(config.paths.dataDir, 'botarca_db.json');

class DatabaseManager {
  public data: AppDatabase;

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
        cuit: config.arca.cuit || '',
        encryptedClaveFiscal: config.arca.claveFiscal ? encrypt(config.arca.claveFiscal) : '',
        puntoVentaDefault: config.arca.puntoVenta || 1,
        razonSocial: config.arca.razonSocial || (config.arca.cuit ? `Cuenta ${config.arca.cuit}` : undefined),
        sessionValid: false,
      },
      accounts: config.arca.cuit && config.arca.claveFiscal ? [{
        id: 'acc_env_' + config.arca.cuit,
        cuit: config.arca.cuit,
        razonSocial: config.arca.razonSocial || `Cuenta ${config.arca.cuit}`,
        encryptedClaveFiscal: encrypt(config.arca.claveFiscal),
        puntoVentaDefault: config.arca.puntoVenta || 1,
        activa: true,
        createdAt: new Date().toISOString(),
      }] : [],
      users: [],
      queue: [],
      clientes: [],
      comprobantes: [],
      settings: {
        keepAliveEnabled: config.keepAlive.enabled,
        keepAliveIntervalMinutes: config.keepAlive.intervalMinutes,
        externalUrl: config.keepAlive.externalUrl,
        autoSyncEnabled: false,
        autoSyncCron: config.scheduler.cronExpression,
        uptimeRobotApiKey: config.uptimeRobotApiKey,
        mailProvider: (process.env.MAIL_PROVIDER as any) || 'auto',
        resendApiKey: process.env.RESEND_API_KEY || '',
        brevoApiKey: process.env.BREVO_API_KEY || '',
        mailSenderEmail: process.env.MAIL_SENDER_EMAIL || 'onboarding@resend.dev',
        mailSenderName: process.env.MAIL_SENDER_NAME || 'BotArca Cloud',
        adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL || '',
        groqApiKey: process.env.GROQ_API_KEY || '',
      },
      tasks: [],
      sessionCookies: [],
    };

    let loadedData: AppDatabase = defaultData;

    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        loadedData = { ...defaultData, ...parsed };
      } catch (e) {
        console.error('Error al leer base de datos local, inicializando nueva:', e);
        loadedData = defaultData;
      }
    }

    // Bootstrap desde variables de entorno de Render (sin necesidad de archivos en disco)
    if (config.arca.cuit && config.arca.claveFiscal) {
      const encryptedClave = encrypt(config.arca.claveFiscal);
      loadedData.credentials.cuit = config.arca.cuit;
      loadedData.credentials.encryptedClaveFiscal = encryptedClave;
      loadedData.credentials.puntoVentaDefault = config.arca.puntoVenta || loadedData.credentials.puntoVentaDefault || 1;
      if (config.arca.razonSocial) loadedData.credentials.razonSocial = config.arca.razonSocial;

      if (!loadedData.accounts) loadedData.accounts = [];
      const idx = loadedData.accounts.findIndex(a => a.cuit === config.arca.cuit);
      if (idx !== -1) {
        loadedData.accounts[idx].encryptedClaveFiscal = encryptedClave;
        loadedData.accounts[idx].puntoVentaDefault = config.arca.puntoVenta || loadedData.accounts[idx].puntoVentaDefault || 1;
        if (config.arca.razonSocial) loadedData.accounts[idx].razonSocial = config.arca.razonSocial;
      } else {
        loadedData.accounts.push({
          id: 'acc_env_' + config.arca.cuit,
          cuit: config.arca.cuit,
          razonSocial: config.arca.razonSocial || `Cuenta ${config.arca.cuit}`,
          encryptedClaveFiscal: encryptedClave,
          puntoVentaDefault: config.arca.puntoVenta || 1,
          activa: true,
          createdAt: new Date().toISOString(),
        });
      }
    }

    this.save(loadedData);
    return loadedData;
  }

  public save(dataToSave: AppDatabase = this.data) {
    try {
      this.ensureDataDir();
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(dataToSave, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (e) {
      console.error('Error guardando base de datos:', e);
    }
  }

  // --- CREDENCIALES & CUENTAS ARCA ---
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

    // Agregar o actualizar en accounts
    const existingIdx = this.data.accounts.findIndex(a => a.cuit === this.data.credentials.cuit);
    if (existingIdx !== -1) {
      this.data.accounts[existingIdx].encryptedClaveFiscal = this.data.credentials.encryptedClaveFiscal;
      this.data.accounts[existingIdx].puntoVentaDefault = puntoVentaDefault;
      if (razonSocial) this.data.accounts[existingIdx].razonSocial = razonSocial;
    } else if (this.data.credentials.cuit) {
      this.data.accounts.push({
        id: 'acc_' + Date.now(),
        cuit: this.data.credentials.cuit,
        razonSocial: razonSocial || `Cuenta ${this.data.credentials.cuit}`,
        encryptedClaveFiscal: this.data.credentials.encryptedClaveFiscal,
        puntoVentaDefault,
        activa: true,
        createdAt: new Date().toISOString(),
      });
    }

    this.save();

    // Sincronizar en Supabase cuentas_arca (PostgreSQL Cloud) si está disponible
    try {
      import('./services/supabase.js').then(async ({ supabase }) => {
        const client = supabase.getClient();
        if (client && this.data.credentials.cuit) {
          try {
            await client.from('cuentas_arca').upsert({
              cuit: this.data.credentials.cuit,
              razon_social: this.data.credentials.razonSocial,
              encrypted_clave_fiscal: this.data.credentials.encryptedClaveFiscal,
              punto_venta_default: this.data.credentials.puntoVentaDefault,
              activa: true,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'cuit' });
          } catch (err) {}
        }
      }).catch(() => {});
    } catch (e) {}
  }

  public getAccounts(): Array<Omit<ArcaAccountRecord, 'encryptedClaveFiscal'>> {
    return (this.data.accounts || []).map(a => ({
      id: a.id,
      cuit: a.cuit,
      razonSocial: a.razonSocial,
      puntoVentaDefault: a.puntoVentaDefault,
      activa: a.activa,
      createdAt: a.createdAt,
    }));
  }

  public switchActiveAccount(cuit: string) {
    const acc = this.data.accounts.find(a => a.cuit === cuit);
    if (acc) {
      this.data.credentials = {
        cuit: acc.cuit,
        encryptedClaveFiscal: acc.encryptedClaveFiscal,
        puntoVentaDefault: acc.puntoVentaDefault,
        razonSocial: acc.razonSocial,
        sessionValid: true,
      };
      this.save();
      return true;
    }
    return false;
  }

  public updateSessionStatus(valid: boolean, lastLoginAt?: string, razonSocial?: string) {
    this.data.credentials.sessionValid = valid;
    if (lastLoginAt) this.data.credentials.lastLoginAt = lastLoginAt;
    if (razonSocial) this.data.credentials.razonSocial = razonSocial;
    this.save();
  }

  // --- COLA DE FACTURACIÓN (BATCH INVOICING QUEUE) ---
  public getQueue(): InvoicingQueueItem[] {
    return this.data.queue || [];
  }

  public addQueueItems(items: Array<Omit<InvoicingQueueItem, 'id' | 'createdAt' | 'estado'>>): InvoicingQueueItem[] {
    const created: InvoicingQueueItem[] = items.map(item => ({
      id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      ...item,
      estado: 'pendiente',
      createdAt: new Date().toISOString(),
    }));

    if (!this.data.queue) this.data.queue = [];
    this.data.queue.unshift(...created);
    this.save();
    return created;
  }

  public updateQueueItem(id: string, update: Partial<InvoicingQueueItem>) {
    const item = (this.data.queue || []).find(q => q.id === id);
    if (item) {
      Object.assign(item, update);
      if (update.estado === 'emitida' || update.estado === 'error') {
        item.procesadaAt = new Date().toISOString();
      }
      this.save();
      return item;
    }
    return null;
  }

  public deleteQueueItem(id: string) {
    const idx = (this.data.queue || []).findIndex(q => q.id === id);
    if (idx !== -1) {
      this.data.queue.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  public clearQueue(statusFilter?: string) {
    if (statusFilter) {
      this.data.queue = (this.data.queue || []).filter(q => q.estado !== statusFilter);
    } else {
      this.data.queue = [];
    }
    this.save();
  }

  // --- CONFIGURACIÓN GENERAL ---
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
    if (!this.data.tasks) this.data.tasks = [];
    this.data.tasks.unshift(record);
    if (this.data.tasks.length > 100) {
      this.data.tasks = this.data.tasks.slice(0, 100);
    }
    this.save();
    return record;
  }

  public updateTask(id: string, update: Partial<TaskRecord>) {
    const idx = (this.data.tasks || []).findIndex(t => t.id === id);
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
    return (this.data.tasks || []).slice(0, limit);
  }

  public getTaskById(id: string): TaskRecord | null {
    return (this.data.tasks || []).find(t => t.id === id) || null;
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
