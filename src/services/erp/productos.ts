import { supabase } from '../supabase.js';
import { argentinaDatos } from '../argentinaDatos.js';
import { logger } from '../logger.js';

export interface ProductoRecord {
  id: string;
  codigo: string;
  nombre: string;
  descripcion?: string;
  categoria: string;
  unidadMedida: string;
  precioArs: number;
  precioUsd: number;
  autoAjusteDolar: boolean;
  alicuotaIva: number;
  activo: boolean;
  createdAt: string;
}

class ProductosService {
  private localProductos: ProductoRecord[] = [
    {
      id: 'prod_1',
      codigo: 'SRV-DEV-01',
      nombre: 'Desarrollo de Software y Automatización',
      descripcion: 'Horas o abono de desarrollo de software a medida',
      categoria: 'Servicios',
      unidadMedida: 'unidades',
      precioArs: 180000.00,
      precioUsd: 150.00,
      autoAjusteDolar: true,
      alicuotaIva: 21.00,
      activo: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'prod_2',
      codigo: 'SRV-CONS-02',
      nombre: 'Consultoría Técnica y Arquitectura Cloud',
      descripcion: 'Asesoría especializada en infraestructura y microservicios',
      categoria: 'Servicios',
      unidadMedida: 'horas',
      precioArs: 65000.00,
      precioUsd: 55.00,
      autoAjusteDolar: true,
      alicuotaIva: 21.00,
      activo: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'prod_3',
      codigo: 'LIC-BOT-03',
      nombre: 'Licencia Mensual BotArca Pro',
      descripcion: 'Suscripción mensual de automatización headless de comprobantes',
      categoria: 'Licencias',
      unidadMedida: 'unidades',
      precioArs: 95000.00,
      precioUsd: 80.00,
      autoAjusteDolar: true,
      alicuotaIva: 21.00,
      activo: true,
      createdAt: new Date().toISOString(),
    }
  ];

  constructor() {
    this.syncFromSupabase().catch(() => {});
  }

  private async syncFromSupabase() {
    const supaData = await supabase.getProductos();
    if (supaData && supaData.length > 0) {
      this.localProductos = supaData.map(p => ({
        id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        descripcion: p.descripcion,
        categoria: p.categoria || 'General',
        unidadMedida: p.unidad_medida || 'unidades',
        precioArs: parseFloat(p.precio_ars || '0'),
        precioUsd: parseFloat(p.precio_usd || '0'),
        autoAjusteDolar: p.auto_ajuste_dolar ?? true,
        alicuotaIva: parseFloat(p.alicuota_iva || '21'),
        activo: p.activo ?? true,
        createdAt: p.created_at,
      }));
    }
  }

  /**
   * Obtiene todos los productos con precios en ARS calculados en vivo si tienen autoAjusteDolar
   */
  public async getAll(): Promise<ProductoRecord[]> {
    const cotizacionOficial = await argentinaDatos.getDolar('oficial');
    const valorDolar = cotizacionOficial ? cotizacionOficial.venta : 1150;

    return this.localProductos.map(p => {
      let precioCalculado = p.precioArs;
      if (p.autoAjusteDolar && p.precioUsd > 0) {
        precioCalculado = Math.round(p.precioUsd * valorDolar * 100) / 100;
      }
      return {
        ...p,
        precioArs: precioCalculado,
      };
    });
  }

  public async getByCodigo(codigo: string): Promise<ProductoRecord | null> {
    const items = await this.getAll();
    return items.find(p => p.codigo.toLowerCase() === codigo.toLowerCase()) || null;
  }

  public async save(producto: Omit<ProductoRecord, 'id' | 'createdAt'> & { id?: string }): Promise<ProductoRecord> {
    let existing = this.localProductos.find(p => p.codigo === producto.codigo);

    if (existing) {
      existing = { ...existing, ...producto };
      const idx = this.localProductos.findIndex(p => p.id === existing!.id);
      this.localProductos[idx] = existing;
    } else {
      existing = {
        id: 'prod_' + Date.now(),
        ...producto,
        createdAt: new Date().toISOString(),
      };
      this.localProductos.unshift(existing);
    }

    supabase.saveProducto({
      codigo: existing.codigo,
      nombre: existing.nombre,
      descripcion: existing.descripcion,
      categoria: existing.categoria,
      unidad_medida: existing.unidadMedida,
      precio_ars: existing.precioArs,
      precio_usd: existing.precioUsd,
      auto_ajuste_dolar: existing.autoAjusteDolar,
      alicuota_iva: existing.alicuotaIva,
      activo: existing.activo,
    }).catch(() => {});

    logger.info('CATALOGO', `Producto guardado: ${existing.nombre} (${existing.codigo})`);
    return existing;
  }

  public async delete(id: string): Promise<boolean> {
    const idx = this.localProductos.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.localProductos.splice(idx, 1);
      return true;
    }
    return false;
  }
}

export const productosService = new ProductosService();
