import { db, InvoicingQueueItem } from '../database.js';
import { facturacionModule } from '../engine/modules/facturacion.js';
import { arcaSession } from '../engine/arcaSession.js';
import { supabase } from './supabase.js';
import { logger } from './logger.js';

class QueueService {
  private isProcessing = false;

  /**
   * Parsea filas copiadas de Excel (separadas por tabulación \t) o CSV
   */
  public parseExcelOrCsv(rawText: string): Array<Omit<InvoicingQueueItem, 'id' | 'createdAt' | 'estado'>> {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const parsed: Array<Omit<InvoicingQueueItem, 'id' | 'createdAt' | 'estado'>> = [];

    const creds = db.getCredentials();
    const defaultPtoVta = creds.puntoVentaDefault || 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detectar separador (\t para Excel, ; o , para CSV)
      let cols: string[] = [];
      if (line.includes('\t')) {
        cols = line.split('\t').map(c => c.trim());
      } else if (line.includes(';')) {
        cols = line.split(';').map(c => c.trim());
      } else if (line.includes(',')) {
        cols = line.split(',').map(c => c.trim());
      } else {
        cols = [line];
      }

      // Si es encabezado (contiene palabras como cuit, receptor, monto, importe, etc.), saltar
      const lowerHeader = cols.join(' ').toLowerCase();
      if (i === 0 && (lowerHeader.includes('cuit') || lowerHeader.includes('importe') || lowerHeader.includes('razon') || lowerHeader.includes('monto'))) {
        continue;
      }

      // Mapeo flexible según cantidad de columnas
      // Formato típico 1: [CUIT, Razón Social, Descripción, Importe]
      // Formato típico 2: [PtoVta, Tipo, CUIT, Razón Social, Descripción, Importe]
      // Formato típico 3: [CUIT, Importe, Descripción]
      let ptoVta = defaultPtoVta;
      let tipoComp = 'Factura C';
      let docNro = '';
      let razonSocial = '';
      let descripcion = 'Servicios profesionales';
      let importe = 0;
      let email = '';

      if (cols.length >= 4 && cols[0].length <= 4 && !isNaN(Number(cols[0]))) {
        // [PtoVta, Tipo, CUIT, Razón, Desc, Importe]
        ptoVta = parseInt(cols[0], 10) || defaultPtoVta;
        tipoComp = cols[1] || 'Factura C';
        docNro = cols[2]?.replace(/\D/g, '') || '';
        razonSocial = cols[3] || 'Consumidor Final';
        descripcion = cols[4] || 'Servicios profesionales';
        importe = this.parseNumeric(cols[5] || cols[cols.length - 1]);
      } else if (cols.length >= 4) {
        // [CUIT, Razón Social, Descripción, Importe, (Email)]
        docNro = cols[0]?.replace(/\D/g, '') || '';
        razonSocial = cols[1] || 'Consumidor Final';
        descripcion = cols[2] || 'Servicios profesionales';
        importe = this.parseNumeric(cols[3]);
        if (cols[4]) email = cols[4];
      } else if (cols.length === 3) {
        // [CUIT, Descripción, Importe] o [CUIT, Razón, Importe]
        docNro = cols[0]?.replace(/\D/g, '') || '';
        if (isNaN(this.parseNumeric(cols[1])) && !isNaN(this.parseNumeric(cols[2]))) {
          razonSocial = cols[1];
          importe = this.parseNumeric(cols[2]);
        } else {
          descripcion = cols[1];
          importe = this.parseNumeric(cols[2]);
        }
      } else if (cols.length === 2) {
        // [CUIT, Importe]
        docNro = cols[0]?.replace(/\D/g, '') || '';
        importe = this.parseNumeric(cols[1]);
        razonSocial = `Cliente ${docNro}`;
      }

      if (docNro && importe > 0) {
        parsed.push({
          cuitEmisor: creds.cuit,
          puntoVenta: ptoVta,
          tipoComprobante: tipoComp,
          concepto: 2,
          docTipo: docNro.length === 11 ? 'CUIT' : (docNro.length === 8 ? 'DNI' : 'Consumidor Final'),
          docNro,
          razonSocial: razonSocial || `Receptor ${docNro}`,
          condicionIva: docNro.length === 11 ? 'Responsable Inscripto' : 'Consumidor Final',
          condicionVenta: 'Contado',
          descripcion: descripcion || 'Servicios profesionales',
          cantidad: 1,
          precioUnitario: importe,
          importeTotal: importe,
          email,
        });
      }
    }

    return parsed;
  }

  private parseNumeric(val: string): number {
    if (!val) return 0;
    const clean = val.replace(/\$/g, '').trim().replace(/\./g, '').replace(',', '.');
    return parseFloat(clean) || 0;
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
