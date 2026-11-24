import { db, InvoicingQueueItem } from '../database.js';
import { arcaSession, ArcaSessionResult } from '../engine/arcaSession.js';
import { emitirComprobante, credencialesNavegador } from './emisionService.js';
import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { aiParserService } from './aiParserService.js';

class QueueService {
  private isProcessing = false;

  /**
   * Parsea de manera inteligente Excel, CSV o texto libre/WhatsApp (usando Groq o Heurística)
   */
  public async parseSmartText(rawText: string, options?: { forceAi?: boolean }) {
    return await aiParserService.parseSmart(rawText, options);
  }

  /**
   * Parsea filas copiadas de Excel (separadas por tabulación \t) o CSV
   */
  public parseExcelOrCsv(rawText: string): Array<Omit<InvoicingQueueItem, 'id' | 'createdAt' | 'estado'>> {
    return aiParserService.parseTabular(rawText);
  }

  /**
   * Agrega items a la cola local y sincroniza con Supabase
   */
  public async addBatch(items: Array<Omit<InvoicingQueueItem, 'id' | 'createdAt' | 'estado'>>): Promise<InvoicingQueueItem[]> {
    const created = db.addQueueItems(items);

    // Sincronizar en Supabase cola_facturacion
    const supa = supabase.getClient();
    if (supa) {
      try {
        const rowsToInsert = created.map(c => ({
          id: c.id,
          cuit_emisor: c.cuitEmisor,
          punto_venta: c.puntoVenta,
          tipo_comprobante: c.tipoComprobante,
          concepto: c.concepto,
          doc_tipo: c.docTipo,
          doc_nro: c.docNro,
          razon_social: c.razonSocial,
          condicion_iva: c.condicionIva,
          condicion_venta: c.condicionVenta,
          descripcion: c.descripcion,
          cantidad: c.cantidad,
          precio_unitario: c.precioUnitario,
          importe_total: c.importeTotal,
          email: c.email,
          estado: 'pendiente',
          created_at: c.createdAt,
        }));
        await supa.from('cola_facturacion').insert(rowsToInsert);
      } catch (e) {}
    }

    logger.info('COLA', `Agregados ${created.length} comprobantes a la cola de emisión.`);
    return created;
  }

  /**
   * Procesa en segundo plano todos los comprobantes pendientes de la cola
   */
  /** Procesa los pendientes. Con "cuits", solo los de esos CUITs (los del usuario que la pide). */
  public async processQueue(cuits?: string[]): Promise<{ total: number; exitosos: number; fallidos: number }> {
    if (this.isProcessing) {
      logger.warn('COLA', 'La cola de facturación ya se encuentra en ejecución.');
      return { total: 0, exitosos: 0, fallidos: 0 };
    }

    this.isProcessing = true;
    const queue = db.getQueue().filter(q => q.estado === 'pendiente' && (!cuits || cuits.includes(String(q.cuitEmisor || ''))));
    let exitosos = 0;
    let fallidos = 0;

    logger.info('COLA', `Iniciando procesamiento de lote en ARCA: ${queue.length} pendientes...`);

    // Cada comprobante de la cola lleva su propio CUIT emisor (el del usuario que lo cargó)

    // Solo las cuentas en modo navegador necesitan sesión con Clave Fiscal: se abre una por CUIT
    // y se reutiliza en todo el lote. Las cuentas por web service no la usan.
    const sesionesNavegador = new Map<string, Promise<ArcaSessionResult>>();
    const obtenerSesionNavegador = (acc: any, cuit: string): Promise<ArcaSessionResult> => {
      if (!sesionesNavegador.has(cuit)) {
        const cred = credencialesNavegador(acc, cuit);
        sesionesNavegador.set(cuit, cred
          ? arcaSession.login(cred.cuit, cred.claveFiscal)
          : Promise.resolve({ success: false, message: `La cuenta ${cuit} no tiene Clave Fiscal cargada.` }));
      }
      return sesionesNavegador.get(cuit)!;
    };

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        logger.info('COLA', `[${i + 1}/${queue.length}] Procesando ${item.tipoComprobante} para ${item.razonSocial} (CUIT: ${item.docNro}) - $${item.importeTotal}...`);
        
        db.updateQueueItem(item.id, { estado: 'procesando' });

        try {
          const res = await emitirComprobante({
            puntoVenta: item.puntoVenta,
            tipoComprobante: item.tipoComprobante as any,
            concepto: item.concepto as any,
            condicionVenta: item.condicionVenta as any,
            cuitEmisor: item.cuitEmisor,
            razonSocialEmisor: item.razonSocialEmisor,
            receptor: {
              tipoDoc: item.docTipo as any,
              nroDoc: item.docNro,
              razonSocial: item.razonSocial,
              condicionIva: item.condicionIva as any,
              email: item.email,
            },
            items: [{
              descripcion: item.descripcion,
              cantidad: item.cantidad,
              precioUnitario: item.precioUnitario,
              subtotal: item.importeTotal,
            }],
          }, { obtenerSesionNavegador });

          if (res.success) { // (en modo navegador puede no leerse el CAE en pantalla, pero el comprobante igual se emitió)
            exitosos++;
            db.updateQueueItem(item.id, {
              estado: 'emitida',
              cae: res.cae,
              caeVencimiento: res.caeVencimiento,
              comprobanteNro: res.comprobanteNro,
            });

            // Guardar en comprobantes
            // (el comprobante ya quedó guardado en el repositorio al emitir)
            logger.success('COLA', `[${i + 1}/${queue.length}] ¡Emitido con éxito! CAE: ${res.cae} - Comprobante: ${res.comprobanteNro}`);
          } else {
            fallidos++;
            db.updateQueueItem(item.id, {
              estado: 'error',
              errorMensaje: res.message || 'Error desconocido de emisión en ARCA',
            });
            logger.error('COLA', `[${i + 1}/${queue.length}] Error en comprobante: ${res.message}`);
          }
        } catch (err: any) {
          fallidos++;
          db.updateQueueItem(item.id, {
            estado: 'error',
            errorMensaje: err.message,
          });
          logger.error('COLA', `[${i + 1}/${queue.length}] Excepción: ${err.message}`);
        }

        // Breve pausa estocástica de descanso entre comprobantes consecutivos
        await new Promise(r => setTimeout(r, 1200));
      }
    } finally {
      this.isProcessing = false;
      logger.info('COLA', `Procesamiento de cola finalizado. Exitosos: ${exitosos}, Fallidos: ${fallidos}.`);
    }

    return { total: queue.length, exitosos, fallidos };
  }

  public getStatus(cuits?: string[]) {
    const queue = db.getQueue().filter(q => !cuits || cuits.includes(String(q.cuitEmisor || '')));
    return {
      isProcessing: this.isProcessing,
      total: queue.length,
      pendientes: queue.filter(q => q.estado === 'pendiente').length,
      procesando: queue.filter(q => q.estado === 'procesando').length,
      emitidas: queue.filter(q => q.estado === 'emitida').length,
      errores: queue.filter(q => q.estado === 'error').length,
      items: queue,
    };
  }
}

export const queueService = new QueueService();
