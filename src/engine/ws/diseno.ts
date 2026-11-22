import zlib from 'zlib';

/**
 * Diseño de los comprobantes (PDF) y del mail con que se envían, por cuenta emisora.
 *
 * - "generico": el diseño estándar de BotArca, sobrio, con todo lo que exige ARCA.
 * - "personalizado": logo, colores, tipografía, esquema, nombre de fantasía, leyendas y textos del mail.
 *
 * Lo obligatorio (letra y código, datos del emisor y receptor, número, fecha, totales, CAE y QR)
 * se dibuja SIEMPRE, sea cual sea el diseño: no se puede ocultar desde la configuración.
 */

export type EsquemaPdf = 'clasico' | 'banda' | 'minimal';
export type TipografiaPdf = 'helvetica' | 'times' | 'courier';

export interface DisenoComprobante {
  modo: 'generico' | 'personalizado';
  esquema: EsquemaPdf;
  colorPrincipal: string;
  colorAcento: string;
  tipografia: TipografiaPdf;
  logoDataUrl?: string;
  logoPosicion: 'izquierda' | 'centro' | 'derecha';
  nombreFantasia?: string;
  telefono?: string;
  web?: string;
  emailContacto?: string;
  leyendaPie?: string;
  notas?: string;
  mail: {
    asunto?: string;
    cuerpo?: string;
    responderA?: string;
  };
}

export const DISENO_GENERICO: DisenoComprobante = {
  modo: 'generico',
  esquema: 'clasico',
  colorPrincipal: '#17181a',
  colorAcento: '#e8590c',
  tipografia: 'helvetica',
  logoPosicion: 'izquierda',
  mail: {},
};

export const ASUNTO_MAIL_DEFAULT = '{tipo} N° {numero} de {emisor}';
export const CUERPO_MAIL_DEFAULT =
  'Hola {cliente},\n\nTe enviamos el comprobante {tipo} N° {numero} por {total}.\nCAE {cae}, válido hasta el {vencimientoCae}.\n\nEl PDF va adjunto.\n\nSaludos,\n{emisor}';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Verifica que la imagen se pueda leer ANTES de guardarla. Un PNG dañado hace que la librería
 * de PDF falle en segundo plano y tire abajo todo el servidor, así que se descomprime acá
 * de forma sincrónica para detectarlo.
 */
export function validarImagen(buf: Buffer, tipo: 'png' | 'jpg') {
  const invalida = new Error('No se pudo leer la imagen del logo (archivo dañado o formato no soportado).');
  if (tipo === 'jpg') {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw invalida;
    return;
  }
  const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(firma)) throw invalida;
  const idat: Buffer[] = [];
  let pos = 8;
  let entrelazado = 0;
  while (pos + 8 <= buf.length) {
    const largo = buf.readUInt32BE(pos);
    const tipoChunk = buf.toString('ascii', pos + 4, pos + 8);
    if (pos + 12 + largo > buf.length) throw invalida;
    if (tipoChunk === 'IHDR') entrelazado = buf[pos + 8 + 12];
    if (tipoChunk === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + largo));
    if (tipoChunk === 'IEND') break;
    pos += 12 + largo;
  }
  if (!idat.length) throw invalida;
  if (entrelazado) throw new Error('El logo es un PNG entrelazado: guardalo sin entrelazado o como JPG.');
  try {
    zlib.inflateSync(Buffer.concat(idat));
  } catch {
    throw invalida;
  }
}
const LOGO_MAX_BYTES = 400 * 1024;

/** Valida y completa un diseño recibido del panel. Lanza Error con un mensaje claro si algo no sirve. */
export function sanearDiseno(entrada: any): DisenoComprobante {
  const d = entrada || {};
  const modo = d.modo === 'personalizado' ? 'personalizado' : 'generico';
  const esquema: EsquemaPdf = ['clasico', 'banda', 'minimal'].includes(d.esquema) ? d.esquema : 'clasico';
  const tipografia: TipografiaPdf = ['helvetica', 'times', 'courier'].includes(d.tipografia) ? d.tipografia : 'helvetica';
  const color = (v: any, def: string) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : def);
  const texto = (v: any, max: number) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max) || undefined);

  let logoDataUrl: string | undefined;
  if (d.logoDataUrl) {
    const m = String(d.logoDataUrl).match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error('El logo tiene que ser una imagen PNG o JPG.');
    if (Buffer.byteLength(m[2], 'base64') > LOGO_MAX_BYTES) throw new Error('El logo pesa más de 400 KB. Usá una imagen más chica.');
    validarImagen(Buffer.from(m[2], 'base64'), m[1] === 'png' ? 'png' : 'jpg');
    logoDataUrl = String(d.logoDataUrl);
  }
  const responderA = texto(d.mail?.responderA, 200);
  if (responderA && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(responderA)) throw new Error('El email de "responder a" no es válido.');

  return {
    modo,
    esquema,
    colorPrincipal: color(d.colorPrincipal, DISENO_GENERICO.colorPrincipal),
    colorAcento: color(d.colorAcento, DISENO_GENERICO.colorAcento),
    tipografia,
    logoDataUrl,
    logoPosicion: ['izquierda', 'centro', 'derecha'].includes(d.logoPosicion) ? d.logoPosicion : 'izquierda',
    nombreFantasia: texto(d.nombreFantasia, 80),
    telefono: texto(d.telefono, 40),
    web: texto(d.web, 80),
    emailContacto: texto(d.emailContacto, 120),
    leyendaPie: texto(d.leyendaPie, 300),
    notas: texto(d.notas, 500),
    mail: {
      asunto: texto(d.mail?.asunto, 150),
      cuerpo: texto(d.mail?.cuerpo, 3000),
      responderA,
    },
  };
}

/** El diseño que se aplica: el genérico salvo que la cuenta tenga uno personalizado. */
export function disenoEfectivo(d?: DisenoComprobante): DisenoComprobante {
  if (!d || d.modo !== 'personalizado') return { ...DISENO_GENERICO, mail: { ...(d?.mail || {}) } };
  return d;
}

/** Reemplaza {variables} en los textos del mail. */
export function completarPlantilla(texto: string, vars: Record<string, string>): string {
  return texto.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function escapeHtml(s: string) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Arma asunto y cuerpo HTML del mail que acompaña al comprobante. */
export function armarMailComprobante(diseno: DisenoComprobante | undefined, vars: Record<string, string>) {
  const d = disenoEfectivo(diseno);
  const asunto = completarPlantilla(d.mail.asunto || ASUNTO_MAIL_DEFAULT, vars);
  const cuerpoTexto = completarPlantilla(d.mail.cuerpo || CUERPO_MAIL_DEFAULT, vars);
  const parrafos = escapeHtml(cuerpoTexto).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const nombre = escapeHtml(d.nombreFantasia || vars.emisor || '');
  const contacto = [d.telefono, d.web, d.emailContacto].filter(Boolean).map(x => escapeHtml(String(x))).join(' · ');
  const html = `<div style="background:#faf8f4;padding:24px 12px;font-family:Georgia,'Times New Roman',serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e3dc">
    <div style="border-top:4px solid ${d.colorAcento};padding:20px 24px 8px">
      <div style="font-size:20px;color:${d.colorPrincipal}">${nombre}</div>
    </div>
    <div style="padding:8px 24px 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17181a">${parrafos}</div>
    <div style="margin:0 24px 20px;border-top:1px solid #e6e3dc;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6d71">
      <div><strong style="color:#17181a">${escapeHtml(vars.tipo)} N° ${escapeHtml(vars.numero)}</strong> · Total <strong style="color:${d.colorAcento}">${escapeHtml(vars.total)}</strong></div>
      <div>CAE ${escapeHtml(vars.cae)} · Vto. ${escapeHtml(vars.vencimientoCae)}</div>
      ${contacto ? `<div style="margin-top:6px">${contacto}</div>` : ''}
    </div>
  </div>
</div>`;
  return { asunto, html, responderA: d.mail.responderA };
}
