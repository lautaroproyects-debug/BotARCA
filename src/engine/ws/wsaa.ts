import { db } from '../../database.js';
import { logger } from '../../services/logger.js';
import { firmarCms, leerCertificado } from './certificados.js';
import { soapCall, SoapError, parseXml, escapeXml } from './soap.js';

export type AmbienteArca = 'homologacion' | 'produccion';

const WSAA_URL: Record<AmbienteArca, string> = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

export interface TicketAcceso {
  token: string;
  sign: string;
  expiracion: string; // ISO
}

const enCurso = new Map<string, Promise<TicketAcceso>>();

function claveCache(ambiente: AmbienteArca, huella: string, servicio: string) {
  return `${ambiente}:${servicio}:${huella}`;
}

function construirTra(servicio: string): string {
  const ahora = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<loginTicketRequest version="1.0"><header>` +
    `<uniqueId>${Math.floor(ahora / 1000)}</uniqueId>` +
    `<generationTime>${iso(ahora - 10 * 60 * 1000)}</generationTime>` +
    `<expirationTime>${iso(ahora + 10 * 60 * 1000)}</expirationTime>` +
    `</header><service>${escapeXml(servicio)}</service></loginTicketRequest>`;
}

/**
 * Devuelve un ticket de acceso (token + sign) para el certificado dado.
 *
 * WSAA NO entrega un ticket nuevo mientras el anterior siga vigente (~12 h): devuelve el
 * error "coe.alreadyAuthenticated". Por eso el ticket se guarda en la base y se reutiliza.
 */
export async function obtenerTicket(params: {
  ambiente: AmbienteArca;
  certPem: string;
  keyPem: string;
  servicio?: string;
}): Promise<TicketAcceso> {
  const servicio = params.servicio || 'wsfe';
  const info = leerCertificado(params.certPem);
  if (info.vencido) {
    throw new Error(`El certificado "${info.alias}" (CUIT ${info.cuit}) venció el ${info.validoHasta.slice(0, 10)}. Generá uno nuevo en ARCA.`);
  }
  const clave = claveCache(params.ambiente, info.huella, servicio);

  const guardado = db.getWsaaTicket(clave);
  // Margen de 5 minutos antes del vencimiento
  if (guardado && new Date(guardado.expiracion).getTime() - Date.now() > 5 * 60 * 1000) {
    return guardado;
  }

  const pendiente = enCurso.get(clave);
  if (pendiente) return pendiente;

  const promesa = (async () => {
    logger.info('WSAA', `Pidiendo ticket de acceso a ARCA (${params.ambiente}, servicio ${servicio}, certificado CUIT ${info.cuit})...`);
    const cms = firmarCms(construirTra(servicio), params.certPem, params.keyPem);
    const envelope =
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
      `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;

    let body: any;
    try {
      body = await soapCall(WSAA_URL[params.ambiente], '""', envelope, 45000);
    } catch (err: any) {
      if (err instanceof SoapError && /alreadyAuthenticated|ya posee un TA/i.test(`${err.faultCode} ${err.message}`)) {
        throw new Error(
          'ARCA ya entregó un ticket de acceso para este certificado y todavía está vigente, pero el sistema lo perdió ' +
          '(por ejemplo, por un reinicio del servidor). ARCA no da otro hasta que venza: probá de nuevo en unas horas ' +
          '(como máximo 12 h desde el último uso).'
        );
      }
      if (err instanceof SoapError && /cms\.cert\.untrusted|cms\.cert\.invalid|cms\.cert\.blacklist|no.*confiable|bloqueado/i.test(`${err.faultCode} ${err.message}`)) {
        throw new Error(`ARCA no reconoce el certificado en ${params.ambiente}: ${err.message}. ¿Es un certificado de ${params.ambiente === 'homologacion' ? 'homologación (WSASS)' : 'producción'}?`);
      }
      if (err instanceof SoapError && /notAuthorized|no autorizado|ns1:cms\.sign|computador no autorizado/i.test(`${err.faultCode} ${err.message}`)) {
        throw new Error(`El certificado no está autorizado para el servicio "${servicio}" en ARCA: ${err.message}. Asocialo a "Facturación Electrónica" en el Administrador de Relaciones.`);
      }
      throw err;
    }

    const xmlRespuesta = String(body?.loginCmsResponse?.loginCmsReturn || '');
    const resp = parseXml(xmlRespuesta)?.loginTicketResponse;
    const token = resp?.credentials?.token;
    const sign = resp?.credentials?.sign;
    const expiracion = resp?.header?.expirationTime;
    if (!token || !sign || !expiracion) {
      throw new Error('WSAA respondió sin token/sign. Revisá el certificado.');
    }
    const ticket: TicketAcceso = { token: String(token), sign: String(sign), expiracion: new Date(String(expiracion)).toISOString() };
    db.setWsaaTicket(clave, ticket);
    logger.success('WSAA', `Ticket de acceso obtenido. Vence: ${ticket.expiracion}`);
    return ticket;
  })();

  enCurso.set(clave, promesa);
  try {
    return await promesa;
  } finally {
    enCurso.delete(clave);
  }
}
