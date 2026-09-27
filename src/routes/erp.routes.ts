import { Router, Request, Response } from 'express';
import { clientesService } from '../services/erp/clientes.js';
import { productosService } from '../services/erp/productos.js';
import { supabase } from '../services/supabase.js';

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
