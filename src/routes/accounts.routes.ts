import { Router, Request, Response } from 'express';
import { db, ModoConexionArca } from '../database.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireAdmin } from '../middleware/auth.middleware.js';
import { generarCsr, leerCertificado, normalizarPem, verificarParClave } from '../engine/ws/certificados.js';
import { estadoPlataforma, probarConexion } from '../engine/ws/wsfeEmisor.js';
import { sanearDiseno, DISENO_GENERICO, ASUNTO_MAIL_DEFAULT, CUERPO_MAIL_DEFAULT } from '../engine/ws/diseno.js';
import { generarPdfComprobante, datosEjemplo } from '../engine/ws/pdfComprobante.js';
import { crearEnlace } from '../services/enlacesTemporales.js';
import { usuarioDe, esAdmin, cuitsVisibles, puedeUsarCuit, cuitActivoDe, exigirAccesoCuit } from '../services/acceso.js';
import { cuitValido } from '../services/aiParserService.js';
import { excedeLimite } from '../services/limites.js';
import { supabase } from '../services/supabase.js';

/** ¿El CUIT ya emitió algo? (local o en Supabase). Un CUIT con comprobantes no se renombra. */
async function tieneComprobantes(cuit: string): Promise<boolean> {
  if ((db.data.comprobantes || []).some(c => c.cuitEmisor === cuit)) return true;
  const client = supabase.getClient();
  if (!client) return false;
  const { count, error } = await client.from('comprobantes').select('id', { count: 'exact', head: true }).eq('cuit_emisor', cuit);
  return !error && (count || 0) > 0;
}

const router = Router();

// Toda ruta con :cuit exige que el usuario tenga ese CUIT (el admin los tiene todos)
router.param('cuit', (req, res, next, cuit) => exigirAccesoCuit(req, res, next, String(cuit)));

/** Las cuentas que ve el usuario, con quién más las comparte solo si es admin. */
function cuentasDe(req: Request) {
  const usuario = usuarioDe(req);
  const visibles = new Set(cuitsVisibles(usuario));
  return db.getAccounts()
    .filter(a => visibles.has(a.cuit))
    .map(a => (esAdmin(usuario) ? a : { ...a, usuarios: undefined }));
}

// Mis CUITs
router.get('/', (req: Request, res: Response) => {
  res.json({ success: true, activeCuit: cuitActivoDe(usuarioDe(req)), accounts: cuentasDe(req) });
});

// Agregar o actualizar un CUIT propio
router.post('/', async (req: Request, res: Response) => {
  const usuario = usuarioDe(req)!;
  const { cuit, claveFiscal, puntoVentaDefault, razonSocial, cuitRepresentante, nombreRepresentante, emailNotificaciones, cuitAnterior } = req.body || {};
  const limpio = String(cuit || '').replace(/\D/g, '');
  if (limpio.length !== 11) return res.status(400).json({ success: false, message: 'El CUIT tiene que tener 11 números.' });
  if (!cuitValido(limpio)) return res.status(400).json({ success: false, message: 'Ese CUIT no es válido: revisá los números.' });
  if (!String(razonSocial || '').trim() || String(razonSocial).length > 150) return res.status(400).json({ success: false, message: 'Falta la razón social (hasta 150 caracteres).' });
  const rep = String(cuitRepresentante || '').replace(/\D/g, '');
  if (rep && (rep.length !== 11 || !cuitValido(rep))) return res.status(400).json({ success: false, message: 'El CUIT de quien representa no es válido.' });
  if (emailNotificaciones && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(emailNotificaciones).trim())) return res.status(400).json({ success: false, message: 'El email no es válido.' });
  const pv = Number(puntoVentaDefault) || 1;
  if (!Number.isInteger(pv) || pv < 1 || pv > 99998) return res.status(400).json({ success: false, message: 'El punto de venta tiene que ser un número entre 1 y 99998.' });

  // Cambio de CUIT de una cuenta existente (por ejemplo, si se cargó mal)
  const anterior = String(cuitAnterior || '').replace(/\D/g, '');
  let renombrado = false;
  if (anterior && anterior !== limpio) {
    const acc = db.getAccountRecord(anterior);
    if (!acc || !puedeUsarCuit(usuario, anterior)) return res.status(404).json({ success: false, message: 'No tenés ese CUIT en tu cuenta.' });
    if (db.getAccountRecord(limpio)) return res.status(409).json({ success: false, message: 'El CUIT nuevo ya está cargado en el sistema.' });
    if (await tieneComprobantes(anterior)) {
      return res.status(409).json({ success: false, message: 'Ese CUIT ya tiene comprobantes emitidos, así que no se puede cambiar. Agregá el CUIT correcto como uno nuevo y, si querés, quitá este.' });
    }
    const r = db.renombrarCuenta(anterior, limpio);
    if (!r.ok) return res.status(400).json({ success: false, message: r.mensaje });
    renombrado = true;
  }

  // Un CUIT que ya cargó otro usuario no se puede tomar: lo comparte el administrador
  const existente = db.getAccountRecord(limpio);
  if (existente && !esAdmin(usuario) && !(existente.usuarios || []).includes(usuario.id)) {
    return res.status(409).json({ success: false, message: 'Ese CUIT ya lo administra otro usuario. Pedile al administrador que te lo comparta.' });
  }
  if (!existente) {
    const limite = await excedeLimite(usuario, 'cuits');
    if (limite) return res.status(403).json({ success: false, message: limite });
  }
  db.guardarCuenta({ cuit: limpio, razonSocial, cuitRepresentante: rep, nombreRepresentante, emailNotificaciones, claveFiscal: claveFiscal || undefined, puntoVentaDefault: pv }, usuario.id);
  if (!db.getCuitActivoUsuario(usuario.id)) db.setCuitActivoUsuario(usuario.id, limpio);
  res.json({
    success: true,
    message: renombrado ? 'CUIT cambiado. Volvé a conectarlo con ARCA: la conexión es propia de cada CUIT.'
      : existente ? 'CUIT actualizado.' : 'CUIT agregado. Ahora configurá su conexión con ARCA.',
    cuit: limpio, renombrado, accounts: cuentasDe(req),
  });
});

// Elegir con qué CUIT facturo (solo para mi usuario)
router.post('/switch', (req: Request, res: Response) => {
  const usuario = usuarioDe(req)!;
  const cuit = String(req.body?.cuit || '').replace(/\D/g, '');
  if (!puedeUsarCuit(usuario, cuit)) return res.status(404).json({ success: false, message: 'No tenés ese CUIT en tu cuenta.' });
  db.setCuitActivoUsuario(usuario.id, cuit);
  res.json({ success: true, activeCuit: cuit });
});

// Compartir un CUIT con usuarios (solo administrador)
router.put('/:cuit/usuarios', requireAdmin, (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.usuarios) ? req.body.usuarios.map(String).slice(0, 100) : null;
  if (!ids) return res.status(400).json({ success: false, message: 'Mandá la lista de usuarios.' });
  db.definirUsuariosCuenta(String(req.params.cuit), ids);
  res.json({ success: true, message: 'Accesos actualizados.', accounts: cuentasDe(req) });
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
router.put('/:cuit/ws', (req: Request, res: Response) => {
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
router.post('/:cuit/ws/csr', (req: Request, res: Response) => {
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
router.post('/:cuit/ws/certificado', (req: Request, res: Response) => {
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

router.delete('/:cuit/ws/certificado', (req: Request, res: Response) => {
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
    // Se devuelve un enlace temporal: el panel lo abre en una pestaña nueva con el visor de PDF del navegador
    res.json({ success: true, url: crearEnlace(pdf, 'Vista previa de factura.pdf') });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Quitar un CUIT: el admin lo borra para todos; un usuario solo se lo quita a sí mismo
router.delete('/:cuit', (req: Request, res: Response) => {
  const usuario = usuarioDe(req)!;
  const cuit = String(req.params.cuit);
  if (esAdmin(usuario)) {
    return db.deleteAccount(cuit)
      ? res.json({ success: true, message: 'CUIT eliminado del sistema.', accounts: cuentasDe(req) })
      : res.status(404).json({ success: false, message: 'CUIT no encontrado.' });
  }
  const r = db.quitarAccesoCuenta(cuit, usuario.id);
  res.json({ success: true, message: r === 'borrada' ? 'CUIT eliminado.' : 'Quitaste ese CUIT de tu cuenta.', accounts: cuentasDe(req) });
});

export default router;
