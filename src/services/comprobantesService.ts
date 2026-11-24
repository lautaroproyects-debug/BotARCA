import crypto from 'crypto';
import { db, ComprobanteRecord } from '../database.js';
import { logger } from './logger.js';
import { mailService } from './mailService.js';
import { supabase } from './supabase.js';
import { FacturaRequest } from '../engine/modules/facturacion.js';
import { generarPdfComprobante, pesos } from '../engine/ws/pdfComprobante.js';
import { armarMailComprobante } from '../engine/ws/diseno.js';
import { crearZip } from './zip.js';

/**
 * Repositorio de comprobantes emitidos: guarda cada emisión (factura individual o cola) en el
 * archivo local y en Supabase (tabla "comprobantes"), con todo lo necesario para rearmar el PDF
 * tal como salió (el diseño se congela al emitir). Cada usuario ve los de sus CUITs, mes a mes.
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

/** "2026-11" -> { desde: "2026-11-01", hasta: "2026-12-01" } */
export function rangoMes(mes: string): { desde: string; hasta: string } | null {
  const m = String(mes || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const anio = Number(m[1]), nro = Number(m[2]);
  if (nro < 1 || nro > 12 || anio < 2000 || anio > 2100) return null;
  const sig = nro === 12 ? `${anio + 1}-01` : `${anio}-${String(nro + 1).padStart(2, '0')}`;
  return { desde: `${mes}-01`, hasta: `${sig}-01` };
}

const fechaDdmm = (v: any) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v || undefined);

/** Lo mínimo del pedido para volver a emitir o anular (sin datos del emisor ni claves). */
function pedidoGuardable(d: FacturaRequest) {
  return {
    puntoVenta: d.puntoVenta,
    tipoComprobante: d.tipoComprobante,
    concepto: d.concepto,
    condicionVenta: d.condicionVenta,
    periodoDesde: d.periodoDesde,
    periodoHasta: d.periodoHasta,
    receptor: {
      tipoDoc: d.receptor?.tipoDoc, nroDoc: d.receptor?.nroDoc, razonSocial: d.receptor?.razonSocial,
      condicionIva: d.receptor?.condicionIva, domicilio: d.receptor?.domicilio, email: d.receptor?.email,
    },
    items: (d.items || []).map(it => ({
      codigo: it.codigo, descripcion: it.descripcion, cantidad: it.cantidad, unidadMedida: it.unidadMedida,
      precioUnitario: it.precioUnitario, bonificacionPorcentaje: it.bonificacionPorcentaje, alicuotaIva: it.alicuotaIva, subtotal: it.subtotal,
    })),
  };
}

function desdeFila(r: any): ComprobanteRecord {
  return {
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
    caeVencimiento: fechaDdmm(r.cae_vencimiento),
    estado: r.estado,
    createdAt: r.created_at,
    detalle: r.detalle || undefined,
    emailReceptor: r.email_receptor || undefined,
    usuarioId: r.usuario_id || undefined,
    anuladoPor: r.anulado_por || undefined,
    asociadoId: r.asociado_id || undefined,
    ambiente: r.ambiente || (String(r.estado || '').startsWith('Prueba') ? 'homologacion' : undefined),
    envios: [],
  };
}

class ComprobantesService {
  /** Comprobantes traídos de Supabase que no están en memoria (meses viejos) */
  private cache = new Map<string, ComprobanteRecord>();

  public listar(): ComprobanteRecord[] {
    return db.data.comprobantes || [];
  }

  public obtener(id: string): ComprobanteRecord | undefined {
    return this.listar().find(c => c.id === id) || this.cache.get(id);
  }

  /** Busca en memoria y, si no está (comprobante de un mes viejo), en Supabase. */
  public async obtenerAsync(id: string): Promise<ComprobanteRecord | undefined> {
    const local = this.obtener(id);
    if (local) return local;
    const supa = supabase.getClient();
    if (!supa || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { data } = await supa.from('comprobantes').select('*').eq('id', id).maybeSingle();
    if (!data) return undefined;
    const rec = desdeFila(data);
    this.recordar(rec);
    return rec;
  }

  private recordar(rec: ComprobanteRecord) {
    this.cache.set(rec.id, rec);
    if (this.cache.size > 20000) this.cache.delete(this.cache.keys().next().value as string);
  }

  /**
   * Comprobantes de un mes ("aaaa-mm") de los CUITs indicados, del más nuevo al más viejo.
   * Lee de Supabase (sin tope de cantidad en memoria) y suma lo local que todavía no subió.
   */
  public async listarMes(cuits: string[], mes: string): Promise<ComprobanteRecord[]> {
    const rango = rangoMes(mes);
    if (!rango) return [];
    return this.listarRango(cuits, rango);
  }

  /** Comprobantes entre dos fechas (desde inclusive, hasta exclusive, aaaa-mm-dd). */
  public async listarRango(cuits: string[], rango: { desde: string; hasta: string }): Promise<ComprobanteRecord[]> {
    if (!cuits.length) return [];
    const enMes = (c: ComprobanteRecord) => {
      const f = aFechaIso(c.fechaEmision) || '';
      return f >= rango.desde && f < rango.hasta && cuits.includes(String(c.cuitEmisor || ''));
    };
    const porId = new Map<string, ComprobanteRecord>();
    const supa = supabase.getClient();
    if (supa) {
      for (let i = 0; i < cuits.length; i += 100) {
        const { data, error } = await supa.from('comprobantes').select('*')
          .in('cuit_emisor', cuits.slice(i, i + 100))
          .gte('fecha_emision', rango.desde).lt('fecha_emision', rango.hasta)
          .order('fecha_emision', { ascending: false }).limit(20000);
        if (error || !Array.isArray(data)) break;
        for (const fila of data) {
          const rec = desdeFila(fila);
          porId.set(rec.id, rec);
          if (!this.listar().some(c => c.id === rec.id)) this.recordar(rec);
        }
      }
    }
    // Lo local gana: tiene el historial de envíos por mail
    for (const c of this.listar()) if (enMes(c)) porId.set(c.id, c);
    // Marca de anulado aunque la columna todavía no exista en Supabase
    for (const c of porId.values()) {
      if (c.asociadoId && porId.has(c.asociadoId) && !porId.get(c.asociadoId)!.anuladoPor) porId.get(c.asociadoId)!.anuladoPor = c.id;
    }
    return [...porId.values()].sort((a, b) =>
      String(aFechaIso(b.fechaEmision)).localeCompare(String(aFechaIso(a.fechaEmision))) ||
      String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Marca un comprobante como anulado por una nota de crédito (local y en Supabase). */
  public async marcarAnulado(id: string, notaCreditoId: string) {
    const c = await this.obtenerAsync(id);
    if (c) c.anuladoPor = notaCreditoId;
    db.save();
    const supa = supabase.getClient();
    if (supa) {
      const { error } = await supa.from('comprobantes').update({ anulado_por: notaCreditoId }).eq('id', id);
      if (error) logger.warn('COMPROBANTES', 'Supabase: falta la columna "anulado_por" en "comprobantes" (ver supabase/schema.sql).');
    }
  }

  /** ¿Hay una nota de crédito que ya anula este comprobante? (busca también en Supabase) */
  public async notaQueAnula(id: string): Promise<string | undefined> {
    const local = this.listar().find(c => c.asociadoId === id);
    if (local) return local.id;
    const supa = supabase.getClient();
    if (!supa) return undefined;
    const { data } = await supa.from('comprobantes').select('id').eq('asociado_id', id).limit(1);
    return Array.isArray(data) && data[0]?.id ? data[0].id : undefined;
  }

  /**
   * Arma el pedido de emisión del comprobante (para refacturarlo o anularlo).
   * Usa el pedido guardado al emitir; en los comprobantes viejos lo reconstruye del detalle
   * (solo letra C, donde el precio es el final y no hay IVA discriminado).
   */
  public pedidoDe(c: ComprobanteRecord): { ok: true; pedido: FacturaRequest } | { ok: false; mensaje: string } {
    const d = c.detalle;
    if (!d) return { ok: false, mensaje: 'Este comprobante se emitió por "Comprobantes en línea": no tiene el detalle guardado. Hacelo desde ARCA.' };
    if (d.pedido) return { ok: true, pedido: { ...d.pedido, cuitEmisor: c.cuitEmisor } };
    if (d.letra !== 'C') return { ok: false, mensaje: 'Este comprobante es anterior a esta función y no tiene el detalle completo de IVA. Hacelo desde la pantalla Facturar.' };
    const tipoDoc = /cuit/i.test(d.receptor?.docTipoNombre || '') ? 'CUIT' : /dni/i.test(d.receptor?.docTipoNombre || '') ? 'DNI' : 'Consumidor Final';
    return {
      ok: true,
      pedido: {
        puntoVenta: Number(d.ptoVta) || c.puntoVenta,
        tipoComprobante: c.tipoComprobante as any,
        concepto: d.periodo ? 2 : 1,
        condicionVenta: d.condicionVenta || 'Contado',
        cuitEmisor: c.cuitEmisor,
        receptor: {
          tipoDoc: tipoDoc as any,
          nroDoc: d.receptor?.docNro || '',
          razonSocial: d.receptor?.nombre || c.razonSocialReceptor,
          condicionIva: c.condicionIvaReceptor || d.receptor?.condicionIva || 'Consumidor Final',
          domicilio: d.receptor?.domicilio,
          email: c.emailReceptor,
        },
        periodoDesde: d.periodo?.desde,
        periodoHasta: d.periodo?.hasta,
        items: (d.items || []).map((it: any) => ({
          descripcion: it.descripcion, cantidad: Number(it.cantidad) || 1, precioUnitario: Number(it.precioUnitario) || 0,
          unidadMedida: it.unidad, subtotal: Number(it.subtotal) || 0,
        })),
      } as FacturaRequest,
    };
  }

  /** Planilla del mes (CSV con ";" y BOM, se abre directo en Excel en español). */
  public planilla(lista: ComprobanteRecord[]): Buffer {
    const num = (v: unknown) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',');
    const txt = (v: unknown) => {
      const t = String(v ?? '').replace(/[\r\n]+/g, ' ');
      // Evita que Excel interprete una celda como fórmula
      const seguro = /^[=+\-@]/.test(t) ? "'" + t : t;
      return /[";]/.test(seguro) ? '"' + seguro.replace(/"/g, '""') + '"' : seguro;
    };
    const filas = [[
      'Fecha', 'Tipo', 'Número', 'CUIT emisor', 'Emisor', 'Documento receptor', 'Receptor', 'Condición IVA receptor',
      'Neto', 'IVA', 'Total', 'CAE', 'Vencimiento CAE', 'Estado', 'Email',
    ].join(';')];
    for (const c of lista) {
      const tot = c.detalle?.totales;
      const iva = Array.isArray(tot?.iva) ? tot.iva.reduce((s: number, x: any) => s + (Number(x.importe) || 0), 0) : 0;
      filas.push([
        txt(fechaDdmm(aFechaIso(c.fechaEmision)) || c.fechaEmision), txt(c.tipoComprobante), txt(c.comprobanteFormato),
        txt(c.cuitEmisor), txt(c.razonSocialEmisor), txt(c.cuitReceptor), txt(c.razonSocialReceptor), txt(c.condicionIvaReceptor),
        tot ? num(tot.neto) : '', tot ? num(iva) : '', num(c.importeTotal), txt(c.cae), txt(c.caeVencimiento), txt(c.estado), txt(c.emailReceptor),
      ].join(';'));
    }
    return Buffer.from('\uFEFF' + filas.join('\r\n') + '\r\n', 'utf8');
  }

  /** ZIP con el PDF de cada comprobante del mes y la planilla. */
  public async zipDelMes(lista: ComprobanteRecord[], mes: string): Promise<{ buffer: Buffer; incluidos: number; sinPdf: number }> {
    const archivos: Array<{ nombre: string; datos: Buffer }> = [{ nombre: `resumen-${mes}.csv`, datos: this.planilla(lista) }];
    const usados = new Set<string>();
    let sinPdf = 0;
    for (const c of lista) {
      const r = await this.pdfDe(c);
      if (!r.ok) { sinPdf++; continue; }
      const carpeta = String(c.cuitEmisor || 'sin-cuit');
      let nombre = `${carpeta}/${r.nombre}`;
      for (let n = 2; usados.has(nombre); n++) nombre = `${carpeta}/${r.nombre.replace(/\.pdf$/, '')} (${n}).pdf`;
      usados.add(nombre);
      archivos.push({ nombre, datos: r.buffer });
      // Deja respirar al servidor entre PDF y PDF
      await new Promise(res => setImmediate(res));
    }
    return { buffer: crearZip(archivos), incluidos: archivos.length - 1, sinPdf };
  }

  /** Registra un comprobante emitido. Se llama una sola vez por emisión exitosa. */
  public guardarEmitido(datos: FacturaRequest, r: any, usuarioId?: string): ComprobanteRecord {
    const nroTexto = String(r.comprobanteNro || '');
    // El diseño queda congelado con el comprobante: si después se cambia, este PDF sale igual
    const accEmisor = datos.cuitEmisor ? db.getAccountRecord(datos.cuitEmisor) : undefined;
    // También se guarda el pedido original: permite refacturar o anular con nota de crédito
    const detalle = r.datosPdf ? { ...r.datosPdf, diseno: accEmisor?.diseno || null, pedido: pedidoGuardable(datos) } : undefined;
    const record: ComprobanteRecord = {
      id: crypto.randomUUID(), // la tabla de Supabase usa UUID
      tipoOperacion: 'Emitido',
      tipoComprobante: r.tipoComprobante || datos.tipoComprobante,
      puntoVenta: Number(r.puntoVenta || datos.puntoVenta),
      numero: parseInt(nroTexto.split('-')[1] || '0', 10) || 0,
      comprobanteFormato: nroTexto,
      fechaEmision: aFechaIso(r.fechaEmision || datos.fechaEmision) || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
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
      detalle,
      emailReceptor: datos.receptor.email || undefined,
      ambiente: r.ambiente,
      via: r.via,
      usuarioId,
      asociadoId: datos.comprobanteAsociado?.id,
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
    // Se prueba con todas las columnas y, si la tabla es vieja, con menos (ver supabase/schema.sql)
    const completo = { ...fila, detalle: record.detalle || null, email_receptor: record.emailReceptor || null, usuario_id: record.usuarioId || null, ambiente: record.ambiente || null, asociado_id: record.asociadoId || null };
    const intentos = [completo, { ...fila, detalle: record.detalle || null, email_receptor: record.emailReceptor || null }, fila];
    for (let i = 0; i < intentos.length; i++) {
      const { error } = await supa.from('comprobantes').insert(intentos[i]);
      if (!error) {
        if (i > 0) logger.warn('COMPROBANTES', 'Supabase: a la tabla "comprobantes" le faltan columnas (ver supabase/schema.sql).');
        return;
      }
    }
    logger.error('COMPROBANTES', `No se pudo guardar ${record.comprobanteFormato} en Supabase: queda solo en el servidor.`);
  }

  /** Al arrancar: recupera el repositorio desde Supabase (en Render el disco local se borra). */
  public async restaurarDesdeSupabase() {
    const supa = supabase.getClient();
    if (!supa) return;
    const { data, error } = await supa.from('comprobantes').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error || !Array.isArray(data)) return;
    if (!db.data.comprobantes) db.data.comprobantes = [];
    const existentes = new Set(db.data.comprobantes.map(c => c.id));
    let agregados = 0;
    for (const r of data as any[]) {
      if (existentes.has(r.id)) continue;
      db.data.comprobantes.push(desdeFila(r));
      agregados++;
    }
    db.data.comprobantes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (agregados) { db.save(); logger.info('COMPROBANTES', `Recuperados ${agregados} comprobantes desde Supabase.`); }
  }

  public async pdf(id: string): Promise<{ ok: true; buffer: Buffer; nombre: string } | { ok: false; mensaje: string }> {
    const c = await this.obtenerAsync(id);
    if (!c) return { ok: false, mensaje: 'Comprobante no encontrado.' };
    return this.pdfDe(c);
  }

  private async pdfDe(c: ComprobanteRecord): Promise<{ ok: true; buffer: Buffer; nombre: string } | { ok: false; mensaje: string }> {
    if (!c.detalle) {
      return { ok: false, mensaje: 'Este comprobante se emitió por "Comprobantes en línea" (navegador): su PDF está en ARCA.' };
    }
    // Diseño congelado al emitir; los comprobantes viejos (sin diseño guardado) usan el actual
    const { diseno, ...datosPdf } = c.detalle;
    const acc = c.cuitEmisor ? db.getAccountRecord(c.cuitEmisor) : undefined;
    let buffer: Buffer;
    try {
      buffer = await generarPdfComprobante(datosPdf, diseno || acc?.diseno);
    } catch (err: any) {
      logger.error('COMPROBANTES', `No se pudo armar el PDF de ${c.comprobanteFormato}: ${err.message}`);
      return { ok: false, mensaje: 'No se pudo armar el PDF de este comprobante (faltan datos). Sigue siendo válido en ARCA.' };
    }
    return { ok: true, buffer, nombre: `${c.tipoComprobante} ${c.comprobanteFormato}.pdf`.replace(/[\\/:*?"<>|]/g, '-') };
  }

  /** Envía el comprobante por mail (al email indicado o al del receptor). Registra el intento. */
  public async enviarPorMail(id: string, emailDestino?: string): Promise<{ success: boolean; message: string; simulado?: boolean }> {
    const c = await this.obtenerAsync(id);
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
    const mail = armarMailComprobante(c.detalle?.diseno || acc?.diseno, vars);
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
