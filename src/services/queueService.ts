import { db, InvoicingQueueItem } from '../database.js';
import { facturacionModule } from '../engine/modules/facturacion.js';
import { arcaSession } from '../engine/arcaSession.js';
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
  public async processQueue(): Promise<{ total: number; exitosos: number; fallidos: number }> {
    if (this.isProcessing) {
      logger.warn('COLA', 'La cola de facturación ya se encuentra en ejecución.');
      return { total: 0, exitosos: 0, fallidos: 0 };
    }

    this.isProcessing = true;
    const queue = db.getQueue().filter(q => q.estado === 'pendiente');
    let exitosos = 0;
    let fallidos = 0;

    logger.info('COLA', `Iniciando procesamiento de lote en ARCA: ${queue.length} pendientes...`);

    const creds = db.getCredentials();
    if (!creds.cuit || !creds.claveFiscal) {
      logger.error('COLA', 'No hay CUIT y Clave Fiscal configurados para procesar la cola.');
      this.isProcessing = false;
      return { total: queue.length, exitosos: 0, fallidos: queue.length };
    }

    try {
      // 1. Iniciar sesión única en ARCA con Playwright
      const session = await arcaSession.login(creds.cuit, creds.claveFiscal);
      if (!session.success) {
        logger.error('COLA', `Error de login en ARCA: ${session.message}`);
        for (const item of queue) {
          db.updateQueueItem(item.id, { estado: 'error', errorMensaje: `Fallo login ARCA: ${session.message}` });
        }
        this.isProcessing = false;
        return { total: queue.length, exitosos: 0, fallidos: queue.length };
      }

      // 2. Iterar sobre cada comprobante de la cola
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        logger.info('COLA', `[${i + 1}/${queue.length}] Procesando ${item.tipoComprobante} para ${item.razonSocial} (CUIT: ${item.docNro}) - $${item.importeTotal}...`);
        
        db.updateQueueItem(item.id, { estado: 'procesando' });

        try {
          const res = await facturacionModule.emitirFactura(session, {
            puntoVenta: item.puntoVenta,
            tipoComprobante: item.tipoComprobante as any,
            concepto: item.concepto as any,
            condicionVenta: item.condicionVenta as any,
            cuitEmisor: item.cuitEmisor || creds.cuit,
            razonSocialEmisor: item.razonSocialEmisor || creds.razonSocial,
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
          });

          if (res.success && res.cae) {
            exitosos++;
            db.updateQueueItem(item.id, {
              estado: 'emitida',
              cae: res.cae,
              caeVencimiento: res.caeVencimiento,
              comprobanteNro: res.comprobanteNro,
            });

            // Guardar en comprobantes
            await this.saveComprobanteEmitido(item, res);
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

  private async saveComprobanteEmitido(item: InvoicingQueueItem, res: any) {
    const record = {
      id: 'comp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      tipoOperacion: 'Emitido',
      tipoComprobante: item.tipoComprobante,
      puntoVenta: item.puntoVenta,
      numero: parseInt(res.comprobanteNro?.split('-')[1] || '1', 10),
      comprobanteFormato: res.comprobanteNro || '0001-00000001',
      fechaEmision: new Date().toISOString().split('T')[0],
      cuitEmisor: item.cuitEmisor,
      cuitReceptor: item.docNro,
      razonSocialReceptor: item.razonSocial,
      condicionIvaReceptor: item.condicionIva,
      importeTotal: item.importeTotal,
      cae: res.cae,
      caeVencimiento: res.caeVencimiento,
      estado: 'Autorizado',
      createdAt: new Date().toISOString(),
    };

    if (!db.data.comprobantes) db.data.comprobantes = [];
    db.data.comprobantes.unshift(record);
    db.save();

    // Sincronizar en Supabase comprobantes
    const supa = supabase.getClient();
    if (supa) {
      try {
        await supa.from('comprobantes').insert({
          id: record.id,
          tipo_operacion: record.tipoOperacion,
          tipo_comprobante: record.tipoComprobante,
          punto_venta: record.puntoVenta,
          numero: record.numero,
          comprobante_formato: record.comprobanteFormato,
          fecha_emision: record.fechaEmision,
          cuit_emisor: record.cuitEmisor,
          cuit_receptor: record.cuitReceptor,
          razon_social_receptor: record.razonSocialReceptor,
          condicion_iva_receptor: record.condicionIvaReceptor,
          importe_total: record.importeTotal,
          cae: record.cae,
          cae_vencimiento: record.caeVencimiento,
          estado: record.estado,
        });
      } catch (e) {}
    }
  }

  public getStatus() {
    const queue = db.getQueue();
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
