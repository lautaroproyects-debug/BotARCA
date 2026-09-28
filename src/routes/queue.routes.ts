import { Router, Request, Response } from 'express';
import { queueService } from '../services/queueService.js';
import { db } from '../database.js';

const router = Router();

// Obtener estado y lista de la cola
router.get('/', (req: Request, res: Response) => {
  const status = queueService.getStatus();
  res.json({ success: true, ...status });
});

// Parsear texto copiado de Excel / CSV o WhatsApp con IA (Groq / Heurístico)
router.post('/parse-excel', async (req: Request, res: Response) => {
  const { text, forceAi } = req.body;
  if (!text || typeof text !== 'string') {
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
  const { text, forceAi } = req.body;
  if (!text || typeof text !== 'string') {
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
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'La lista de comprobantes está vacía.' });
  }

  const added = await queueService.addBatch(items);
  res.json({ success: true, count: added.length, items: added });
});

// Iniciar procesamiento de la cola en ARCA
router.post('/process', (req: Request, res: Response) => {
  // Iniciar en background
  queueService.processQueue().catch(() => {});
  res.json({ success: true, message: 'Procesamiento de la cola de facturación iniciado en ARCA.' });
});

// Eliminar un item de la cola
router.delete('/:id', (req: Request, res: Response) => {
  const success = db.deleteQueueItem(req.params.id as string);
  res.json({ success });
});

// Limpiar la cola
router.post('/clear', (req: Request, res: Response) => {
  const { status } = req.body;
  db.clearQueue(status);
  res.json({ success: true, message: 'Cola limpiada correctamente.' });
});

export default router;
