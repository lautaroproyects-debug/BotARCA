import { soapCall, comoLista, escapeXml } from './soap.js';
import { AmbienteArca, TicketAcceso } from './wsaa.js';

/**
 * Cliente del web service de Factura Electrónica de ARCA (WSFEv1).
 * Manual: https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp
 */

const WSFE_URL: Record<AmbienteArca, string> = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};
const NS = 'http://ar.gov.afip.dif.FEV1/';

export interface AuthWsfe extends TicketAcceso {
  /** CUIT que factura (el representado). Con delegación es distinto al CUIT del certificado. */
  cuit: string;
}

export interface ErrorArca { codigo: string; mensaje: string }

export class WsfeError extends Error {
  constructor(message: string, public readonly errores: ErrorArca[] = []) {
    super(message);
  }
}

export interface IvaAlicuota { id: number; baseImp: number; importe: number }
export interface CbteAsociado { tipo: number; ptoVta: number; nro: number; cuit?: string; fecha?: string }

export interface SolicitudCae {
  ptoVta: number;
  cbteTipo: number;
  concepto: 1 | 2 | 3;
  docTipo: number;
  docNro: string;
  cbteNro: number;
  cbteFch: string; // yyyymmdd
  impTotal: number;
  impTotConc: number;
  impNeto: number;
  impOpEx: number;
  impIva: number;
  impTrib: number;
  fchServDesde?: string;
  fchServHasta?: string;
  fchVtoPago?: string;
  condicionIvaReceptorId: number;
  iva?: IvaAlicuota[];
  cbtesAsoc?: CbteAsociado[];
}

export interface RespuestaCae {
  resultado: 'A' | 'R' | 'P' | string;
  cae: string;
  caeVencimiento: string; // yyyymmdd
  cbteNro: number;
  observaciones: ErrorArca[];
  errores: ErrorArca[];
  eventos: ErrorArca[];
}

function authXml(auth: AuthWsfe) {
  return `<ar:Auth><ar:Token>${escapeXml(auth.token)}</ar:Token><ar:Sign>${escapeXml(auth.sign)}</ar:Sign><ar:Cuit>${escapeXml(auth.cuit)}</ar:Cuit></ar:Auth>`;
}

function envelope(metodo: string, interior: string) {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">` +
    `<soap:Body><ar:${metodo}>${interior}</ar:${metodo}></soap:Body></soap:Envelope>`;
}

async function llamar(ambiente: AmbienteArca, metodo: string, interior: string, timeoutMs?: number) {
  const body = await soapCall(WSFE_URL[ambiente], `"${NS}${metodo}"`, envelope(metodo, interior), timeoutMs);
  return body?.[`${metodo}Response`]?.[`${metodo}Result`];
}

function leerErrores(nodo: any, clave: 'Errors' | 'Observaciones' | 'Events'): ErrorArca[] {
  const hijo = clave === 'Errors' ? 'Err' : clave === 'Events' ? 'Evt' : 'Obs';
  return comoLista(nodo?.[clave]?.[hijo]).map((e: any) => ({ codigo: String(e.Code ?? ''), mensaje: String(e.Msg ?? '') }));
}

function lanzarSiHayErrores(resultado: any, contexto: string) {
  const errores = leerErrores(resultado, 'Errors');
  if (errores.length) {
    throw new WsfeError(`${contexto}: ${errores.map(e => `[${e.codigo}] ${e.mensaje}`).join(' | ')}`, errores);
  }
}

const n2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/** Estado de los servidores de ARCA. No requiere autenticación. */
export async function feDummy(ambiente: AmbienteArca) {
  const r = await llamar(ambiente, 'FEDummy', '', 20000);
  return { appServer: String(r?.AppServer || ''), dbServer: String(r?.DbServer || ''), authServer: String(r?.AuthServer || '') };
}

export async function ultimoAutorizado(ambiente: AmbienteArca, auth: AuthWsfe, ptoVta: number, cbteTipo: number): Promise<number> {
  const r = await llamar(ambiente, 'FECompUltimoAutorizado',
    `${authXml(auth)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`);
  lanzarSiHayErrores(r, 'ARCA rechazó la consulta del último comprobante');
  return parseInt(String(r?.CbteNro ?? '0'), 10) || 0;
}

export interface PuntoVentaArca { nro: number; emisionTipo: string; bloqueado: boolean; fechaBaja: string }

export async function puntosDeVenta(ambiente: AmbienteArca, auth: AuthWsfe): Promise<PuntoVentaArca[]> {
  const r = await llamar(ambiente, 'FEParamGetPtosVenta', authXml(auth));
  const errores = leerErrores(r, 'Errors');
  // 602 = "Sin resultados": el CUIT no tiene ningún punto de venta de web service
  if (errores.some(e => e.codigo === '602')) return [];
  lanzarSiHayErrores(r, 'ARCA rechazó la consulta de puntos de venta');
  return comoLista(r?.ResultGet?.PtoVenta).map((p: any) => ({
    nro: parseInt(String(p.Nro), 10),
    emisionTipo: String(p.EmisionTipo || ''),
    bloqueado: String(p.Bloqueado || '').toUpperCase() === 'S',
    fechaBaja: String(p.FchBaja || ''),
  }));
}

export interface ComprobanteConsultado {
  cbteNro: number; cae: string; caeVencimiento: string; impTotal: number; docNro: string; cbteFch: string; resultado: string;
}

/** Consulta un comprobante ya emitido (sirve para recuperar el CAE si se cortó la conexión). */
export async function consultarComprobante(ambiente: AmbienteArca, auth: AuthWsfe, ptoVta: number, cbteTipo: number, cbteNro: number): Promise<ComprobanteConsultado | null> {
  const r = await llamar(ambiente, 'FECompConsultar',
    `${authXml(auth)}<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${cbteNro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`);
  const errores = leerErrores(r, 'Errors');
  if (errores.some(e => e.codigo === '602')) return null;
  lanzarSiHayErrores(r, 'ARCA rechazó la consulta del comprobante');
  const g = r?.ResultGet;
  if (!g) return null;
  return {
    cbteNro: parseInt(String(g.CbteDesde), 10),
    cae: String(g.CodAutorizacion || ''),
    caeVencimiento: String(g.FchVto || ''),
    impTotal: parseFloat(String(g.ImpTotal || '0')),
    docNro: String(g.DocNro || ''),
    cbteFch: String(g.CbteFch || ''),
    resultado: String(g.Resultado || ''),
  };
}

export function construirDetalleXml(s: SolicitudCae): string {
  const opt = (tag: string, v?: string) => (v ? `<ar:${tag}>${escapeXml(v)}</ar:${tag}>` : '');
  const iva = s.iva && s.iva.length
    ? `<ar:Iva>${s.iva.map(a => `<ar:AlicIva><ar:Id>${a.id}</ar:Id><ar:BaseImp>${n2(a.baseImp)}</ar:BaseImp><ar:Importe>${n2(a.importe)}</ar:Importe></ar:AlicIva>`).join('')}</ar:Iva>`
    : '';
  const asoc = s.cbtesAsoc && s.cbtesAsoc.length
    ? `<ar:CbtesAsoc>${s.cbtesAsoc.map(c =>
        `<ar:CbteAsoc><ar:Tipo>${c.tipo}</ar:Tipo><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:Nro>${c.nro}</ar:Nro>${opt('Cuit', c.cuit)}${opt('CbteFch', c.fecha)}</ar:CbteAsoc>`).join('')}</ar:CbtesAsoc>`
    : '';
  return `<ar:FECAEDetRequest>` +
    `<ar:Concepto>${s.concepto}</ar:Concepto>` +
    `<ar:DocTipo>${s.docTipo}</ar:DocTipo>` +
    `<ar:DocNro>${escapeXml(s.docNro)}</ar:DocNro>` +
    `<ar:CbteDesde>${s.cbteNro}</ar:CbteDesde>` +
    `<ar:CbteHasta>${s.cbteNro}</ar:CbteHasta>` +
    `<ar:CbteFch>${s.cbteFch}</ar:CbteFch>` +
    `<ar:ImpTotal>${n2(s.impTotal)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${n2(s.impTotConc)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${n2(s.impNeto)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${n2(s.impOpEx)}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${n2(s.impTrib)}</ar:ImpTrib>` +
    `<ar:ImpIVA>${n2(s.impIva)}</ar:ImpIVA>` +
    opt('FchServDesde', s.fchServDesde) +
    opt('FchServHasta', s.fchServHasta) +
    opt('FchVtoPago', s.fchVtoPago) +
    `<ar:MonId>PES</ar:MonId>` +
    `<ar:MonCotiz>1</ar:MonCotiz>` +
    asoc +
    iva +
    `<ar:CondicionIVAReceptorId>${s.condicionIvaReceptorId}</ar:CondicionIVAReceptorId>` +
    `</ar:FECAEDetRequest>`;
}

/**
 * Pide el CAE de UN comprobante. Puede lanzar SoapNetworkError: en ese caso el pedido
 * PUDO haber llegado a ARCA y hay que verificar con consultarComprobante antes de reintentar.
 */
export async function solicitarCae(ambiente: AmbienteArca, auth: AuthWsfe, s: SolicitudCae): Promise<RespuestaCae> {
  const interior = `${authXml(auth)}<ar:FeCAEReq>` +
    `<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${s.ptoVta}</ar:PtoVta><ar:CbteTipo>${s.cbteTipo}</ar:CbteTipo></ar:FeCabReq>` +
    `<ar:FeDetReq>${construirDetalleXml(s)}</ar:FeDetReq>` +
    `</ar:FeCAEReq>`;
  const r = await llamar(ambiente, 'FECAESolicitar', interior, 90000);
  const det = comoLista(r?.FeDetResp?.FECAEDetResponse)[0] || {};
  return {
    resultado: String(det.Resultado || r?.FeCabResp?.Resultado || ''),
    cae: String(det.CAE || ''),
    caeVencimiento: String(det.CAEFchVto || ''),
    cbteNro: parseInt(String(det.CbteDesde || s.cbteNro), 10),
    observaciones: leerErrores(det, 'Observaciones'),
    errores: leerErrores(r, 'Errors'),
    eventos: leerErrores(r, 'Events'),
  };
}
