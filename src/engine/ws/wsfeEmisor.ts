import { ArcaAccountRecord } from '../../database.js';
import { decrypt } from '../../crypto.js';
import { logger } from '../../services/logger.js';
import { FacturaRequest, FacturaResponse } from '../modules/facturacion.js';
import { leerCertificado, normalizarPem, InfoCertificado } from './certificados.js';
import { AmbienteArca, obtenerTicket } from './wsaa.js';
import {
  AuthWsfe, SolicitudCae, IvaAlicuota, WsfeError,
  ultimoAutorizado, solicitarCae, consultarComprobante, puntosDeVenta, feDummy,
} from './wsfev1.js';
import { SoapNetworkError } from './soap.js';
import { generarPdfComprobante, DatosPdf } from './pdfComprobante.js';

/* ------------------------------------------------------------------ */
/* Configuración                                                      */
/* ------------------------------------------------------------------ */

/** Por seguridad el ambiente por defecto es HOMOLOGACIÓN (no emite comprobantes reales). */
export function ambienteActual(): AmbienteArca {
  return String(process.env.WSFE_AMBIENTE || '').toLowerCase() === 'produccion' ? 'produccion' : 'homologacion';
}

export interface CredencialesWs {
  modoUsado: 'propio' | 'delegado';
  certPem: string;
  keyPem: string;
  certificado: InfoCertificado;
  origen: string; // de dónde salió el certificado (para mostrar en el panel)
}

/** Certificado de la plataforma (modo delegado). Se configura en variables de entorno de Render. */
function credencialesPlataforma(): { certPem: string; keyPem: string } | null {
  const certPem = normalizarPem(process.env.WSFE_PLATFORM_CERT);
  const keyPem = normalizarPem(process.env.WSFE_PLATFORM_KEY);
  return certPem && keyPem ? { certPem, keyPem } : null;
}

/** Certificado propio del emisor: primero variables de entorno, después lo cargado en el panel. */
function credencialesPropias(acc: ArcaAccountRecord): { certPem: string; keyPem: string; origen: string } | null {
  const certEnv = normalizarPem(process.env[`WSFE_CERT_${acc.cuit}`]);
  const keyEnv = normalizarPem(process.env[`WSFE_KEY_${acc.cuit}`]);
  if (certEnv && keyEnv) return { certPem: certEnv, keyPem: keyEnv, origen: `variables WSFE_CERT_${acc.cuit} / WSFE_KEY_${acc.cuit}` };
  const certPanel = normalizarPem(acc.ws?.certPropioPem);
  const keyPanel = acc.ws?.encryptedKeyPropio ? normalizarPem(decrypt(acc.ws.encryptedKeyPropio)) : '';
  if (certPanel && keyPanel) return { certPem: certPanel, keyPem: keyPanel, origen: 'cargado en el panel' };
  return null;
}

/**
 * Decide con qué certificado se conecta esta cuenta. Devuelve null si la cuenta está en modo
 * 'navegador' (flujo viejo con Clave Fiscal). Nunca elige el navegador por su cuenta.
 */
export function resolverCredenciales(acc: ArcaAccountRecord): CredencialesWs | null {
  const modo = acc.ws?.modo || 'auto';
  if (modo === 'navegador') return null;

  const propio = modo === 'propio' || modo === 'auto' ? credencialesPropias(acc) : null;
  if (propio) {
    const info = leerCertificado(propio.certPem);
    if (info.cuit && info.cuit !== acc.cuit) {
      throw new Error(`El certificado propio cargado es del CUIT ${info.cuit}, no de ${acc.cuit}. Para usar un certificado de otro CUIT, elegí el modo "Delegado".`);
    }
    return { modoUsado: 'propio', ...propio, certificado: info };
  }
  if (modo === 'propio') {
    throw new Error(`La cuenta ${acc.cuit} está en modo "Certificado propio" pero no tiene certificado cargado.`);
  }

  const plataforma = credencialesPlataforma();
  if (plataforma) {
    return { modoUsado: 'delegado', ...plataforma, certificado: leerCertificado(plataforma.certPem), origen: 'certificado de la plataforma (WSFE_PLATFORM_CERT)' };
  }
  if (modo === 'delegado') {
    throw new Error('La cuenta está en modo "Delegado" pero el certificado de la plataforma no está configurado (faltan WSFE_PLATFORM_CERT y WSFE_PLATFORM_KEY).');
  }
  throw new Error(
    `La cuenta ${acc.cuit} no tiene forma de conectarse por web service: no hay certificado propio cargado ` +
    'ni certificado de la plataforma configurado. Cargá uno, o pasá la cuenta al modo "Navegador".'
  );
}

/* ------------------------------------------------------------------ */
/* Tablas de ARCA                                                     */
/* ------------------------------------------------------------------ */

const TIPOS_CBTE: Record<string, { codigo: number; letra: 'A' | 'B' | 'C'; nc?: boolean }> = {
  'factura a': { codigo: 1, letra: 'A' },
  'nota de debito a': { codigo: 2, letra: 'A' },
  'nota de credito a': { codigo: 3, letra: 'A', nc: true },
  'factura b': { codigo: 6, letra: 'B' },
  'nota de debito b': { codigo: 7, letra: 'B' },
  'nota de credito b': { codigo: 8, letra: 'B', nc: true },
  'factura c': { codigo: 11, letra: 'C' },
  'nota de debito c': { codigo: 12, letra: 'C' },
  'nota de credito c': { codigo: 13, letra: 'C', nc: true },
  'recibo c': { codigo: 15, letra: 'C' },
};

const DOC_TIPOS: Record<string, { codigo: number; nombre: string }> = {
  'cuit': { codigo: 80, nombre: 'CUIT' },
  'cuil': { codigo: 86, nombre: 'CUIL' },
  'cdi': { codigo: 87, nombre: 'CDI' },
  'dni': { codigo: 96, nombre: 'DNI' },
  'pasaporte': { codigo: 94, nombre: 'Pasaporte' },
  'consumidor final': { codigo: 99, nombre: 'Doc. (Otro)' },
  'sin identificar': { codigo: 99, nombre: 'Doc. (Otro)' },
};

// Códigos de condición frente al IVA del receptor (RG 5616 / FEParamGetCondicionIvaReceptor)
const CONDICION_IVA: Array<{ clave: string; codigo: number; nombre: string }> = [
  { clave: 'monotributista social', codigo: 13, nombre: 'Monotributista Social' },
  { clave: 'trabajador independiente', codigo: 16, nombre: 'Monotributo Trabajador Independiente Promovido' },
  { clave: 'responsable inscripto', codigo: 1, nombre: 'IVA Responsable Inscripto' },
  { clave: 'monotribut', codigo: 6, nombre: 'Responsable Monotributo' },
  { clave: 'exento', codigo: 4, nombre: 'IVA Sujeto Exento' },
  { clave: 'no categorizado', codigo: 7, nombre: 'Sujeto No Categorizado' },
  { clave: 'proveedor del exterior', codigo: 8, nombre: 'Proveedor del Exterior' },
  { clave: 'cliente del exterior', codigo: 9, nombre: 'Cliente del Exterior' },
  { clave: 'liberado', codigo: 10, nombre: 'IVA Liberado – Ley N° 19.640' },
  { clave: 'no alcanzado', codigo: 15, nombre: 'IVA No Alcanzado' },
  { clave: 'consumidor final', codigo: 5, nombre: 'Consumidor Final' },
];

// Alícuotas de IVA (Id de WSFEv1)
const ALICUOTAS: Record<string, { id: number; tasa: number; etiqueta: string }> = {
  '0': { id: 3, tasa: 0, etiqueta: '0%' },
  '2.5': { id: 9, tasa: 0.025, etiqueta: '2,5%' },
  '5': { id: 8, tasa: 0.05, etiqueta: '5%' },
  '10.5': { id: 4, tasa: 0.105, etiqueta: '10,5%' },
  '21': { id: 5, tasa: 0.21, etiqueta: '21%' },
  '27': { id: 6, tasa: 0.27, etiqueta: '27%' },
};

const CONCEPTO_NOMBRE: Record<number, string> = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' };

function normalizar(t: string) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/* ------------------------------------------------------------------ */
/* Fechas (siempre en hora de Argentina)                              */
/* ------------------------------------------------------------------ */

function hoyArgentina(): { y: number; m: number; d: number } {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return { y: partes[0], m: partes[1], d: partes[2] };
}

/** Acepta yyyy-mm-dd, dd/mm/yyyy o yyyymmdd y devuelve yyyymmdd. */
export function aYyyymmdd(fecha?: string): string {
  if (!fecha) {
    const h = hoyArgentina();
    return `${h.y}${String(h.m).padStart(2, '0')}${String(h.d).padStart(2, '0')}`;
  }
  const f = fecha.trim();
  let m = f.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = f.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  if (/^\d{8}$/.test(f)) return f;
  throw new Error(`Fecha inválida: "${fecha}". Usá dd/mm/aaaa.`);
}

const aDdmmyyyy = (y8: string) => (y8 && y8.length === 8 ? `${y8.slice(6, 8)}/${y8.slice(4, 6)}/${y8.slice(0, 4)}` : y8);
const aIso = (y8: string) => `${y8.slice(0, 4)}-${y8.slice(4, 6)}-${y8.slice(6, 8)}`;

function finDeMes(y8: string): string {
  const y = Number(y8.slice(0, 4)), m = Number(y8.slice(4, 6));
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y8.slice(0, 6)}${String(ultimo).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Armado del comprobante                                             */
/* ------------------------------------------------------------------ */

export interface ComprobantePreparado {
  solicitud: Omit<SolicitudCae, 'cbteNro'>;
  tipo: { codigo: number; letra: 'A' | 'B' | 'C'; nombre: string };
  doc: { codigo: number; nombre: string; nro: string };
  condicionIvaReceptor: { codigo: number; nombre: string };
  itemsPdf: DatosPdf['items'];
  totales: DatosPdf['totales'];
}

/**
 * Convierte el pedido del panel en el formato de WSFEv1.
 * - Factura C (monotributo): el precio es el final, no se discrimina IVA.
 * - Factura A/B: el precio unitario se toma SIN IVA y se le suma la alícuota del ítem (21% por defecto).
 */
export function prepararComprobante(datos: FacturaRequest, ptoVta: number): ComprobantePreparado {
  const tipo = TIPOS_CBTE[normalizar(datos.tipoComprobante)];
  if (!tipo) throw new Error(`Tipo de comprobante no soportado por web service: "${datos.tipoComprobante}".`);
  if (![1, 2, 3].includes(Number(datos.concepto))) throw new Error(`Concepto inválido: ${datos.concepto}.`);
  if (!datos.items?.length) throw new Error('La factura no tiene ítems.');

  const docInfo = DOC_TIPOS[normalizar(datos.receptor.tipoDoc || 'Consumidor Final')] || DOC_TIPOS['consumidor final'];
  let docNro = String(datos.receptor.nroDoc || '').replace(/\D/g, '');
  if (docInfo.codigo === 99) docNro = '0';
  if (docInfo.codigo !== 99 && !docNro) throw new Error(`Falta el número de ${docInfo.nombre} del receptor.`);
  if (docInfo.codigo === 80 && docNro.length !== 11) throw new Error(`El CUIT del receptor debe tener 11 dígitos (llegó "${datos.receptor.nroDoc}").`);
  if (tipo.letra === 'A' && docInfo.codigo !== 80) throw new Error('Para un comprobante A el receptor tiene que estar identificado con CUIT.');

  const condKey = normalizar(datos.receptor.condicionIva || 'Consumidor Final');
  const cond = CONDICION_IVA.find(c => condKey.includes(c.clave));
  if (!cond) throw new Error(`Condición frente al IVA del receptor no reconocida: "${datos.receptor.condicionIva}".`);

  // Importes
  let neto = 0, exento = 0, noGravado = 0;
  const ivaPorId = new Map<number, IvaAlicuota & { etiqueta: string }>();
  const itemsPdf: DatosPdf['items'] = [];
  for (const it of datos.items) {
    const cantidad = Number(it.cantidad) || 0;
    const precio = Number(it.precioUnitario) || 0;
    if (cantidad <= 0) throw new Error(`Cantidad inválida en "${it.descripcion}".`);
    if (precio <= 0) throw new Error(`Precio inválido en "${it.descripcion}".`);
    const bonif = Math.min(Math.max(Number(it.bonificacionPorcentaje) || 0, 0), 100);
    const subtotal = r2(cantidad * precio * (1 - bonif / 100));

    if (tipo.letra === 'C') {
      neto += subtotal;
      itemsPdf.push({ descripcion: it.descripcion, cantidad, unidad: it.unidadMedida || 'unidades', precioUnitario: precio, subtotal });
      continue;
    }
    const alicTexto = normalizar(String(it.alicuotaIva ?? '21')).replace('%', '').replace(',', '.').trim();
    if (alicTexto === 'exento') { exento += subtotal; itemsPdf.push({ descripcion: it.descripcion, cantidad, unidad: it.unidadMedida || 'unidades', precioUnitario: precio, subtotal, alicuota: 'Exento' }); continue; }
    if (alicTexto === 'no gravado') { noGravado += subtotal; itemsPdf.push({ descripcion: it.descripcion, cantidad, unidad: it.unidadMedida || 'unidades', precioUnitario: precio, subtotal, alicuota: 'No grav.' }); continue; }
    const alic = ALICUOTAS[String(parseFloat(alicTexto))];
    if (!alic) throw new Error(`Alícuota de IVA "${it.alicuotaIva}" no reconocida en "${it.descripcion}".`);
    const iva = r2(subtotal * alic.tasa);
    neto += subtotal;
    const acum = ivaPorId.get(alic.id) || { id: alic.id, baseImp: 0, importe: 0, etiqueta: `IVA ${alic.etiqueta}` };
    acum.baseImp = r2(acum.baseImp + subtotal);
    acum.importe = r2(acum.importe + iva);
    ivaPorId.set(alic.id, acum);
    itemsPdf.push({ descripcion: it.descripcion, cantidad, unidad: it.unidadMedida || 'unidades', precioUnitario: precio, subtotal, alicuota: alic.etiqueta });
  }
  neto = r2(neto); exento = r2(exento); noGravado = r2(noGravado);
  const ivas = [...ivaPorId.values()];
  const impIva = r2(ivas.reduce((a, b) => a + b.importe, 0));
  const total = r2(neto + impIva + exento + noGravado);

  // Fechas
  const cbteFch = aYyyymmdd(datos.fechaEmision);
  const servicios = Number(datos.concepto) === 2 || Number(datos.concepto) === 3;
  const fchServDesde = servicios ? aYyyymmdd(datos.periodoDesde || `${cbteFch.slice(0, 6)}01`) : undefined;
  const fchServHasta = servicios ? aYyyymmdd(datos.periodoHasta || finDeMes(cbteFch)) : undefined;
  const fchVtoPago = servicios ? aYyyymmdd(datos.vencimientoPago || cbteFch) : undefined;

  // Comprobante asociado (Notas de crédito/débito)
  let cbtesAsoc: SolicitudCae['cbtesAsoc'];
  if (datos.comprobanteAsociado?.numero) {
    const tAsoc = TIPOS_CBTE[normalizar(datos.comprobanteAsociado.tipo)];
    if (!tAsoc) throw new Error(`Tipo de comprobante asociado no reconocido: "${datos.comprobanteAsociado.tipo}".`);
    cbtesAsoc = [{
      tipo: tAsoc.codigo,
      ptoVta: Number(datos.comprobanteAsociado.puntoVenta),
      nro: parseInt(String(datos.comprobanteAsociado.numero).replace(/\D/g, ''), 10),
    }];
  } else if (tipo.nc) {
    throw new Error('Una Nota de Crédito necesita el comprobante asociado (tipo, punto de venta y número).');
  }

  return {
    solicitud: {
      ptoVta,
      cbteTipo: tipo.codigo,
      concepto: Number(datos.concepto) as 1 | 2 | 3,
      docTipo: docInfo.codigo,
      docNro,
      cbteFch,
      impTotal: total,
      impTotConc: tipo.letra === 'C' ? 0 : noGravado,
      impNeto: neto,
      impOpEx: tipo.letra === 'C' ? 0 : exento,
      impIva: impIva,
      impTrib: 0,
      fchServDesde, fchServHasta, fchVtoPago,
      condicionIvaReceptorId: cond.codigo,
      iva: tipo.letra === 'C' ? undefined : ivas.map(({ id, baseImp, importe }) => ({ id, baseImp, importe })),
      cbtesAsoc,
    },
    tipo: { codigo: tipo.codigo, letra: tipo.letra, nombre: datos.tipoComprobante },
    doc: { codigo: docInfo.codigo, nombre: docInfo.nombre, nro: docNro },
    condicionIvaReceptor: { codigo: cond.codigo, nombre: cond.nombre },
    itemsPdf,
    totales: { neto, iva: ivas.map(i => ({ etiqueta: i.etiqueta, importe: i.importe })), exento, noGravado, total },
  };
}

/* ------------------------------------------------------------------ */
/* Emisión                                                            */
/* ------------------------------------------------------------------ */

// Un comprobante a la vez por emisor + punto de venta + tipo (la numeración es correlativa)
const colas = new Map<string, Promise<unknown>>();
function enSerie<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const previa = colas.get(clave) || Promise.resolve();
  const actual = previa.catch(() => {}).then(fn);
  colas.set(clave, actual.catch(() => {}));
  return actual;
}

export interface ResultadoWs extends FacturaResponse {
  modoConexion?: 'propio' | 'delegado';
  ambiente?: AmbienteArca;
  recuperado?: boolean;
}

async function autenticar(acc: ArcaAccountRecord): Promise<{ auth: AuthWsfe; cred: CredencialesWs; ambiente: AmbienteArca }> {
  const cred = resolverCredenciales(acc);
  if (!cred) throw new Error('La cuenta está configurada en modo navegador.');
  const ambiente = ambienteActual();
  const ticket = await obtenerTicket({ ambiente, certPem: cred.certPem, keyPem: cred.keyPem, servicio: 'wsfe' });
  return { auth: { ...ticket, cuit: acc.cuit }, cred, ambiente };
}

/** Traduce los errores de autorización más comunes de WSFEv1 a algo accionable. */
function explicarError(err: any, acc: ArcaAccountRecord, cred?: CredencialesWs): string {
  const msg = String(err?.message || err);
  if (err instanceof WsfeError && err.errores.some(e => e.codigo === '600')) {
    return cred?.modoUsado === 'delegado'
      ? `ARCA no autoriza a la plataforma (CUIT ${cred.certificado.cuit}) a facturar por ${acc.cuit}. Falta la delegación: ` +
        `desde la Clave Fiscal de ${acc.razonSocial || acc.cuit}, Administrador de Relaciones → Nueva Relación → WebServices → ` +
        `Facturación Electrónica → representante ${cred.certificado.cuit}. (${msg})`
      : `ARCA no autoriza este certificado para ${acc.cuit}. Revisá que esté asociado a "Facturación Electrónica" en el Administrador de Relaciones. (${msg})`;
  }
  if (err instanceof WsfeError && err.errores.some(e => e.codigo === '601')) {
    return `El CUIT ${acc.cuit} no está autorizado a usar el web service de factura electrónica. (${msg})`;
  }
  return msg;
}

export async function emitirPorWebService(acc: ArcaAccountRecord, datos: FacturaRequest): Promise<ResultadoWs> {
  const ptoVta = Number(acc.ws?.puntoVentaWs || datos.puntoVenta);
  let cred: CredencialesWs | undefined;
  let ambiente: AmbienteArca = ambienteActual();

  let prep: ComprobantePreparado;
  try {
    prep = prepararComprobante(datos, ptoVta);
  } catch (err: any) {
    return { success: false, message: `No se emitió el comprobante: ${err.message}` };
  }

  try {
    const a = await autenticar(acc);
    cred = a.cred;
    ambiente = a.ambiente;
    const auth = a.auth;
    logger.info('WSFE', `Emitiendo ${prep.tipo.nombre} por web service (${ambiente}, modo ${cred.modoUsado}) - CUIT ${acc.cuit} PV ${ptoVta} - total $${prep.solicitud.impTotal}`);

    const clave = `${ambiente}:${acc.cuit}:${ptoVta}:${prep.tipo.codigo}`;
    const resultado = await enSerie(clave, async () => {
      const ultimo = await ultimoAutorizado(ambiente, auth, ptoVta, prep.tipo.codigo);
      const numero = ultimo + 1;
      const solicitud: SolicitudCae = { ...prep.solicitud, cbteNro: numero };
      try {
        const r = await solicitarCae(ambiente, auth, solicitud);
        return { r, numero, recuperado: false };
      } catch (err) {
        if (!(err instanceof SoapNetworkError)) throw err;
        // Se cortó la conexión: el comprobante PUDO quedar emitido. Verificar antes de responder.
        logger.warn('WSFE', `Se cortó la conexión al pedir el CAE (${err.message}). Verificando en ARCA si se emitió el N° ${numero}...`);
        const ultimoNuevo = await ultimoAutorizado(ambiente, auth, ptoVta, prep.tipo.codigo);
        if (ultimoNuevo < numero) {
          throw new Error(`Se cortó la conexión con ARCA y el comprobante N° ${numero} NO llegó a emitirse. Podés reintentar.`);
        }
        const c = await consultarComprobante(ambiente, auth, ptoVta, prep.tipo.codigo, numero);
        if (c && c.cae && Math.abs(c.impTotal - solicitud.impTotal) < 0.01 && c.docNro.replace(/^0+/, '') === solicitud.docNro.replace(/^0+/, '')) {
          return { r: { resultado: 'A', cae: c.cae, caeVencimiento: c.caeVencimiento, cbteNro: numero, observaciones: [], errores: [], eventos: [] }, numero, recuperado: true };
        }
        throw new Error(
          `Se cortó la conexión con ARCA y no se pudo confirmar el comprobante N° ${numero}. ` +
          'ATENCIÓN: puede haber quedado emitido. Revisalo en ARCA antes de reintentar.'
        );
      }
    });

    const { r, numero, recuperado } = resultado;
    if (r.resultado !== 'A' || !r.cae) {
      const detalles = [...r.errores, ...r.observaciones].map(e => `[${e.codigo}] ${e.mensaje}`).join(' | ');
      logger.error('WSFE', `ARCA rechazó el comprobante: ${detalles || r.resultado}`);
      return { success: false, message: `ARCA rechazó el comprobante: ${detalles || `resultado ${r.resultado}`}`, modoConexion: cred.modoUsado, ambiente };
    }
    if (r.observaciones.length) {
      logger.warn('WSFE', `Observaciones de ARCA: ${r.observaciones.map(o => `[${o.codigo}] ${o.mensaje}`).join(' | ')}`);
    }

    const numeroFormateado = `${String(ptoVta).padStart(5, '0')}-${String(numero).padStart(8, '0')}`;
    logger.success('WSFE', `CAE ${r.cae} (vence ${r.caeVencimiento}) - ${prep.tipo.nombre} ${numeroFormateado}${ambiente === 'homologacion' ? ' [HOMOLOGACIÓN, sin validez fiscal]' : ''}`);

    // PDF (si falla, el comprobante igual está emitido)
    let pdfBase64: string | undefined;
    try {
      const pdf = await generarPdfComprobante({
        ambiente,
        letra: prep.tipo.letra,
        codigoTipo: prep.tipo.codigo,
        nombreTipo: prep.tipo.nombre,
        ptoVta,
        numero,
        fecha: aDdmmyyyy(prep.solicitud.cbteFch),
        emisor: {
          razonSocial: datos.razonSocialEmisor || acc.razonSocial || acc.cuit,
          cuit: acc.cuit,
          condicionIva: acc.ws?.condicionIvaEmisor || (prep.tipo.letra === 'C' ? 'Responsable Monotributo' : 'IVA Responsable Inscripto'),
          domicilio: acc.ws?.domicilioComercial,
          iibb: acc.ws?.iibb,
          inicioActividades: acc.ws?.inicioActividades,
        },
        receptor: {
          docTipoNombre: prep.doc.nombre,
          docNro: prep.doc.codigo === 99 ? '' : prep.doc.nro,
          nombre: datos.receptor.razonSocial || (prep.doc.codigo === 99 ? 'Consumidor Final' : ''),
          condicionIva: prep.condicionIvaReceptor.nombre,
          domicilio: datos.receptor.domicilio,
        },
        condicionVenta: datos.condicionVenta || 'Contado',
        periodo: prep.solicitud.fchServDesde ? {
          desde: aDdmmyyyy(prep.solicitud.fchServDesde),
          hasta: aDdmmyyyy(prep.solicitud.fchServHasta || ''),
          vtoPago: aDdmmyyyy(prep.solicitud.fchVtoPago || ''),
        } : undefined,
        items: prep.itemsPdf,
        totales: prep.totales,
        discriminaIva: prep.tipo.letra === 'A',
        cae: r.cae,
        caeVencimiento: aDdmmyyyy(r.caeVencimiento),
        qr: { tipoDocRec: prep.doc.codigo, nroDocRec: prep.doc.nro, fechaIso: aIso(prep.solicitud.cbteFch) },
      });
      pdfBase64 = pdf.toString('base64');
    } catch (errPdf: any) {
      logger.warn('WSFE', `El comprobante se emitió pero no se pudo generar el PDF: ${errPdf.message}`);
    }

    return {
      success: true,
      message: ambiente === 'homologacion'
        ? 'Comprobante autorizado en HOMOLOGACIÓN (prueba de ARCA, sin validez fiscal)'
        : (recuperado ? 'Comprobante emitido en ARCA (confirmado después de un corte de conexión)' : 'Comprobante emitido en ARCA'),
      cae: r.cae,
      caeVencimiento: aDdmmyyyy(r.caeVencimiento),
      comprobanteNro: numeroFormateado,
      puntoVenta: ptoVta,
      tipoComprobante: prep.tipo.nombre,
      totalImporte: prep.solicitud.impTotal,
      fechaEmision: aIso(prep.solicitud.cbteFch),
      pdfBufferBase64: pdfBase64,
      modoConexion: cred.modoUsado,
      ambiente,
      recuperado,
    };
  } catch (err: any) {
    const mensaje = explicarError(err, acc, cred);
    logger.error('WSFE', `Fallo en la emisión por web service: ${mensaje}`);
    const posibleEmision = /puede haber quedado emitido/i.test(mensaje);
    return {
      success: false,
      message: posibleEmision ? mensaje : `No se emitió el comprobante: ${mensaje}`,
      modoConexion: cred?.modoUsado,
      ambiente,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Prueba de conexión (no emite nada)                                 */
/* ------------------------------------------------------------------ */

export interface PasoPrueba { paso: string; ok: boolean; detalle: string }

export async function probarConexion(acc: ArcaAccountRecord): Promise<{ ok: boolean; ambiente: AmbienteArca; modo?: string; pasos: PasoPrueba[] }> {
  const ambiente = ambienteActual();
  const pasos: PasoPrueba[] = [];
  const terminar = (ok: boolean, modo?: string) => ({ ok, ambiente, modo, pasos });

  try {
    const d = await feDummy(ambiente);
    const ok = d.appServer === 'OK' && d.dbServer === 'OK' && d.authServer === 'OK';
    pasos.push({ paso: 'Servidores de ARCA', ok, detalle: `App ${d.appServer} · DB ${d.dbServer} · Auth ${d.authServer}` });
    if (!ok) return terminar(false);
  } catch (err: any) {
    pasos.push({ paso: 'Servidores de ARCA', ok: false, detalle: err.message });
    return terminar(false);
  }

  let cred: CredencialesWs | null;
  try {
    cred = resolverCredenciales(acc);
    if (!cred) {
      pasos.push({ paso: 'Certificado', ok: false, detalle: 'La cuenta está en modo navegador (Clave Fiscal); no usa web service.' });
      return terminar(false, 'navegador');
    }
    const c = cred.certificado;
    pasos.push({
      paso: 'Certificado',
      ok: !c.vencido,
      detalle: `${cred.modoUsado === 'propio' ? 'Propio' : 'De la plataforma (delegado)'} · CUIT ${c.cuit} · alias "${c.alias}" · vence ${c.validoHasta.slice(0, 10)} · ${cred.origen}`,
    });
    if (c.vencido) return terminar(false, cred.modoUsado);
  } catch (err: any) {
    pasos.push({ paso: 'Certificado', ok: false, detalle: err.message });
    return terminar(false);
  }

  let auth: AuthWsfe;
  try {
    const ticket = await obtenerTicket({ ambiente, certPem: cred.certPem, keyPem: cred.keyPem, servicio: 'wsfe' });
    auth = { ...ticket, cuit: acc.cuit };
    pasos.push({ paso: 'Autenticación (WSAA)', ok: true, detalle: `Ticket válido hasta ${new Date(ticket.expiracion).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}` });
  } catch (err: any) {
    pasos.push({ paso: 'Autenticación (WSAA)', ok: false, detalle: err.message });
    return terminar(false, cred.modoUsado);
  }

  const ptoVta = Number(acc.ws?.puntoVentaWs || 0);
  try {
    const pvs = await puntosDeVenta(ambiente, auth);
    pasos.push({
      paso: cred.modoUsado === 'delegado' ? 'Delegación y puntos de venta' : 'Puntos de venta',
      ok: true,
      detalle: pvs.length
        ? `ARCA permite facturar por ${acc.cuit}. Puntos de venta de web service: ${pvs.map(p => `${p.nro} (${p.emisionTipo}${p.bloqueado ? ', BLOQUEADO' : ''}${p.fechaBaja && p.fechaBaja !== 'NULL' ? ', dado de baja' : ''})`).join(', ')}`
        : `ARCA permite facturar por ${acc.cuit}, pero no tiene ningún punto de venta de web service dado de alta.`,
    });
    if (ptoVta) {
      const pv = pvs.find(p => p.nro === ptoVta);
      const okPv = ambiente === 'homologacion' ? true : !!pv && !pv.bloqueado;
      pasos.push({
        paso: `Punto de venta ${ptoVta}`,
        ok: okPv,
        detalle: pv
          ? `Habilitado para web service (${pv.emisionTipo}).`
          : ambiente === 'homologacion'
            ? 'En homologación ARCA acepta cualquier número de punto de venta.'
            : `No existe como punto de venta de web service para ${acc.cuit}. Crealo en "Administración de puntos de venta y domicilios".`,
      });
      if (!okPv) return terminar(false, cred.modoUsado);
      const ultimoC = await ultimoAutorizado(ambiente, auth, ptoVta, 11).catch(() => null);
      if (ultimoC !== null) pasos.push({ paso: 'Último comprobante (Factura C)', ok: true, detalle: `N° ${ultimoC}` });
    } else {
      pasos.push({ paso: 'Punto de venta', ok: false, detalle: 'Falta cargar el punto de venta de web service en la configuración de la cuenta.' });
      return terminar(false, cred.modoUsado);
    }
  } catch (err: any) {
    pasos.push({ paso: cred.modoUsado === 'delegado' ? 'Delegación' : 'Autorización del CUIT', ok: false, detalle: explicarError(err, acc, cred) });
    return terminar(false, cred.modoUsado);
  }

  return terminar(true, cred.modoUsado);
}

export function estadoPlataforma() {
  const p = credencialesPlataforma();
  let certificado: InfoCertificado | null = null;
  let error = '';
  if (p) {
    try { certificado = leerCertificado(p.certPem); } catch (e: any) { error = e.message; }
  }
  return { ambiente: ambienteActual(), configurado: !!p && !error, certificado, error, conceptos: CONCEPTO_NOMBRE };
}
