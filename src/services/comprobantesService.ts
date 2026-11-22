import crypto from 'crypto';
import { db, ComprobanteRecord } from '../database.js';
import { logger } from './logger.js';
import { mailService } from './mailService.js';
import { supabase } from './supabase.js';
import { FacturaRequest } from '../engine/modules/facturacion.js';
import { generarPdfComprobante, pesos } from '../engine/ws/pdfComprobante.js';
import { armarMailComprobante } from '../engine/ws/diseno.js';

/**
 * Repositorio de comprobantes emitidos: guarda cada emisión (factura individual o cola),
 * regenera el PDF con el diseño actual de la cuenta y lo envía por mail cuando se pide.
 */

/** dd/mm/aaaa o aaaammdd -> aaaa-mm-dd (formato DATE de Postgres) */
function aFechaIso(f?: string): string | null {
  if (!f) return null;
  let m = f.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = f.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(f) ? f.slice(0, 10) : null;
}

function a2(v: unknown) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

class ComprobantesService {
  public listar(): ComprobanteRecord[] {
    return db.data.comprobantes || [];
  }

  public obtener(id: string): ComprobanteRecord | undefined {
    return this.listar().find(c => c.id === id);
  }

  /** Registra un comprobante emitido. Se llama una sola vez por emisión exitosa. */
  public guardarEmitido(datos: FacturaRequest, r: any): ComprobanteRecord {
    const nroTexto = String(r.comprobanteNro || '');
    const record: ComprobanteRecord = {
      id: crypto.randomUUID(), // la tabla de Supabase usa UUID
      tipoOperacion: 'Emitido',
      tipoComprobante: r.tipoComprobante || datos.tipoComprobante,
      puntoVenta: Number(r.puntoVenta || datos.puntoVenta),
      numero: parseInt(nroTexto.split('-')[1] || '0', 10) || 0,
      comprobanteFormato: nroTexto,
      fechaEmision: r.fechaEmision || new Date().toISOString().slice(0, 10),
      cuitEmisor: datos.cuitEmisor,
      razonSocialEmisor: datos.razonSocialEmisor,
      cuitReceptor: datos.receptor.nroDoc || '',
      razonSocialReceptor: datos.receptor.razonSocial || 'Consumidor Final',
      condicionIvaReceptor: datos.receptor.condicionIva,
      importeTotal: a2(r.totalImporte),
      cae: r.cae,
      caeVencimiento: r.caeVencimiento,
      estado: r.ambiente === 'homologacion' ? 'Prueba (homologación)' : 'Autorizado',
      createdAt: new Date().toISOString(),
      detalle: r.datosPdf,
      emailReceptor: datos.receptor.email || undefined,
      ambiente: r.ambiente,
      via: r.via,
      envios: [],
    };
    if (!db.data.comprobantes) db.data.comprobantes = [];
    db.data.comprobantes.unshift(record);
    db.save();
    this.subirASupabase(record).catch(() => {});
    return record;
  }

  private async subirASupabase(record: ComprobanteRecord) {
    const supa = supabase.getClient();
    if (!supa) return;
    const fila: any = {
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
      cae_vencimiento: aFechaIso(record.caeVencimiento),
      razon_social_emisor: record.razonSocialEmisor || null,
      estado: record.estado,
    };
    // La columna "detalle" (JSONB) permite regenerar el PDF después de un reinicio. Si la tabla
    // todavía no la tiene, se guarda igual sin ella.
    const { error } = await supa.from('comprobantes').insert({ ...fila, detalle: record.detalle || null, email_receptor: record.emailReceptor || null });
    if (error) {
      await supa.from('comprobantes').insert(fila);
      logger.warn('COMPROBANTES', 'Supabase: falta la columna "detalle" en "comprobantes" (ver supabase/schema.sql). El PDF no se podrá regenerar tras un reinicio.');
    }
  }

  /** Al arrancar: recupera el repositorio desde Supabase (en Render el disco local se borra). */
  public async restaurarDesdeSupabase() {
    const supa = supabase.getClient();
    if (!supa) return;
    const { data, error } = await supa.from('comprobantes').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error || !Array.isArray(data)) return;
    if (!db.data.comprobantes) db.data.comprobantes = [];
    const existentes = new Set(db.data.comprobantes.map(c => c.id));
    const fecha = (v: any) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v || undefined);
    let agregados = 0;
    for (const r of data as any[]) {
      if (existentes.has(r.id)) continue;
      db.data.comprobantes.push({
        id: r.id,
        tipoOperacion: r.tipo_operacion || 'Emitido',
        tipoComprobante: r.tipo_comprobante,
        puntoVenta: r.punto_venta,
        numero: r.numero,
        comprobanteFormato: r.comprobante_formato,
        fechaEmision: r.fecha_emision,
        cuitEmisor: r.cuit_emisor,
        razonSocialEmisor: r.razon_social_emisor || undefined,
        cuitReceptor: r.cuit_receptor,
        razonSocialReceptor: r.razon_social_receptor,
        condicionIvaReceptor: r.condicion_iva_receptor,
        importeTotal: Number(r.importe_total) || 0,
        cae: r.cae || undefined,
        caeVencimiento: fecha(r.cae_vencimiento),
        estado: r.estado,
        createdAt: r.created_at,
        detalle: r.detalle || undefined,
        emailReceptor: r.email_receptor || undefined,
        envios: [],
      });
      agregados++;
    }
    db.data.comprobantes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (agregados) { db.save(); logger.info('COMPROBANTES', `Recuperados ${agregados} comprobantes desde Supabase.`); }
  }

  public async pdf(id: string): Promise<{ ok: true; buffer: Buffer; nombre: string } | { ok: false; mensaje: string }> {
    const c = this.obtener(id);
    if (!c) return { ok: false, mensaje: 'Comprobante no encontrado.' };
    if (!c.detalle) {
      return { ok: false, mensaje: 'Este comprobante se emitió por "Comprobantes en línea" (navegador): su PDF está en ARCA.' };
    }
    const acc = c.cuitEmisor ? db.getAccountRecord(c.cuitEmisor) : undefined;
    const buffer = await generarPdfComprobante(c.detalle, acc?.diseno);
    return { ok: true, buffer, nombre: `${c.tipoComprobante} ${c.comprobanteFormato}.pdf`.replace(/[\\/:*?"<>|]/g, '-') };
  }

  /** Envía el comprobante por mail (al email indicado o al del receptor). Registra el intento. */
  public async enviarPorMail(id: string, emailDestino?: string): Promise<{ success: boolean; message: string; simulado?: boolean }> {
    const c = this.obtener(id);
    if (!c) return { success: false, message: 'Comprobante no encontrado.' };
    const email = String(emailDestino || c.emailReceptor || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, message: 'Falta un email válido para enviar el comprobante.' };

    const pdf = await this.pdf(id);
    if (!pdf.ok) return { success: false, message: pdf.mensaje };

    const acc = c.cuitEmisor ? db.getAccountRecord(c.cuitEmisor) : undefined;
    const vars = {
      cliente: c.razonSocialReceptor || 'cliente',
      tipo: c.tipoComprobante,
      numero: c.comprobanteFormato,
      total: pesos(c.importeTotal),
      cae: c.cae || '-',
      vencimientoCae: c.caeVencimiento || '-',
      fecha: c.fechaEmision,
      emisor: acc?.diseno?.nombreFantasia || c.razonSocialEmisor || acc?.razonSocial || '',
    };
    const mail = armarMailComprobante(acc?.diseno, vars);
    const prueba = c.ambiente === 'homologacion';
    const r = await mailService.sendMail({
      to: email,
      subject: prueba ? `[PRUEBA SIN VALIDEZ] ${mail.asunto}` : mail.asunto,
      html: mail.html,
      replyTo: mail.responderA || acc?.emailNotificaciones,
      attachments: [{ filename: pdf.nombre, content: pdf.buffer.toString('base64'), contentType: 'application/pdf' }],
    }).catch((e: any) => ({ success: false, message: e.message, simulado: false }));

    const ok = r.success && !(r as any).simulado;
    if (!c.envios) c.envios = [];
    c.envios.unshift({ fecha: new Date().toISOString(), email, ok, mensaje: r.message });
    if (!c.emailReceptor) c.emailReceptor = email;
    db.save();
    logger[ok ? 'success' : 'warn']('COMPROBANTES', `${c.comprobanteFormato} → ${email}: ${ok ? 'enviado' : r.message}`);
    return {
      success: ok,
      simulado: (r as any).simulado,
      message: ok ? `Comprobante enviado a ${email}.` : r.message || 'No se pudo enviar el mail.',
    };
  }
}

export const comprobantesService = new ComprobantesService();
