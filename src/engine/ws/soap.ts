import https from 'https';
import { XMLParser } from 'fast-xml-parser';

/**
 * Cliente SOAP mínimo para los web services de ARCA (WSAA y WSFEv1).
 *
 * Los servidores de ARCA usan parámetros TLS viejos (claves DH chicas). Node 17+ los
 * rechaza con "dh key too small", por eso se baja el nivel de seguridad de OpenSSL
 * SOLO para estas conexiones.
 */
const agent = new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1', keepAlive: true });

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // CAE, CUIT y números de comprobante quedan como texto (sin perder ceros)
  trimValues: true,
});

export class SoapError extends Error {
  constructor(message: string, public readonly faultCode?: string, public readonly httpStatus?: number) {
    super(message);
  }
}

/** Error de red (timeout, conexión cortada): el pedido PUDO haber llegado a ARCA. */
export class SoapNetworkError extends Error {}

export function escapeXml(valor: string | number): string {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

export async function soapCall(url: string, soapAction: string, envelope: string, timeoutMs = 60000): Promise<any> {
  const texto = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      agent,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(envelope, 'utf8'),
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      res.on('error', err => reject(new SoapNetworkError(`Conexión cortada con ARCA: ${err.message}`)));
    });
    req.on('timeout', () => req.destroy(new SoapNetworkError(`ARCA no respondió en ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', err => reject(err instanceof SoapNetworkError ? err : new SoapNetworkError(`Error de red con ARCA: ${err.message}`)));
    req.end(envelope);
  });

  let doc: any;
  try {
    doc = parseXml(texto.body);
  } catch {
    throw new SoapError(`Respuesta inválida de ARCA (HTTP ${texto.status}).`, undefined, texto.status);
  }
  const body = doc?.Envelope?.Body;
  if (!body) {
    throw new SoapError(`Respuesta inesperada de ARCA (HTTP ${texto.status}).`, undefined, texto.status);
  }
  if (body.Fault) {
    const f = body.Fault;
    throw new SoapError(String(f.faultstring || f.Reason?.Text || 'Error SOAP de ARCA'), String(f.faultcode || ''), texto.status);
  }
  return body;
}

/** Normaliza un nodo que puede venir como objeto único o como lista. */
export function comoLista<T = any>(valor: any): T[] {
  if (valor === undefined || valor === null || valor === '') return [];
  return Array.isArray(valor) ? valor : [valor];
}
