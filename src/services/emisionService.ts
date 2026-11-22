import { db, ArcaAccountRecord } from '../database.js';
import { decrypt } from '../crypto.js';
import { logger } from './logger.js';
import { storageService } from './storageService.js';
import { mailService } from './mailService.js';
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
}

export type ResultadoEmision = ResultadoWs & { via: 'webservice' | 'navegador' };

export function cuentaEmisora(datos: FacturaRequest): { cuit: string; acc?: ArcaAccountRecord } {
  const cuit = String(datos.cuitEmisor || db.getCredentials().cuit || '').replace(/\D/g, '');
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
    const r = await emitirPorWebService(acc!, datosCompletos);
    if (r.success) await publicarComprobante(r, datosCompletos);
    return { ...r, via: 'webservice' };
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
  const r: FacturaResponse = await facturacionModule.emitirFactura(sesion, datosCompletos);
  return { ...r, via: 'navegador' };
}

/** CUIT + Clave Fiscal para el login del modo navegador (el representante, si lo hay). */
export function credencialesNavegador(acc: ArcaAccountRecord | undefined, cuit: string): { cuit: string; claveFiscal: string } | null {
  const creds = db.getCredentials();
  const clave = acc?.encryptedClaveFiscal ? decrypt(acc.encryptedClaveFiscal) : (creds.cuit === cuit ? creds.claveFiscal : '');
  if (!clave) return null;
  return { cuit: acc?.cuitRepresentante || cuit, claveFiscal: clave };
}

/** Sube el PDF a Storage y lo manda por mail al receptor (si tiene email). Nunca hace fallar la emisión. */
async function publicarComprobante(r: ResultadoWs, datos: FacturaRequest) {
  if (!r.pdfBufferBase64) return;
  const cuit = datos.cuitEmisor || '';
  try {
    const up = await storageService.uploadAttachment({
      filename: `factura_${cuit}_${r.comprobanteNro}.pdf`,
      base64: r.pdfBufferBase64,
      contentType: 'application/pdf',
      cuit,
      isPublic: true,
    });
    if (up.success && up.publicUrl) r.pdfUrl = up.publicUrl;
  } catch (err: any) {
    logger.warn('EMISION', `No se pudo subir el PDF a Storage: ${err.message}`);
  }

  if (!datos.receptor.email) return;
  if (r.ambiente === 'homologacion') {
    logger.info('EMISION', 'Homologación: no se envía el mail al receptor (el comprobante es de prueba).');
    return;
  }
  try {
    const mail = await mailService.sendMail({
      to: datos.receptor.email,
      subject: `Comprobante Electrónico ${r.tipoComprobante} N° ${r.comprobanteNro}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
          <h2 style="color: #4f46e5;">Comprobante Electrónico Autorizado</h2>
          <p>Estimado/a <strong>${datos.receptor.razonSocial || 'Cliente'}</strong>,</p>
          <p>${datos.razonSocialEmisor || 'Le'} emitió un comprobante a su nombre:</p>
          <ul>
            <li><strong>Tipo:</strong> ${r.tipoComprobante}</li>
            <li><strong>Número:</strong> ${r.comprobanteNro}</li>
            <li><strong>CAE:</strong> ${r.cae} (Vto: ${r.caeVencimiento})</li>
            <li><strong>Importe Total:</strong> $${(r.totalImporte || 0).toFixed(2)}</li>
          </ul>
          <p>Adjuntamos el comprobante en PDF.</p>
        </div>`,
      attachments: [{ filename: `${r.comprobanteNro}.pdf`, content: r.pdfBufferBase64, contentType: 'application/pdf' }],
    });
    r.emailEnviado = mail.success;
  } catch (err: any) {
    logger.warn('EMISION', `No se pudo enviar el mail al receptor: ${err.message}`);
  }
}
