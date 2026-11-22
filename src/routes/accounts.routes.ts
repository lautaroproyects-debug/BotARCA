import { Router, Request, Response } from 'express';
import { db, ModoConexionArca } from '../database.js';
import { supabase } from '../services/supabase.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireAdmin } from '../middleware/auth.middleware.js';
import { generarCsr, leerCertificado, normalizarPem, verificarParClave } from '../engine/ws/certificados.js';
import { estadoPlataforma, probarConexion } from '../engine/ws/wsfeEmisor.js';
import { sanearDiseno, DISENO_GENERICO, ASUNTO_MAIL_DEFAULT, CUERPO_MAIL_DEFAULT } from '../engine/ws/diseno.js';
import { generarPdfComprobante, datosEjemplo } from '../engine/ws/pdfComprobante.js';

const router = Router();

// Listar todas las cuentas CUIT
router.get('/', (req: Request, res: Response) => {
  const accounts = db.getAccounts();
  const currentCreds = db.getCredentials();
  res.json({
    success: true,
    activeCuit: currentCreds.cuit,
    accounts,
  });
});

// Agregar o actualizar cuenta CUIT
router.post('/', async (req: Request, res: Response) => {
  const { cuit, claveFiscal, puntoVentaDefault, razonSocial, cuitRepresentante, nombreRepresentante, emailNotificaciones } = req.body;

  if (!cuit) {
    return res.status(400).json({ success: false, message: 'El CUIT de la empresa o cliente es obligatorio.' });
  }

  const cleanCuit = cuit.replace(/\D/g, '');
  if (cleanCuit.length !== 11) {
    return res.status(400).json({ success: false, message: 'El CUIT debe tener 11 dígitos numéricos.' });
  }

  db.saveAccount({
    cuit: cleanCuit,
    razonSocial,
    cuitRepresentante,
    nombreRepresentante,
    emailNotificaciones,
    claveFiscal,
    puntoVentaDefault: Number(puntoVentaDefault) || 1,
  });

  // Sincronizar en Supabase cuentas_arca
  const supa = supabase.getClient();
  if (supa) {
    try {
      const encrypted = db.data.credentials.encryptedClaveFiscal;
      await supa.from('cuentas_arca').upsert({
        cuit: cleanCuit,
        razon_social: razonSocial || `Cuenta ${cleanCuit}`,
        encrypted_clave_fiscal: encrypted,
        punto_venta_default: Number(puntoVentaDefault) || 1,
        activa: true,
      }, { onConflict: 'cuit' });
    } catch (e) {}
  }

  res.json({
    success: true,
    message: 'Cuenta fiscal guardada y activada correctamente.',
    cuit: cleanCuit,
    accounts: db.getAccounts(),
  });
});

// Cambiar cuenta CUIT activa
router.post('/switch', (req: Request, res: Response) => {
  const { cuit } = req.body;
  if (!cuit) return res.status(400).json({ success: false, message: 'Falta especificar el CUIT.' });

  const switched = db.switchActiveAccount(cuit.replace(/\D/g, ''));
  if (switched) {
    res.json({ success: true, message: `Cuenta activa cambiada a CUIT ${cuit}.`, activeCuit: cuit });
  } else {
    res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  }
});

// ------------------------------------------------------------------
// WEB SERVICE DE ARCA (WSFEv1): modo de conexión, certificados y prueba
// ------------------------------------------------------------------

const MODOS: ModoConexionArca[] = ['auto', 'propio', 'delegado', 'navegador'];

// Estado general: ambiente (homologación/producción) y certificado de la plataforma
router.get('/ws/estado', (req: Request, res: Response) => {
  const e = estadoPlataforma();
  res.json({
    success: true,
    ambiente: e.ambiente,
    plataforma: {
      configurado: e.configurado,
      error: e.error || undefined,
      cuit: e.certificado?.cuit,
      alias: e.certificado?.alias,
      vence: e.certificado?.validoHasta,
      vencido: e.certificado?.vencido,
    },
  });
});

// Configuración de la cuenta (modo, punto de venta de web service, datos del emisor para el PDF)
router.put('/:cuit/ws', requireAdmin, (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });

  const { modo, puntoVentaWs, condicionIvaEmisor, domicilioComercial, iibb, inicioActividades } = req.body || {};
  if (modo !== undefined && !MODOS.includes(modo)) {
    return res.status(400).json({ success: false, message: `Modo inválido. Opciones: ${MODOS.join(', ')}.` });
  }
  const pv = puntoVentaWs === undefined || puntoVentaWs === '' ? undefined : parseInt(String(puntoVentaWs), 10);
  if (pv !== undefined && (!Number.isInteger(pv) || pv < 1 || pv > 99998)) {
    return res.status(400).json({ success: false, message: 'El punto de venta debe ser un número entre 1 y 99998.' });
  }

  db.updateAccountWs(acc.cuit, {
    ...(modo !== undefined ? { modo } : {}),
    ...(puntoVentaWs !== undefined ? { puntoVentaWs: pv } : {}),
    ...(condicionIvaEmisor !== undefined ? { condicionIvaEmisor: String(condicionIvaEmisor).trim() || undefined } : {}),
    ...(domicilioComercial !== undefined ? { domicilioComercial: String(domicilioComercial).trim() || undefined } : {}),
    ...(iibb !== undefined ? { iibb: String(iibb).trim() || undefined } : {}),
    ...(inicioActividades !== undefined ? { inicioActividades: String(inicioActividades).trim() || undefined } : {}),
  });
  res.json({ success: true, message: 'Configuración de web service guardada.', accounts: db.getAccounts() });
});

// Genera la clave privada (queda cifrada en el servidor) y el pedido de certificado (CSR) para subir a ARCA
router.post('/:cuit/ws/csr', requireAdmin, (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  try {
    const alias = String(req.body?.alias || `botarca${acc.cuit.slice(-4)}`);
    const { keyPem, csrPem } = generarCsr({ cuit: acc.cuit, organizacion: acc.razonSocial || acc.cuit, alias });
    db.updateAccountWs(acc.cuit, { csrPendientePem: csrPem, encryptedKeyPendiente: encrypt(keyPem) });
    res.json({ success: true, csrPem, alias, message: 'Pedido de certificado generado. Subilo a ARCA y después cargá acá el certificado (.crt) que te devuelve.' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Carga el certificado propio. La clave privada puede venir en el pedido o ser la del CSR generado en el panel.
router.post('/:cuit/ws/certificado', requireAdmin, (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });

  const certPem = normalizarPem(req.body?.certPem);
  if (!certPem) return res.status(400).json({ success: false, message: 'Pegá el contenido del certificado (.crt).' });

  let info;
  try {
    info = leerCertificado(certPem);
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (info.cuit !== acc.cuit) {
    return res.status(400).json({
      success: false,
      message: `El certificado es del CUIT ${info.cuit || '(desconocido)'} y la cuenta es ${acc.cuit}. Para facturar por ${acc.cuit} con un certificado de otro CUIT, usá el modo "Delegado".`,
    });
  }
  if (info.vencido) return res.status(400).json({ success: false, message: `El certificado venció el ${info.validoHasta.slice(0, 10)}.` });

  const keyEnviada = normalizarPem(req.body?.keyPem);
  const keyPendiente = acc.ws?.encryptedKeyPendiente ? normalizarPem(decrypt(acc.ws.encryptedKeyPendiente)) : '';
  const keyPem = keyEnviada || keyPendiente;
  if (!keyPem) {
    return res.status(400).json({ success: false, message: 'Falta la clave privada: generá el pedido (CSR) desde el panel o pegá la clave (.key) junto con el certificado.' });
  }
  if (!verificarParClave(certPem, keyPem)) {
    return res.status(400).json({
      success: false,
      message: keyEnviada
        ? 'La clave privada no corresponde a este certificado.'
        : 'Este certificado no corresponde al último pedido (CSR) generado en el panel. Pegá también su clave privada.',
    });
  }

  db.updateAccountWs(acc.cuit, {
    certPropioPem: certPem,
    encryptedKeyPropio: encrypt(keyPem),
    csrPendientePem: undefined,
    encryptedKeyPendiente: undefined,
  });
  res.json({
    success: true,
    message: `Certificado cargado: alias "${info.alias}", vence el ${info.validoHasta.slice(0, 10)}.`,
    accounts: db.getAccounts(),
  });
});

router.delete('/:cuit/ws/certificado', requireAdmin, (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  db.updateAccountWs(acc.cuit, { certPropioPem: undefined, encryptedKeyPropio: undefined });
  res.json({ success: true, message: 'Certificado propio eliminado.', accounts: db.getAccounts() });
});

// Prueba la conexión completa SIN emitir nada (servidores, certificado, ticket, delegación, punto de venta)
router.post('/:cuit/ws/probar', async (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  try {
    const r = await probarConexion(acc);
    const ultimo = r.pasos[r.pasos.length - 1];
    db.updateAccountWs(acc.cuit, {
      ultimaPrueba: { fecha: new Date().toISOString(), ok: r.ok, modo: r.modo, mensaje: ultimo ? `${ultimo.paso}: ${ultimo.detalle}` : '' },
    });
    res.json({ success: true, ...r });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ------------------------------------------------------------------
// DISEÑO DEL COMPROBANTE (PDF) Y DEL MAIL
// ------------------------------------------------------------------
router.get('/:cuit/diseno', (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  res.json({ success: true, diseno: acc.diseno || DISENO_GENERICO, generico: DISENO_GENERICO, asuntoDefault: ASUNTO_MAIL_DEFAULT, cuerpoDefault: CUERPO_MAIL_DEFAULT });
});

router.put('/:cuit/diseno', (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  try {
    const diseno = sanearDiseno(req.body?.diseno);
    db.updateAccountDiseno(acc.cuit, diseno);
    res.json({ success: true, message: diseno.modo === 'generico' ? 'Se usa el diseño genérico.' : 'Diseño personalizado guardado.', diseno });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Vista previa en PDF con datos de ejemplo (no emite ni guarda nada)
router.post('/:cuit/diseno/vista-previa', async (req: Request, res: Response) => {
  const acc = db.getAccountRecord(String(req.params.cuit));
  if (!acc) return res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  try {
    const diseno = sanearDiseno(req.body?.diseno || acc.diseno || DISENO_GENERICO);
    const pdf = await generarPdfComprobante(datosEjemplo({
      razonSocial: acc.razonSocial || acc.cuit,
      cuit: acc.cuit,
      condicionIva: acc.ws?.condicionIvaEmisor || 'Responsable Monotributo',
      domicilio: acc.ws?.domicilioComercial,
      iibb: acc.ws?.iibb,
      inicioActividades: acc.ws?.inicioActividades,
    }), diseno);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Eliminar cuenta CUIT
router.delete('/:cuit', (req: Request, res: Response) => {
  const { cuit } = req.params;
  if (!cuit) return res.status(400).json({ success: false, message: 'Falta especificar el CUIT.' });

  const deleted = db.deleteAccount(String(cuit));
  if (deleted) {
    res.json({ success: true, message: `Cuenta CUIT ${cuit} eliminada.`, accounts: db.getAccounts() });
  } else {
    res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  }
});

export default router;
