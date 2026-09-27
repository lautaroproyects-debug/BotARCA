import { Router, Request, Response } from 'express';
import { db } from '../database.js';
import { arcaSession } from '../engine/arcaSession.js';
import { facturacionModule, FacturaRequest } from '../engine/modules/facturacion.js';
import { comprobantesModule } from '../engine/modules/comprobantes.js';
import { monotributoModule } from '../engine/modules/monotributo.js';
import { notificacionesModule } from '../engine/modules/notificaciones.js';
import { logger } from '../services/logger.js';

const router = Router();

// Emisión de Factura Electrónica
router.post('/facturar', async (req: Request, res: Response) => {
  const facturaData: FacturaRequest = req.body;
  const creds = db.getCredentials();

  if (!creds.cuit || !creds.claveFiscal) {
    return res.status(400).json({
      success: false,
      message: 'Debes configurar primero tu CUIT y Clave Fiscal en el panel de configuración.',
    });
  }

  if (!facturaData.puntoVenta || !facturaData.tipoComprobante || !facturaData.items || facturaData.items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Datos de facturación incompletos (Punto de venta, tipo de comprobante e items requeridos).',
    });
  }

  const task = db.addTask({
    type: 'facturacion',
    status: 'running',
    resultSummary: `Iniciando emisión de ${facturaData.tipoComprobante}`,
  });

  try {
    const session = await arcaSession.ensureActiveSession();
    if (!session.success) {
      throw new Error(session.message);
    }

    const resultado = await facturacionModule.emitirFactura(session, facturaData);

    if (resultado.success) {
      db.updateTask(task.id, {
        status: 'success',
        resultSummary: `Factura autorizada: ${resultado.comprobanteNro} - CAE: ${resultado.cae}`,
        details: resultado,
      });
      res.json(resultado);
    } else {
      db.updateTask(task.id, {
        status: 'failed',
        error: resultado.message,
        resultSummary: 'Fallo al emitir la factura en ARCA',
      });
      res.status(400).json(resultado);
    }
  } catch (err: any) {
    db.updateTask(task.id, {
      status: 'failed',
      error: err.message,
      resultSummary: 'Error inesperado durante la facturación',
    });
    res.status(500).json({ success: false, message: err.message });
  }
});

// Consulta de Mis Comprobantes
router.post('/comprobantes', async (req: Request, res: Response) => {
  const { tipo, fechaDesde, fechaHasta } = req.body;
  const creds = db.getCredentials();

  if (!creds.cuit || !creds.claveFiscal) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales de ARCA.' });
  }

  const tipoConsulta = tipo === 'Recibidos' ? 'Recibidos' : 'Emitidos';
  const now = new Date();
  const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const defaultHasta = now.toISOString().split('T')[0];

  const desde = fechaDesde || defaultDesde;
  const hasta = fechaHasta || defaultHasta;

  const task = db.addTask({
    type: 'comprobantes',
    status: 'running',
    resultSummary: `Consultando comprobantes ${tipoConsulta} (${desde} al ${hasta})`,
  });

  try {
    const session = await arcaSession.ensureActiveSession();
    if (!session.success) {
      throw new Error(session.message);
    }

    const resultado = await comprobantesModule.consultarComprobantes(session, tipoConsulta, desde, hasta);

    db.updateTask(task.id, {
      status: resultado.success ? 'success' : 'failed',
      resultSummary: resultado.message,
      details: { totalRegistros: resultado.totalRegistros, totalImporte: resultado.totalImporte },
    });

    res.json(resultado);
  } catch (err: any) {
    db.updateTask(task.id, {
      status: 'failed',
      error: err.message,
      resultSummary: 'Error al consultar comprobantes',
    });
    res.status(500).json({ success: false, message: err.message });
  }
});

// Consulta de Estado de Monotributo
router.get('/monotributo', async (req: Request, res: Response) => {
  const creds = db.getCredentials();
  if (!creds.cuit || !creds.claveFiscal) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales de ARCA.' });
  }

  const task = db.addTask({
    type: 'monotributo',
    status: 'running',
    resultSummary: 'Consultando estado general de Monotributo y deuda',
  });

  try {
    const session = await arcaSession.ensureActiveSession();
    if (!session.success) {
      throw new Error(session.message);
    }

    const resultado = await monotributoModule.getStatus(session);

    db.updateTask(task.id, {
      status: resultado.success ? 'success' : 'failed',
      resultSummary: resultado.message,
      details: resultado,
    });

    res.json(resultado);
  } catch (err: any) {
    db.updateTask(task.id, {
      status: 'failed',
      error: err.message,
      resultSummary: 'Error al consultar Monotributo',
    });
    res.status(500).json({ success: false, message: err.message });
  }
});

// Consulta de Notificaciones (DFE)
router.get('/notificaciones', async (req: Request, res: Response) => {
  const creds = db.getCredentials();
  if (!creds.cuit || !creds.claveFiscal) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales de ARCA.' });
  }

  const task = db.addTask({
    type: 'notificaciones',
    status: 'running',
    resultSummary: 'Consultando notificaciones del Domicilio Fiscal Electrónico',
  });

  try {
    const session = await arcaSession.ensureActiveSession();
    if (!session.success) {
      throw new Error(session.message);
    }

    const resultado = await notificacionesModule.checkNotifications(session);

    db.updateTask(task.id, {
      status: resultado.success ? 'success' : 'failed',
      resultSummary: resultado.message,
      details: resultado,
    });

    res.json(resultado);
  } catch (err: any) {
    db.updateTask(task.id, {
      status: 'failed',
      error: err.message,
      resultSummary: 'Error al consultar notificaciones',
    });
    res.status(500).json({ success: false, message: err.message });
  }
});

// Historial de tareas
router.get('/history', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json({ tasks: db.getTasks(limit) });
});

export default router;
