import { db, ArcaAccountRecord } from '../database.js';
import { decrypt } from '../crypto.js';
import { logger } from './logger.js';
import { comprobantesService } from './comprobantesService.js';
import { arcaSession, ArcaSessionResult } from '../engine/arcaSession.js';
import { facturacionModule, FacturaRequest, FacturaResponse } from '../engine/modules/facturacion.js';
import { emitirPorWebService, ResultadoWs } from '../engine/ws/wsfeEmisor.js';

/**
 * Punto único de emisión. Según la configuración de la cuenta emisora usa:
 * - web service de ARCA (modos auto / propio / delegado), o
 * - el navegador con Clave Fiscal (modo navegador, solo si se eligió a mano).
 */

export interface OpcionesEmision {
  /** Para lotes en modo navegador: reutilizar una sesión ya abierta. */
  obtenerSesionNavegador?: (acc: ArcaAccountRecord | undefined, cuit: string) => Promise<ArcaSessionResult>;
  /** Usuario que emite: el comprobante queda en su repositorio y cuenta para su límite mensual. */
  usuarioId?: string;
}

export type ResultadoEmision = ResultadoWs & { via: 'webservice' | 'navegador'; comprobanteId?: string };

export function cuentaEmisora(datos: FacturaRequest): { cuit: string; acc?: ArcaAccountRecord } {
  // El CUIT siempre lo decide la ruta (según el usuario); no hay un "CUIT global"
  const cuit = String(datos.cuitEmisor || '').replace(/\D/g, '');
  return { cuit, acc: cuit ? db.getAccountRecord(cuit) : undefined };
}

export function modoDeCuenta(acc?: ArcaAccountRecord): 'webservice' | 'navegador' {
  return !acc || (acc.ws?.modo || 'auto') === 'navegador' ? 'navegador' : 'webservice';
}

export async function emitirComprobante(datos: FacturaRequest, opciones: OpcionesEmision = {}): Promise<ResultadoEmision> {
  const { cuit, acc } = cuentaEmisora(datos);
  if (!cuit) {
    return { success: false, message: 'No hay un CUIT emisor seleccionado. Configuralo en "Cuentas y CUITs".', via: 'webservice' };
  }
  const datosCompletos: FacturaRequest = {
    ...datos,
    cuitEmisor: cuit,
    razonSocialEmisor: datos.razonSocialEmisor || acc?.razonSocial,
  };

  if (modoDeCuenta(acc) === 'webservice') {
    const r: ResultadoEmision = { ...(await emitirPorWebService(acc!, datosCompletos)), via: 'webservice' };
    if (r.success) await registrarYEnviar(r, datosCompletos, opciones.usuarioId);
    return r;
  }

  // Modo navegador (flujo con Clave Fiscal y Chromium)
  logger.info('EMISION', `La cuenta ${cuit} está en modo navegador: se emite por "Comprobantes en línea".`);
  let sesion: ArcaSessionResult;
  if (opciones.obtenerSesionNavegador) {
    sesion = await opciones.obtenerSesionNavegador(acc, cuit);
  } else {
    const credLogin = credencialesNavegador(acc, cuit);
    if (!credLogin) {
      return { success: false, message: `La cuenta ${cuit} está en modo navegador pero no tiene Clave Fiscal cargada.`, via: 'navegador' };
    }
    sesion = await arcaSession.login(credLogin.cuit, credLogin.claveFiscal);
  }
  if (!sesion.success) {
    return { success: false, message: `Fallo al iniciar sesión en ARCA: ${sesion.message}`, via: 'navegador' };
  }
  const rNav: ResultadoEmision = { ...(await facturacionModule.emitirFactura(sesion, datosCompletos)), via: 'navegador' };
  // El flujo del navegador ya manda su propio mail con el PDF de ARCA: acá solo se registra
  if (rNav.success) rNav.comprobanteId = comprobantesService.guardarEmitido(datosCompletos, rNav, opciones.usuarioId).id;
  return rNav;
}

/** CUIT + Clave Fiscal para el login del modo navegador (el representante, si lo hay). */
export function credencialesNavegador(acc: ArcaAccountRecord | undefined, cuit: string): { cuit: string; claveFiscal: string } | null {
  const creds = db.getCredentials();
  const clave = acc?.encryptedClaveFiscal ? decrypt(acc.encryptedClaveFiscal) : (creds.cuit === cuit ? creds.claveFiscal : '');
  if (!clave) return null;
  return { cuit: acc?.cuitRepresentante || cuit, claveFiscal: clave };
}

/**
 * Guarda el comprobante en el repositorio y, si el receptor tiene email, se lo manda.
 * Nunca hace fallar la emisión: el comprobante ya está autorizado en ARCA.
 */
async function registrarYEnviar(r: ResultadoEmision, datos: FacturaRequest, usuarioId?: string) {
  const rec = comprobantesService.guardarEmitido(datos, r, usuarioId);
  r.comprobanteId = rec.id;
  if (!datos.receptor.email) return;
  if (r.ambiente === 'homologacion') {
    logger.info('EMISION', 'Homologación: no se manda el mail al receptor (es un comprobante de prueba). Se puede enviar a mano desde Comprobantes.');
    return;
  }
  const envio = await comprobantesService.enviarPorMail(rec.id, datos.receptor.email);
  r.emailEnviado = envio.success;
}
