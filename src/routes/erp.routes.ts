import { Router, Request, Response } from 'express';
import { clientesService } from '../services/erp/clientes.js';
import { productosService } from '../services/erp/productos.js';
import { supabase } from '../services/supabase.js';
import { FacturaRequest } from '../engine/modules/facturacion.js';
import { logger } from '../services/logger.js';
import { emitirComprobante } from '../services/emisionService.js';
import { comprobantesService } from '../services/comprobantesService.js';
import { crearEnlace } from '../services/enlacesTemporales.js';
import { usuarioDe, puedeUsarCuit, cuitsVisibles, cuitActivoDe, esAdmin } from '../services/acceso.js';
import { requireAdmin } from '../middleware/auth.middleware.js';

const router = Router();

// --- CLIENTES (agenda de cada usuario) ---
router.get('/clientes', (req: Request, res: Response) => {
  res.json({ success: true, clientes: clientesService.getAll(usuarioDe(req)) });
});

router.post('/clientes', async (req: Request, res: Response) => {
  const error = clientesService.validar(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });
  const saved = await clientesService.save(req.body, usuarioDe(req)!);
  res.json({ success: true, cliente: saved });
});

router.delete('/clientes/:id', async (req: Request, res: Response) => {
  const ok = await clientesService.delete(String(req.params.id), usuarioDe(req)!);
  res.status(ok ? 200 : 404).json({ success: ok, message: ok ? 'Cliente eliminado.' : 'Cliente no encontrado.' });
});

// --- CATÁLOGO DE PRODUCTOS (compartido; solo el administrador lo modifica) ---
router.get('/productos', async (req: Request, res: Response) => {
  const list = await productosService.getAll();
  res.json({ success: true, productos: list });
});

router.post('/productos', requireAdmin, async (req: Request, res: Response) => {
  const { codigo, nombre, descripcion, categoria, unidadMedida, precioArs, precioUsd, autoAjusteDolar, alicuotaIva, activo } = req.body || {};
  if (!codigo || !nombre || String(codigo).length > 40 || String(nombre).length > 150) {
    return res.status(400).json({ success: false, message: 'Código (hasta 40) y nombre (hasta 150 caracteres) son obligatorios.' });
  }
  const saved = await productosService.save({
    codigo, nombre, descripcion,
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

router.delete('/productos/:id', requireAdmin, async (req: Request, res: Response) => {
  const ok = await productosService.delete(String(req.params.id));
  res.json({ success: ok });
});

// --- EMISIÓN DE UN COMPROBANTE ---
router.post('/facturacion/emitir', async (req: Request, res: Response) => {
  const datos: FacturaRequest = req.body || ({} as FacturaRequest);
  const usuario = usuarioDe(req);

  if (!datos.tipoComprobante || !Array.isArray(datos.items) || datos.items.length === 0 || datos.items.length > 50 || !datos.receptor) {
    return res.status(400).json({ success: false, message: 'Faltan datos obligatorios del comprobante (tipo, cliente e ítems).' });
  }
  // Solo se puede facturar con CUITs propios
  const cuit = String(datos.cuitEmisor || cuitActivoDe(usuario)).replace(/\D/g, '');
  if (!cuit) return res.status(400).json({ success: false, message: 'Todavía no cargaste ningún CUIT. Agregalo en Ajustes → Mis CUITs.' });
  if (!puedeUsarCuit(usuario, cuit)) return res.status(403).json({ success: false, message: 'No podés facturar con ese CUIT.' });

  try {
    logger.info('ERP-FACTURACION', `Emisión de ${datos.tipoComprobante} para CUIT ${cuit} (usuario @${usuario?.username || '?'})...`);
    const resultado = await emitirComprobante({ ...datos, cuitEmisor: cuit });
    return res.status(resultado.success ? 200 : 400).json(resultado);
  } catch (err: any) {
    logger.error('ERP-FACTURACION', `Error en endpoint de emisión: ${err.message}`);
    return res.status(500).json({ success: false, message: `Error interno al emitir: ${err.message}` });
  }
});

// --- COMPROBANTES (solo los de los CUITs del usuario) ---
function comprobanteVisible(req: Request, id: string) {
  const c = comprobantesService.obtener(id);
  return c && puedeUsarCuit(usuarioDe(req), c.cuitEmisor || '') ? c : undefined;
}

router.get('/comprobantes', (req: Request, res: Response) => {
  const visibles = new Set(cuitsVisibles(usuarioDe(req)));
  const comprobantes = comprobantesService.listar()
    .filter(c => visibles.has(String(c.cuitEmisor || '')))
    .map(({ detalle, ...c }) => ({ ...c, tienePdf: !!detalle }));
  res.json({ success: true, comprobantes });
});

router.get('/comprobantes/:id/pdf', async (req: Request, res: Response) => {
  if (!comprobanteVisible(req, String(req.params.id))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const r = await comprobantesService.pdf(String(req.params.id));
  if (!r.ok) return res.status(404).json({ success: false, message: r.mensaje });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.nombre)}"`);
  res.send(r.buffer);
});

// Enlace temporal para abrir el PDF en una pestaña nueva (sin la sesión en la URL)
router.post('/comprobantes/:id/enlace', async (req: Request, res: Response) => {
  if (!comprobanteVisible(req, String(req.params.id))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const r = await comprobantesService.pdf(String(req.params.id));
  if (!r.ok) return res.status(404).json({ success: false, message: r.mensaje });
  res.json({ success: true, url: crearEnlace(r.buffer, r.nombre) });
});

router.post('/comprobantes/:id/enviar', async (req: Request, res: Response) => {
  if (!comprobanteVisible(req, String(req.params.id))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const email = req.body?.email;
  if (email !== undefined && (typeof email !== 'string' || email.length > 200)) return res.status(400).json({ success: false, message: 'Email inválido.' });
  const r = await comprobantesService.enviarPorMail(String(req.params.id), email);
  res.status(r.success ? 200 : 400).json(r);
});

// --- SUPABASE (solo administrador: cambiar la base de datos es crítico) ---
router.get('/supabase/status', requireAdmin, (req: Request, res: Response) => {
  res.json(supabase.getStatus());
});

router.post('/supabase/connect', requireAdmin, async (req: Request, res: Response) => {
  const { url, key } = req.body || {};
  if (!url || !key || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(String(url).trim())) {
    return res.status(400).json({ success: false, message: 'La URL tiene que ser https://<proyecto>.supabase.co y hace falta la clave.' });
  }
  supabase.init(String(url).trim(), String(key).trim());
  const test = await supabase.testConnection();
  res.json({ success: test.success, message: test.message, status: supabase.getStatus(), admin: esAdmin(usuarioDe(req)) });
});

export default router;
