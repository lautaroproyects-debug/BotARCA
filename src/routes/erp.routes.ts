import { Router, Request, Response } from 'express';
import { clientesService } from '../services/erp/clientes.js';
import { productosService } from '../services/erp/productos.js';
import { supabase } from '../services/supabase.js';
import { db } from '../database.js';
import { facturacionModule, FacturaRequest } from '../engine/modules/facturacion.js';
import { arcaSession } from '../engine/arcaSession.js';
import { logger } from '../services/logger.js';

const router = Router();

// --- CLIENTES (CRM) ---
router.get('/clientes', async (req: Request, res: Response) => {
  const list = await clientesService.getAll();
  res.json({ success: true, clientes: list });
});

router.post('/clientes', async (req: Request, res: Response) => {
  const { cuit, razonSocial, tipoDoc, condicionIva, domicilio, email, telefono, notas } = req.body;
  if (!cuit || !razonSocial) {
    return res.status(400).json({ success: false, message: 'CUIT y Razón Social son requeridos.' });
  }

  const saved = await clientesService.save({
    cuit,
    razonSocial,
    tipoDoc: tipoDoc || 'CUIT',
    condicionIva: condicionIva || 'Consumidor Final',
    domicilio,
    email,
    telefono,
    notas,
  });

  res.json({ success: true, cliente: saved });
});

router.delete('/clientes/:id', async (req: Request, res: Response) => {
  const ok = await clientesService.delete(String(req.params.id));
  res.json({ success: ok });
});

// --- PRODUCTOS Y SERVICIOS (CATÁLOGO) ---
router.get('/productos', async (req: Request, res: Response) => {
  const list = await productosService.getAll();
  res.json({ success: true, productos: list });
});

router.post('/productos', async (req: Request, res: Response) => {
  const { codigo, nombre, descripcion, categoria, unidadMedida, precioArs, precioUsd, autoAjusteDolar, alicuotaIva, activo } = req.body;
  if (!codigo || !nombre) {
    return res.status(400).json({ success: false, message: 'Código y Nombre son requeridos.' });
  }

  const saved = await productosService.save({
    codigo,
    nombre,
    descripcion,
    categoria: categoria || 'General',
    unidadMedida: unidadMedida || 'unidades',
    precioArs: Number(precioArs) || 0,
    precioUsd: Number(precioUsd) || 0,
    autoAjusteDolar: autoAjusteDolar !== undefined ? Boolean(autoAjusteDolar) : true,
    alicuotaIva: Number(alicuotaIva) || 21,
    activo: activo !== undefined ? Boolean(activo) : true,
  });

  res.json({ success: true, producto: saved });
});

router.delete('/productos/:id', async (req: Request, res: Response) => {
  const ok = await productosService.delete(String(req.params.id));
  res.json({ success: ok });
});

// --- FACTURACIÓN MANUAL DIRECTA EN ARCA ---
router.post('/facturacion/emitir', async (req: Request, res: Response) => {
  const datos: FacturaRequest = req.body;

  if (!datos.tipoComprobante || !datos.puntoVenta || !datos.items || datos.items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos obligatorios para la emisión del comprobante.',
    });
  }

  const creds = db.getCredentials();
  if (!creds.cuit || !creds.claveFiscal) {
    return res.status(400).json({
      success: false,
      message: 'No hay CUIT ni Clave Fiscal configurados para operar en ARCA. Ingresalos en "Cuentas y CUITs".',
    });
  }

  try {
    logger.info('ERP-FACTURACION', `Iniciando sesión en ARCA para emisión directa de ${datos.tipoComprobante}...`);
    const session = await arcaSession.login(creds.cuit, creds.claveFiscal);
    if (!session.success) {
      return res.status(401).json({
        success: false,
        message: `Fallo al iniciar sesión en ARCA: ${session.message}`,
      });
    }

    const resultado = await facturacionModule.emitirFactura(session, {
      ...datos,
      cuitEmisor: datos.cuitEmisor || creds.cuit,
      razonSocialEmisor: datos.razonSocialEmisor || creds.razonSocial,
    });

    if (resultado.success) {
      // Guardar en la base de comprobantes
      const record = {
        id: 'comp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        tipoOperacion: 'Emitido',
        tipoComprobante: datos.tipoComprobante,
        puntoVenta: datos.puntoVenta,
        numero: parseInt(resultado.comprobanteNro?.split('-')[1] || '1', 10),
        comprobanteFormato: resultado.comprobanteNro || `0000${datos.puntoVenta}-00000001`,
        fechaEmision: resultado.fechaEmision || new Date().toISOString().split('T')[0],
        cuitEmisor: datos.cuitEmisor || creds.cuit,
        cuitReceptor: datos.receptor.nroDoc || '',
        razonSocialReceptor: datos.receptor.razonSocial || 'Consumidor Final',
        condicionIvaReceptor: datos.receptor.condicionIva,
        importeTotal: resultado.totalImporte || 0,
        cae: resultado.cae,
        caeVencimiento: resultado.caeVencimiento,
        estado: 'Autorizado',
        createdAt: new Date().toISOString(),
      };

      if (!db.data.comprobantes) db.data.comprobantes = [];
      db.data.comprobantes.unshift(record);
      db.save();

      const supa = supabase.getClient();
      if (supa) {
        Promise.resolve(
          supa.from('comprobantes').insert({
            id: record.id,
            tipo_operacion: record.tipoOperacion,
            tipo_comprobante: record.tipoComprobante,
            punto_venta: record.puntoVenta,
            numero: record.numero,
            comprobante_formato: record.comprobanteFormato,
            fecha_emision: record.fechaEmision,
            cuit_emisor: record.cuitEmisor,
            cuit_receptor: record.cuitReceptor,
            razon_social_receptor: record.razonSocialReceptor,
            condicion_iva_receptor: record.condicionIvaReceptor,
            importe_total: record.importeTotal,
            cae: record.cae,
            cae_vencimiento: record.caeVencimiento,
            estado: record.estado,
          })
        ).catch(() => {});
      }

      return res.json(resultado);
    } else {
      return res.status(400).json(resultado);
    }
  } catch (err: any) {
    logger.error('ERP-FACTURACION', `Error en endpoint de emisión: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: `Error interno al emitir comprobante: ${err.message}`,
    });
  }
});

// --- LISTAR COMPROBANTES ---
router.get('/comprobantes', (req: Request, res: Response) => {
  const comprobantes = db.data.comprobantes || [];
  res.json({ success: true, comprobantes });
});

// --- SUPABASE CLOUD SYNC ---
router.get('/supabase/status', (req: Request, res: Response) => {
  res.json(supabase.getStatus());
});

router.post('/supabase/connect', async (req: Request, res: Response) => {
  const { url, key } = req.body;
  if (!url || !key) {
    return res.status(400).json({ success: false, message: 'URL y Clave API de Supabase requeridas.' });
  }

  supabase.init(url.trim(), key.trim());
  const test = await supabase.testConnection();
  res.json({ success: test.success, message: test.message, status: supabase.getStatus() });
});

export default router;
