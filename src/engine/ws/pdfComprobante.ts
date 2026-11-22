import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * PDF del comprobante emitido por web service. ARCA no lo genera por WS: lo arma el sistema,
 * con el código QR obligatorio (RG 4892) que apunta a la verificación de ARCA.
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

const pesos = (v: number) => '$ ' + v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cuitFmt = (c: string) => (c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);

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

export async function generarPdfComprobante(d: DatosPdf): Promise<Buffer> {
  const qrPng = await QRCode.toBuffer(urlQrArca(d), { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const partes: Buffer[] = [];
  doc.on('data', (c: Buffer) => partes.push(c));
  const fin = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(partes))));

  const W = doc.page.width - 72;
  const x0 = 36;
  let y = 36;

  if (d.ambiente === 'homologacion') {
    doc.save().rotate(-35, { origin: [300, 420] }).fontSize(46).fillColor('#e11d48').opacity(0.18)
      .text('SIN VALIDEZ FISCAL', 40, 380, { width: 520, align: 'center' })
      .fontSize(22).text('Prueba en homologación de ARCA', 40, 440, { width: 520, align: 'center' })
      .restore().opacity(1).fillColor('black');
  }

  // Encabezado con letra
  doc.rect(x0, y, W, 120).stroke();
  doc.moveTo(x0 + W / 2, y + 48).lineTo(x0 + W / 2, y + 120).stroke();
  doc.rect(x0 + W / 2 - 24, y, 48, 48).stroke();
  doc.fontSize(26).font('Helvetica-Bold').text(d.letra, x0 + W / 2 - 24, y + 6, { width: 48, align: 'center' });
  doc.fontSize(7).font('Helvetica').text(`COD. ${String(d.codigoTipo).padStart(3, '0')}`, x0 + W / 2 - 24, y + 36, { width: 48, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(13).text(d.emisor.razonSocial, x0 + 10, y + 10, { width: W / 2 - 44 });
  doc.font('Helvetica').fontSize(8.5);
  let yl = y + 56;
  if (d.emisor.domicilio) { doc.text(`Domicilio: ${d.emisor.domicilio}`, x0 + 10, yl, { width: W / 2 - 20 }); yl += 22; }
  doc.text(`Condición frente al IVA: ${d.emisor.condicionIva || '-'}`, x0 + 10, yl, { width: W / 2 - 20 });

  const xr = x0 + W / 2 + 34;
  doc.font('Helvetica-Bold').fontSize(14).text(d.nombreTipo.toUpperCase(), xr, y + 10, { width: W / 2 - 44 });
  doc.font('Helvetica').fontSize(8.5);
  const lineasDer = [
    `Punto de Venta: ${String(d.ptoVta).padStart(5, '0')}    Comp. Nro: ${String(d.numero).padStart(8, '0')}`,
    `Fecha de Emisión: ${d.fecha}`,
    `CUIT: ${cuitFmt(d.emisor.cuit)}`,
    `Ingresos Brutos: ${d.emisor.iibb || '-'}`,
    `Fecha de Inicio de Actividades: ${d.emisor.inicioActividades || '-'}`,
  ];
  lineasDer.forEach((t, i) => doc.text(t, x0 + W / 2 + 10, y + 52 + i * 13, { width: W / 2 - 20 }));
  y += 128;

  if (d.periodo) {
    doc.rect(x0, y, W, 20).stroke();
    doc.fontSize(8.5).text(`Período Facturado Desde: ${d.periodo.desde}    Hasta: ${d.periodo.hasta}    Fecha de Vto. para el pago: ${d.periodo.vtoPago}`, x0 + 10, y + 6, { width: W - 20 });
    y += 26;
  }

  // Receptor
  doc.rect(x0, y, W, 52).stroke();
  doc.fontSize(8.5)
    .text(`${d.receptor.docTipoNombre}: ${d.receptor.docNro ? cuitFmt(d.receptor.docNro) : '-'}`, x0 + 10, y + 7, { width: W / 2 - 20 })
    .text(`Apellido y Nombre / Razón Social: ${d.receptor.nombre || '-'}`, x0 + W / 2, y + 7, { width: W / 2 - 10 })
    .text(`Condición frente al IVA: ${d.receptor.condicionIva}`, x0 + 10, y + 22, { width: W / 2 - 20 })
    .text(`Domicilio: ${d.receptor.domicilio || '-'}`, x0 + W / 2, y + 22, { width: W / 2 - 10 })
    .text(`Condición de venta: ${d.condicionVenta}`, x0 + 10, y + 37, { width: W - 20 });
  y += 60;

  // Ítems
  const cols = d.discriminaIva
    ? [['Descripción', 200], ['Cant.', 45], ['U. Medida', 60], ['Precio Unit.', 75], ['Alíc. IVA', 45], ['Subtotal', 98]]
    : [['Descripción', 245], ['Cant.', 50], ['U. Medida', 65], ['Precio Unit.', 80], ['Subtotal', 83]];
  doc.rect(x0, y, W, 18).fillAndStroke('#e5e7eb', '#000').fillColor('black');
  let xc = x0 + 4;
  doc.font('Helvetica-Bold').fontSize(8);
  for (const [t, w] of cols) { doc.text(String(t), xc, y + 5, { width: Number(w) - 6 }); xc += Number(w); }
  y += 22;
  doc.font('Helvetica').fontSize(8.5);
  for (const it of d.items) {
    const valores = d.discriminaIva
      ? [it.descripcion, String(it.cantidad), it.unidad, pesos(it.precioUnitario), it.alicuota || '', pesos(it.subtotal)]
      : [it.descripcion, String(it.cantidad), it.unidad, pesos(it.precioUnitario), pesos(it.subtotal)];
    const alto = Math.max(14, doc.heightOfString(it.descripcion, { width: Number(cols[0][1]) - 6 }) + 4);
    xc = x0 + 4;
    valores.forEach((v, i) => { doc.text(v, xc, y, { width: Number(cols[i][1]) - 6 }); xc += Number(cols[i][1]); });
    y += alto;
    if (y > 640) { doc.addPage(); y = 36; }
  }

  // Totales
  y = Math.max(y + 10, 560);
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
  doc.rect(x0, y, W, 16 * filas.length + 10).stroke();
  filas.forEach(([t, v], i) => {
    const negrita = i === filas.length - 1;
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(negrita ? 10.5 : 9)
      .text(`${t}:`, x0 + W - 300, y + 7 + i * 16, { width: 170, align: 'right' })
      .text(pesos(v), x0 + W - 120, y + 7 + i * 16, { width: 110, align: 'right' });
  });
  y += 16 * filas.length + 20;

  // Pie: QR + CAE
  doc.image(qrPng, x0, y, { width: 95 });
  doc.font('Helvetica-Bold').fontSize(10).text('Comprobante Autorizado', x0 + 110, y + 10);
  doc.font('Helvetica').fontSize(8).text('Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.', x0 + 110, y + 26, { width: 260 });
  doc.font('Helvetica-Bold').fontSize(10)
    .text(`CAE N°: ${d.cae}`, x0 + W - 200, y + 10, { width: 200, align: 'right' })
    .text(`Fecha de Vto. de CAE: ${d.caeVencimiento}`, x0 + W - 200, y + 28, { width: 200, align: 'right' });

  doc.end();
  return fin;
}
