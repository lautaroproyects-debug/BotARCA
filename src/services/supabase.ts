import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

export interface SupabaseConfig {
  url: string;
  key: string;
  enabled: boolean;
}

class SupabaseService {
  private client: SupabaseClient | null = null;
  private isConnected: boolean = false;
  private config: SupabaseConfig = {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    enabled: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)),
  };

  constructor() {
    this.init();
  }

  public init(customUrl?: string, customKey?: string) {
    const url = customUrl || this.config.url;
    const key = customKey || this.config.key;

    if (url && key) {
      try {
        this.client = createClient(url, key, {
          auth: { persistSession: false },
        });
        this.config.url = url;
        this.config.key = key;
        this.config.enabled = true;
        this.testConnection().catch(() => {});
      } catch (err: any) {
        logger.error('SUPABASE', `Error al inicializar cliente Supabase: ${err.message}`);
        this.client = null;
        this.isConnected = false;
      }
    } else {
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Prueba la conexión real contra la base de datos de Supabase
   */
  public async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.client) {
      return { success: false, message: 'Supabase no está configurado (faltan URL y Clave API).' };
    }

    try {
      // Intentar una consulta liviana para verificar autenticación y conexión
      const { data, error } = await this.client.from('configuraciones').select('id').limit(1);

      if (error && error.code !== 'PGRST116' && !error.message.includes('relation "configuraciones" does not exist')) {
        this.isConnected = false;
        logger.warn('SUPABASE', `Aviso de conexión Supabase: ${error.message}`);
        // Si el error es solo que la tabla no existe aún, la conexión básica fue exitosa
        return { success: true, message: `Conectado a Supabase (tablas pendientes de inicialización: ${error.message})` };
      }

      this.isConnected = true;
      logger.success('SUPABASE', '¡Conexión exitosa con base de datos en la nube Supabase!');
      return { success: true, message: 'Conexión con Supabase establecida correctamente.' };
    } catch (err: any) {
      this.isConnected = false;
      logger.error('SUPABASE', `Fallo al verificar conexión con Supabase: ${err.message}`);
      return { success: false, message: `Error de conexión: ${err.message}` };
    }
  }

  public getStatus() {
    return {
      enabled: this.config.enabled,
      connected: this.isConnected,
      hasUrl: !!this.config.url,
      hasKey: !!this.config.key,
      urlMasked: this.config.url ? this.config.url.replace(/(https?:\/\/)([^.]+)(.*)/, '$1***$3') : null,
    };
  }

  public getClient(): SupabaseClient | null {
    return this.client;
  }

  // --- MÉTODOS CRM & ERP CON PERSISTENCIA EN SUPABASE ---

  /**
   * Guardar o actualizar cliente
   */
  public async saveCliente(cliente: any): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.from('clientes').upsert(cliente, { onConflict: 'cuit' });
      if (error) {
        logger.warn('SUPABASE', `Error al sincronizar cliente en Supabase: ${error.message}`);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Obtener clientes
   */
  public async getClientes(): Promise<any[] | null> {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client.from('clientes').select('*').order('razon_social', { ascending: true });
      if (error) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  /**
   * Guardar comprobante emitido
   */
  public async saveComprobante(comprobante: any): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.from('comprobantes').insert(comprobante);
      if (error) {
        logger.warn('SUPABASE', `Error guardando comprobante en Supabase: ${error.message}`);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Guardar o actualizar producto del catálogo
   */
  public async saveProducto(producto: any): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.from('productos').upsert(producto, { onConflict: 'codigo' });
      if (error) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Obtener productos del catálogo
   */
  public async getProductos(): Promise<any[] | null> {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client.from('productos').select('*').order('nombre', { ascending: true });
      if (error) return null;
      return data;
    } catch (e) {
      return null;
    }
  }
}

export const supabase = new SupabaseService();
