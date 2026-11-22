import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { DisenoComprobante, disenoEfectivo, validarImagen } from './diseno.js';

/**
 * PDF del comprobante emitido por web service. ARCA no lo genera por WS: lo arma el sistema,
 * con el código QR obligatorio (RG 4892) que apunta a la verificación de ARCA.
 *
 * El diseño (colores, logo, esquema, tipografía, leyendas) es configurable por cuenta, pero los
 * datos obligatorios se dibujan siempre.
 */

export interface DatosPdf {
  ambiente: 'homologacion' | 'produccion';
  letra: 'A' | 'B' | 'C' | string;
  codigoTipo: number;
  nombreTipo: string;
  ptoVta: number;
  numero: number;
  fecha: string; // dd/mm/aaaa
  emisor: {
    razonSocial: string;
    cuit: string;
    condicionIva?: string;
    domicilio?: string;
    iibb?: string;
    inicioActividades?: string;
  };
  receptor: {
    docTipoNombre: string;
    docNro: string;
    nombre: string;
    condicionIva: string;
    domicilio?: string;
  };
  condicionVenta: string;
  periodo?: { desde: string; hasta: string; vtoPago: string };
  items: Array<{ descripcion: string; cantidad: number; unidad: string; precioUnitario: number; subtotal: number; alicuota?: string }>;
  totales: { neto: number; iva: Array<{ etiqueta: string; importe: number }>; exento: number; noGravado: number; total: number };
  discriminaIva: boolean;
  cae: string;
  caeVencimiento: string; // dd/mm/aaaa
  qr: { tipoDocRec: number; nroDocRec: string; fechaIso: string };
}

export const pesos = (v: number) => '$ ' + Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cuitFmt = (c: string) => (c && c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);

const FUENTES = {
  helvetica: { normal: 'Helvetica', negrita: 'Helvetica-Bold' },
  times: { normal: 'Times-Roman', negrita: 'Times-Bold' },
  courier: { normal: 'Courier', negrita: 'Courier-Bold' },
};

export function urlQrArca(d: DatosPdf): string {
  const payload = {
    ver: 1,
    fecha: d.qr.fechaIso,
    cuit: Number(d.emisor.cuit),
    ptoVta: d.ptoVta,
    tipoCmp: d.codigoTipo,
    nroCmp: d.numero,
    importe: Math.round(d.totales.total * 100) / 100,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: d.qr.tipoDocRec,
    nroDocRec: Number(d.qr.nroDocRec || 0),
    tipoCodAut: 'E',
    codAut: Number(d.cae),
  };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(payload)).toString('base64');
}

function aclarar(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * factor).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

export async function generarPdfComprobante(d: DatosPdf, disenoEntrada?: DisenoComprobante): Promise<Buffer> {
  const ds = disenoEfectivo(disenoEntrada);
  const F = FUENTES[ds.tipografia] || FUENTES.helvetica;
  const tinta = '#17181a';
  const gris = '#6b6d71';
  const linea = ds.esquema === 'minimal' ? '#d9d6cf' : ds.colorPrincipal;
  const qrPng = await QRCode.toBuffer(urlQrArca(d), { margin: 1, width: 220 });
  // Si el logo guardado no se puede leer, se omite (un PNG dañado haría caer el servidor)
  let logo: Buffer | null = null;
  if (ds.logoDataUrl) {
    try {
      const b = Buffer.from(ds.logoDataUrl.split(',')[1], 'base64');
      validarImagen(b, ds.logoDataUrl.startsWith('data:image/png') ? 'png' : 'jpg');
      logo = b;
    } catch { logo = null; }
  }

  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `${d.nombreTipo} ${String(d.ptoVta).padStart(5, '0')}-${String(d.numero).padStart(8, '0')}`, Author: d.emisor.razonSocial } });
  const partes: Buffer[] = [];
  doc.on('data', (c: Buffer) => partes.push(c));
  const fin = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(partes))));

  const W = doc.page.width - 72;
  const x0 = 36;
  let y = 36;
  const caja = (x: number, yy: number, w: number, h: number) => {
    if (ds.esquema === 'minimal') doc.moveTo(x, yy + h).lineTo(x + w, yy + h).lineWidth(0.6).strokeColor(linea).stroke();
    else doc.rect(x, yy, w, h).lineWidth(0.8).strokeColor(linea).stroke();
  };

  if (d.ambiente === 'homologacion') {
    doc.save().rotate(-35, { origin: [300, 420] }).fontSize(46).fillColor('#e11d48').opacity(0.16)
      .font(F.negrita).text('SIN VALIDEZ FISCAL', 40, 380, { width: 520, align: 'center' })
      .fontSize(20).text('Prueba en homologación de ARCA', 40, 440, { width: 520, align: 'center' })
      .restore().opacity(1);
  }

  // Logo centrado arriba de todo
  if (logo && ds.logoPosicion === 'centro') {
    try { doc.image(logo, x0 + W / 2 - 60, y, { fit: [120, 44], align: 'center' }); } catch { /* imagen inválida: se omite */ }
    y += 52;
  }

  // ---------- Encabezado ----------
  const altoEnc = 128;
  if (ds.esquema === 'banda') {
    doc.rect(x0, y, W, altoEnc).fillColor(ds.colorPrincipal).fill();
  } else {
    caja(x0, y, W, altoEnc);
  }
  const claroSobreBanda = ds.esquema === 'banda';
  const colorTxt = claroSobreBanda ? '#ffffff' : tinta;
  const colorSec = claroSobreBanda ? aclarar(ds.colorPrincipal, 0.75) : gris;

  // Recuadro de la letra
  doc.rect(x0 + W / 2 - 24, y, 48, 48).fillColor('#ffffff').fill();
  doc.rect(x0 + W / 2 - 24, y, 48, 48).lineWidth(1).strokeColor(ds.esquema === 'minimal' ? tinta : ds.colorPrincipal).stroke();
  doc.fillColor(tinta).font(F.negrita).fontSize(26).text(d.letra, x0 + W / 2 - 24, y + 7, { width: 48, align: 'center' });
  doc.font(F.normal).fontSize(7).text(`COD. ${String(d.codigoTipo).padStart(3, '0')}`, x0 + W / 2 - 24, y + 37, { width: 48, align: 'center' });
  if (ds.esquema !== 'banda') {
    doc.moveTo(x0 + W / 2, y + 48).lineTo(x0 + W / 2, y + altoEnc).lineWidth(0.6).strokeColor(linea).stroke();
  }

  // Bloque izquierdo: emisor
  let xl = x0 + 10;
  let yl = y + 10;
  const anchoIzq = W / 2 - 44;
  if (logo && ds.logoPosicion === 'izquierda') {
    try { doc.image(logo, xl, yl, { fit: [110, 40] }); } catch { /* se omite */ }
    yl += 46;
  }
  const nombreGrande = ds.nombreFantasia || d.emisor.razonSocial;
  doc.fillColor(colorTxt).font(F.negrita).fontSize(logo && ds.logoPosicion === 'izquierda' ? 11 : 14).text(nombreGrande, xl, yl, { width: anchoIzq });
  yl = doc.y + 3;
  doc.font(F.normal).fontSize(8).fillColor(colorSec);
  if (ds.nombreFantasia) { doc.text(`Razón social: ${d.emisor.razonSocial}`, xl, yl, { width: anchoIzq }); yl = doc.y + 1; }
  if (d.emisor.domicilio) { doc.text(`Domicilio: ${d.emisor.domicilio}`, xl, yl, { width: anchoIzq }); yl = doc.y + 1; }
  doc.text(`Condición frente al IVA: ${d.emisor.condicionIva || '-'}`, xl, yl, { width: anchoIzq }); yl = doc.y + 1;
  const contacto = [ds.telefono, ds.web, ds.emailContacto].filter(Boolean).join(' · ');
  if (contacto) doc.text(contacto, xl, yl, { width: anchoIzq });

  // Bloque derecho: tipo y numeración
  const xr = x0 + W / 2 + 34;
  let anchoDer = W / 2 - 44;
  if (logo && ds.logoPosicion === 'derecha') {
    try { doc.image(logo, x0 + W - 100, y + 8, { fit: [90, 36] }); } catch { /* se omite */ }
    anchoDer -= 96;
  }
  doc.fillColor(colorTxt).font(F.negrita).fontSize(15).text(d.nombreTipo.toUpperCase(), xr, y + 10, { width: anchoDer });
  doc.font(F.normal).fontSize(8.5).fillColor(colorTxt);
  [
    `Punto de Venta: ${String(d.ptoVta).padStart(5, '0')}    Comp. Nro: ${String(d.numero).padStart(8, '0')}`,
    `Fecha de Emisión: ${d.fecha}`,
    `CUIT: ${cuitFmt(d.emisor.cuit)}`,
    `Ingresos Brutos: ${d.emisor.iibb || '-'}`,
    `Fecha de Inicio de Actividades: ${d.emisor.inicioActividades || '-'}`,
  ].forEach((t, i) => doc.text(t, x0 + W / 2 + 10, y + 56 + i * 13, { width: W / 2 - 20 }));
  y += altoEnc + 8;
  doc.fillColor(tinta);

  // ---------- Período ----------
  if (d.periodo) {
    caja(x0, y, W, 20);
    doc.font(F.normal).fontSize(8.5).text(`Período Facturado Desde: ${d.periodo.desde}    Hasta: ${d.periodo.hasta}    Fecha de Vto. para el pago: ${d.periodo.vtoPago}`, x0 + 10, y + 6, { width: W - 20 });
    y += 26;
  }

  // ---------- Receptor ----------
  caja(x0, y, W, 52);
  doc.font(F.normal).fontSize(8.5)
    .text(`${d.receptor.docTipoNombre}: ${d.receptor.docNro ? cuitFmt(d.receptor.docNro) : '-'}`, x0 + 10, y + 7, { width: W / 2 - 20 })
    .text(`Apellido y Nombre / Razón Social: ${d.receptor.nombre || '-'}`, x0 + W / 2, y + 7, { width: W / 2 - 10 })
    .text(`Condición frente al IVA: ${d.receptor.condicionIva}`, x0 + 10, y + 22, { width: W / 2 - 20 })
    .text(`Domicilio: ${d.receptor.domicilio || '-'}`, x0 + W / 2, y + 22, { width: W / 2 - 10 })
    .text(`Condición de venta: ${d.condicionVenta}`, x0 + 10, y + 37, { width: W - 20 });
  y += 60;

  // ---------- Ítems ----------
  const cols: Array<[string, number, 'left' | 'right']> = d.discriminaIva
    ? [['Descripción', 200, 'left'], ['Cant.', 45, 'right'], ['U. Medida', 60, 'left'], ['Precio Unit.', 75, 'right'], ['Alíc. IVA', 45, 'right'], ['Subtotal', 98, 'right']]
    : [['Descripción', 245, 'left'], ['Cant.', 50, 'right'], ['U. Medida', 65, 'left'], ['Precio Unit.', 80, 'right'], ['Subtotal', 83, 'right']];
  if (ds.esquema === 'minimal') {
    doc.moveTo(x0, y + 18).lineTo(x0 + W, y + 18).lineWidth(1).strokeColor(tinta).stroke();
  } else {
    doc.rect(x0, y, W, 18).fillColor(aclarar(ds.colorPrincipal, 0.88)).fill();
  }
  let xc = x0 + 4;
  doc.fillColor(ds.esquema === 'minimal' ? tinta : ds.colorPrincipal).font(F.negrita).fontSize(8);
  for (const [t, w, al] of cols) { doc.text(t, xc, y + 5, { width: w - 8, align: al }); xc += w; }
  y += 24;
  doc.fillColor(tinta).font(F.normal).fontSize(8.5);
  for (const it of d.items) {
    const valores = d.discriminaIva
      ? [it.descripcion, String(it.cantidad), it.unidad, pesos(it.precioUnitario), it.alicuota || '', pesos(it.subtotal)]
      : [it.descripcion, String(it.cantidad), it.unidad, pesos(it.precioUnitario), pesos(it.subtotal)];
    const alto = Math.max(14, doc.heightOfString(it.descripcion, { width: cols[0][1] - 8 }) + 5);
    if (y + alto > 600) { doc.addPage(); y = 36; }
    xc = x0 + 4;
    valores.forEach((v, i) => { doc.text(v, xc, y, { width: cols[i][1] - 8, align: cols[i][2] }); xc += cols[i][1]; });
    y += alto;
    doc.moveTo(x0, y - 2).lineTo(x0 + W, y - 2).lineWidth(0.3).strokeColor('#e6e3dc').stroke();
  }

  // ---------- Notas ----------
  y = Math.max(y + 10, 520);
  if (ds.notas) {
    doc.font(F.normal).fontSize(8.5).fillColor(gris).text(ds.notas, x0, y, { width: W });
    y = doc.y + 8;
  }

  // ---------- Totales ----------
  const filas: Array<[string, number]> = [];
  if (d.discriminaIva) {
    filas.push(['Importe Neto Gravado', d.totales.neto]);
    for (const iva of d.totales.iva) filas.push([iva.etiqueta, iva.importe]);
    if (d.totales.exento) filas.push(['Importe Exento', d.totales.exento]);
    if (d.totales.noGravado) filas.push(['Importe No Gravado', d.totales.noGravado]);
  } else {
    filas.push(['Subtotal', d.totales.total]);
  }
  filas.push(['Importe Total', d.totales.total]);
  caja(x0, y, W, 16 * filas.length + 10);
  filas.forEach(([t, v], i) => {
    const ultima = i === filas.length - 1;
    doc.font(ultima ? F.negrita : F.normal).fontSize(ultima ? 11 : 9).fillColor(ultima ? ds.colorAcento : tinta)
      .text(`${t}:`, x0 + W - 300, y + 7 + i * 16, { width: 170, align: 'right' })
      .text(pesos(v), x0 + W - 120, y + 7 + i * 16, { width: 110, align: 'right' });
  });
  y += 16 * filas.length + 20;
  if (y > 700) { doc.addPage(); y = 36; }

  // ---------- Pie: QR + CAE (obligatorio) ----------
  doc.image(qrPng, x0, y, { width: 95 });
  doc.fillColor(tinta).font(F.negrita).fontSize(10).text('Comprobante Autorizado', x0 + 110, y + 10);
  doc.font(F.normal).fontSize(8).fillColor(gris).text('Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.', x0 + 110, y + 26, { width: 240 });
  doc.fillColor(tinta).font(F.negrita).fontSize(10)
    .text(`CAE N°: ${d.cae}`, x0 + W - 200, y + 10, { width: 200, align: 'right' })
    .text(`Fecha de Vto. de CAE: ${d.caeVencimiento}`, x0 + W - 200, y + 28, { width: 200, align: 'right' });
  y += 104;

  if (ds.leyendaPie) {
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.6).strokeColor(ds.colorAcento).stroke();
    doc.font(F.normal).fontSize(8.5).fillColor(gris).text(ds.leyendaPie, x0, y + 6, { width: W, align: 'center' });
  }

  doc.end();
  return fin;
}

/** Datos de ejemplo para la vista previa del diseño. */
export function datosEjemplo(emisor: DatosPdf['emisor']): DatosPdf {
  const hoy = new Date();
  const f = (dt: Date) => `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
  return {
    ambiente: 'homologacion',
    letra: 'C',
    codigoTipo: 11,
    nombreTipo: 'Factura C',
    ptoVta: 2,
    numero: 123,
    fecha: f(hoy),
    emisor,
    receptor: { docTipoNombre: 'CUIT', docNro: '30712345678', nombre: 'Cliente de ejemplo SA', condicionIva: 'IVA Responsable Inscripto', domicilio: 'Av. Ejemplo 1234 - CABA' },
    condicionVenta: 'Transferencia',
    periodo: { desde: f(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: f(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)), vtoPago: f(hoy) },
    items: [
      { descripcion: 'Servicio mensual de ejemplo', cantidad: 1, unidad: 'unidades', precioUnitario: 150000, subtotal: 150000 },
      { descripcion: 'Horas adicionales', cantidad: 3, unidad: 'unidades', precioUnitario: 12500, subtotal: 37500 },
    ],
    totales: { neto: 187500, iva: [], exento: 0, noGravado: 0, total: 187500 },
    discriminaIva: false,
    cae: '76000000000000',
    caeVencimiento: f(new Date(hoy.getTime() + 10 * 86400e3)),
    qr: { tipoDocRec: 80, nroDocRec: '30712345678', fechaIso: hoy.toISOString().slice(0, 10) },
  };
}
