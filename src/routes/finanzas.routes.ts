import { Router, Request, Response } from 'express';
import { argentinaDatos } from '../services/argentinaDatos.js';

const router = Router();

// Cotizaciones de dólares en vivo
router.get('/dolares', async (req: Request, res: Response) => {
  try {
    const dolares = await argentinaDatos.getAllDolares();
    res.json({ success: true, dolares });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Indicadores económicos (Inflación, UVA, Tasas)
router.get('/indicadores', async (req: Request, res: Response) => {
  try {
    const cache = await argentinaDatos.refreshCache();
    res.json({
      success: true,
      inflacionMensual: cache.inflacionMensual,
      uva: cache.uva,
      tasasPlazoFijo: cache.tasasPlazoFijo,
      dolares: cache.dolares,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Convertidor de Moneda inteligente
router.post('/convert', async (req: Request, res: Response) => {
  const { amount, from, to, tipoDolar } = req.body;
  if (!amount || isNaN(Number(amount))) {
    return res.status(400).json({ success: false, message: 'Monto inválido.' });
  }

  try {
    const result = await argentinaDatos.convertCurrency(
      Number(amount),
      from || 'USD',
      to || 'ARS',
      tipoDolar || 'oficial'
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
