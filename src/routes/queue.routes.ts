import { Router, Request, Response } from 'express';
import { queueService } from '../services/queueService.js';
import { db } from '../database.js';
import { aiParserService } from '../services/aiParserService.js';
import { usuarioDe, cuitsVisibles, puedeUsarCuit, cuitActivoDe } from '../services/acceso.js';

const router = Router();

// Obtener estado y lista de la cola
router.get('/', (req: Request, res: Response) => {
  const status = queueService.getStatus(cuitsVisibles(usuarioDe(req)));
  res.json({ success: true, ...status });
});

// Parsear texto copiado de Excel / CSV o WhatsApp con IA (Groq / Heurístico)
router.post('/parse-excel', async (req: Request, res: Response) => {
  const { text, forceAi } = req.body || {};
  if (!text || typeof text !== 'string' || text.length > 200000) {
    return res.status(400).json({ success: false, message: 'No se envió texto para parsear.' });
  }

  const result = await queueService.parseSmartText(text, { forceAi: Boolean(forceAi) });
  res.json({
    success: true,
    count: result.items.length,
    items: result.items,
    parserUsed: result.parserUsed,
    message: result.message,
  });
});

// Endpoint explícito para parseo con IA
router.post('/parse-smart', async (req: Request, res: Response) => {
  const { text, forceAi } = req.body || {};
  if (!text || typeof text !== 'string' || text.length > 200000) {
    return res.status(400).json({ success: false, message: 'No se envió texto para parsear.' });
  }

  const result = await queueService.parseSmartText(text, { forceAi: forceAi !== false });
  res.json({
    success: true,
    count: result.items.length,
    items: result.items,
    parserUsed: result.parserUsed,
    message: result.message,
  });
});

// Agregar lote de comprobantes a la cola
router.post('/add', async (req: Request, res: Response) => {
  const { items } = req.body || {};
  const usuario = usuarioDe(req);
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    return res.status(400).json({ success: false, message: 'La lista de comprobantes está vacía.' });
  }

  // Se vuelve a validar cada borrador en el servidor: no entra a la cola nada con datos faltantes
  const problemas: string[] = [];
  const limpios = items.map((raw: any, i: number) => {
    const b = aiParserService.normalizarBorrador(raw);
    if (b.advertencias.length) problemas.push(`Fila ${i + 1}: ${b.advertencias.join(' ')}`);
    const { advertencias, ...item } = b;
    // Solo con CUITs propios: si no viene o no es suyo, se usa el CUIT con el que factura
    const pedido = String(raw.cuitEmisor || '').replace(/\D/g, '');
    const cuitEmisor = puedeUsarCuit(usuario, pedido) ? pedido : cuitActivoDe(usuario);
    if (!cuitEmisor) problemas.push(`Fila ${i + 1}: todavía no cargaste ningún CUIT.`);
    const acc = db.getAccountRecord(cuitEmisor);
    return { ...item, docNro: item.docNro || '', cuitEmisor, razonSocialEmisor: acc?.razonSocial, puntoVenta: acc?.ws?.puntoVentaWs || item.puntoVenta, email: item.email || '' };
  });
  if (problemas.length) {
    return res.status(400).json({ success: false, message: 'Hay borradores para revisar antes de pasarlos a la cola.', problemas });
  }

  const added = await queueService.addBatch(limpios as any);
  res.json({ success: true, count: added.length, items: added });
});

// Iniciar procesamiento de la cola en ARCA
router.post('/process', (req: Request, res: Response) => {
  // Iniciar en background
  queueService.processQueue(cuitsVisibles(usuarioDe(req))).catch(() => {});
  res.json({ success: true, message: 'Procesamiento de la cola de facturación iniciado en ARCA.' });
});

// Eliminar un item de la cola
router.delete('/:id', (req: Request, res: Response) => {
  const item = db.getQueue().find(q => q.id === req.params.id);
  if (!item || !puedeUsarCuit(usuarioDe(req), item.cuitEmisor || '')) return res.status(404).json({ success: false, message: 'No encontrado.' });
  if (item.estado === 'procesando') return res.status(409).json({ success: false, message: 'Se está emitiendo ahora: esperá a que termine.' });
  res.json({ success: db.deleteQueueItem(item.id) });
});

// Limpiar la cola
router.post('/clear', (req: Request, res: Response) => {
  const status = String(req.body?.status || '');
  if (!['emitida', 'error', 'pendiente'].includes(status)) return res.status(400).json({ success: false, message: 'Estado inválido.' });
  const visibles = new Set(cuitsVisibles(usuarioDe(req)));
  db.data.queue = (db.data.queue || []).filter(q => !(q.estado === status && visibles.has(String(q.cuitEmisor || ''))));
  db.save();
  res.json({ success: true, message: 'Cola limpiada correctamente.' });
});

export default router;
