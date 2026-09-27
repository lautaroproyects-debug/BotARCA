import axios from 'axios';
import { logger } from './logger.js';

export interface CotizacionDolar {
  casa: string;
  nombre: string;
  compra: number;
  venta: number;
  fechaActualizacion: string;
}

export interface IndiceEconomico {
  fecha: string;
  valor: number;
}

export interface ArgentinaDatosCache {
  dolares: CotizacionDolar[];
  inflacionMensual: IndiceEconomico[];
  inflacionInteranual: IndiceEconomico[];
  uva: IndiceEconomico[];
  tasasPlazoFijo: any[];
  lastUpdated: number;
}

const NOMBRE_CASAS: Record<string, string> = {
  oficial: 'Dólar Oficial',
  blue: 'Dólar Blue',
  bolsa: 'Dólar MEP (Bolsa)',
  contadoconliqui: 'Dólar CCL',
  tarjeta: 'Dólar Tarjeta',
  cripto: 'Dólar Cripto',
  mayorista: 'Dólar Mayorista',
};

class ArgentinaDatosService {
  private readonly BASE_URL = 'https://api.argentinadatos.com/v1';
  private cache: ArgentinaDatosCache = {
    dolares: [
      { casa: 'oficial', nombre: 'Dólar Oficial', compra: 1020, venta: 1060, fechaActualizacion: new Date().toISOString() },
      { casa: 'blue', nombre: 'Dólar Blue', compra: 1200, venta: 1220, fechaActualizacion: new Date().toISOString() },
      { casa: 'bolsa', nombre: 'Dólar MEP (Bolsa)', compra: 1180, venta: 1185, fechaActualizacion: new Date().toISOString() },
      { casa: 'contadoconliqui', nombre: 'Dólar CCL', compra: 1210, venta: 1215, fechaActualizacion: new Date().toISOString() },
    ],
    inflacionMensual: [],
    inflacionInteranual: [],
    uva: [],
    tasasPlazoFijo: [],
    lastUpdated: 0,
  };
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos de caché

  constructor() {
    this.refreshCache().catch(() => {});
  }

  /**
   * Refresca las cotizaciones e indicadores económicos desde ArgentinaDatos
   */
  public async refreshCache(force: boolean = false): Promise<ArgentinaDatosCache> {
    const now = Date.now();
    if (!force && this.cache.lastUpdated > 0 && (now - this.cache.lastUpdated < this.CACHE_TTL_MS)) {
      return this.cache;
    }

    try {
      logger.info('ARGENTINADATOS', 'Consultando cotizaciones e indicadores en ArgentinaDatos...');

      const [dolaresRes, inflacionRes, uvaRes, tasasRes] = await Promise.allSettled([
        axios.get(`${this.BASE_URL}/cotizaciones/dolares`, { timeout: 8000 }),
        axios.get(`${this.BASE_URL}/finanzas/indices/inflacion`, { timeout: 8000 }),
        axios.get(`${this.BASE_URL}/finanzas/indices/uva`, { timeout: 8000 }),
        axios.get(`${this.BASE_URL}/finanzas/tasas/plazoFijo`, { timeout: 8000 }),
      ]);

      if (dolaresRes.status === 'fulfilled' && Array.isArray(dolaresRes.value.data)) {
        // Extraer la última cotización para cada tipo de casa
        const latestByCasa = new Map<string, any>();
        for (const item of dolaresRes.value.data) {
          if (item && item.casa) {
            const current = latestByCasa.get(item.casa);
            if (!current || (item.fecha && item.fecha >= (current.fecha || ''))) {
              latestByCasa.set(item.casa, item);
            }
          }
        }

        const processed: CotizacionDolar[] = [];
        for (const [casaKey, item] of latestByCasa.entries()) {
          processed.push({
            casa: casaKey,
            nombre: NOMBRE_CASAS[casaKey] || item.nombre || `Dólar ${casaKey.toUpperCase()}`,
            compra: Number(item.compra) || 0,
            venta: Number(item.venta) || 0,
            fechaActualizacion: item.fecha || new Date().toISOString().split('T')[0],
          });
        }

        if (processed.length > 0) {
          this.cache.dolares = processed;
        }
      }

      if (inflacionRes.status === 'fulfilled' && Array.isArray(inflacionRes.value.data)) {
        this.cache.inflacionMensual = inflacionRes.value.data.slice(-12);
      }

      if (uvaRes.status === 'fulfilled' && Array.isArray(uvaRes.value.data)) {
        this.cache.uva = uvaRes.value.data.slice(-30);
      }

      if (tasasRes.status === 'fulfilled' && Array.isArray(tasasRes.value.data)) {
        this.cache.tasasPlazoFijo = tasasRes.value.data;
      }

      this.cache.lastUpdated = now;
      logger.success('ARGENTINADATOS', `Cotizaciones e indicadores actualizados con éxito.`);
      return this.cache;

    } catch (err: any) {
      logger.warn('ARGENTINADATOS', `Error al consultar ArgentinaDatos: ${err.message}. Utilizando caché.`);
      return this.cache;
    }
  }

  /**
   * Obtiene la cotización del Dólar por tipo (oficial, blue, bolsa/mep, contadoconliqui, cripto, tarjeta)
   */
  public async getDolar(casa: string = 'oficial'): Promise<CotizacionDolar | null> {
    const data = await this.refreshCache();
    const cleanCasa = (casa || 'oficial').toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = data.dolares.find(d => {
      const dCasa = (d.casa || '').toLowerCase();
      const dNom = (d.nombre || '').toLowerCase();
      return dCasa.includes(cleanCasa) || dNom.includes(cleanCasa);
    });
    return found || data.dolares[0] || null;
  }

  /**
   * Obtiene todas las cotizaciones de dólares
   */
  public async getAllDolares(): Promise<CotizacionDolar[]> {
    const data = await this.refreshCache();
    return data.dolares;
  }

  /**
   * Obtiene el último índice de inflación publicado
   */
  public async getUltimaInflacion(): Promise<{ fecha: string; valor: number } | null> {
    const data = await this.refreshCache();
    if (data.inflacionMensual.length > 0) {
      return data.inflacionMensual[data.inflacionMensual.length - 1];
    }
    return null;
  }

  /**
   * Obtiene el valor actual del UVA
   */
  public async getUltimoUva(): Promise<{ fecha: string; valor: number } | null> {
    const data = await this.refreshCache();
    if (data.uva.length > 0) {
      return data.uva[data.uva.length - 1];
    }
    return null;
  }

  /**
   * Conversión de moneda (USD a ARS o viceversa) según tipo de cambio
   */
  public async convertCurrency(amount: number, from: 'USD' | 'ARS', to: 'USD' | 'ARS', tipoDolar: string = 'oficial'): Promise<{ result: number; tipoCambio: number; casa: string }> {
    if (from === to) {
      return { result: amount, tipoCambio: 1, casa: 'Misma Moneda' };
    }

    const cotizacion = await this.getDolar(tipoDolar);
    const tasa = cotizacion && cotizacion.venta > 0 ? cotizacion.venta : 1060;
    const casaNombre = cotizacion ? cotizacion.nombre : 'Oficial (Estimado)';

    if (from === 'USD' && to === 'ARS') {
      return {
        result: Math.round(amount * tasa * 100) / 100,
        tipoCambio: tasa,
        casa: casaNombre,
      };
    } else {
      return {
        result: Math.round((amount / tasa) * 100) / 100,
        tipoCambio: tasa,
        casa: casaNombre,
      };
    }
  }
}

export const argentinaDatos = new ArgentinaDatosService();
