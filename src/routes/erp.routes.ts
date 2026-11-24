import { Router, Request, Response } from 'express';
import { clientesService } from '../services/erp/clientes.js';
import { productosService } from '../services/erp/productos.js';
import { supabase } from '../services/supabase.js';
import { FacturaRequest } from '../engine/modules/facturacion.js';
import { logger } from '../services/logger.js';
import { emitirComprobante } from '../services/emisionService.js';
import { comprobantesService, rangoMes } from '../services/comprobantesService.js';
import { excedeLimite, limitesDe, usoDe, inicioDeMes } from '../services/limites.js';
import { ambienteActual } from '../engine/ws/wsfeEmisor.js';
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
  const usuario = usuarioDe(req)!;
  const doc = String(req.body?.cuit || '').replace(/\D/g, '');
  const esNuevo = !clientesService.getAll(usuario).some(c => (req.body?.id && c.id === req.body.id) || (c.usuarioId === usuario.id && c.cuit === doc));
  if (esNuevo) {
    const limite = await excedeLimite(usuario, 'clientes');
    if (limite) return res.status(403).json({ success: false, message: limite });
  }
  const saved = await clientesService.save(req.body, usuario);
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
  const limite = await excedeLimite(usuario, 'comprobantesMes');
  if (limite) return res.status(403).json({ success: false, message: limite });

  try {
    logger.info('ERP-FACTURACION', `Emisión de ${datos.tipoComprobante} para CUIT ${cuit} (usuario @${usuario?.username || '?'})...`);
    const resultado = await emitirComprobante({ ...datos, cuitEmisor: cuit }, { usuarioId: usuario?.id });
    return res.status(resultado.success ? 200 : 400).json(resultado);
  } catch (err: any) {
    logger.error('ERP-FACTURACION', `Error en endpoint de emisión: ${err.message}`);
    return res.status(500).json({ success: false, message: `Error interno al emitir: ${err.message}` });
  }
});

// --- COMPROBANTES (solo los de los CUITs del usuario) ---

async function comprobanteVisibleAsync(req: Request, id: string) {
  const c = await comprobantesService.obtenerAsync(id);
  return c && puedeUsarCuit(usuarioDe(req), c.cuitEmisor || '') ? c : undefined;
}

/** CUITs a consultar: todos los del usuario, o uno solo si lo pide y es suyo. */
function cuitsPedidos(req: Request): string[] {
  const visibles = cuitsVisibles(usuarioDe(req));
  const uno = String(req.query.cuit || '').replace(/\D/g, '');
  return uno ? visibles.filter(c => c === uno) : visibles;
}

const esNotaCredito = (c: any) => /nota de cr[eé]dito/i.test(String(c.tipoComprobante || ''));
const esPrueba = (c: any) => c.ambiente === 'homologacion' || String(c.estado || '').startsWith('Prueba');
const r2 = (n: number) => Math.round(n * 100) / 100;

function resumir(lista: any[]) {
  const validos = lista.filter(c => !esPrueba(c));
  const facturas = validos.filter(c => !esNotaCredito(c));
  const notas = validos.filter(esNotaCredito);
  const facturado = facturas.reduce((s, c) => s + (Number(c.importeTotal) || 0), 0);
  const notasCredito = notas.reduce((s, c) => s + (Number(c.importeTotal) || 0), 0);
  const porCuit: Record<string, { cantidad: number; total: number }> = {};
  const porCliente = new Map<string, { nombre: string; doc: string; cantidad: number; total: number }>();
  for (const c of validos) {
    const signo = esNotaCredito(c) ? -1 : 1;
    const k = String(c.cuitEmisor || '');
    porCuit[k] = porCuit[k] || { cantidad: 0, total: 0 };
    porCuit[k].cantidad++;
    porCuit[k].total = r2(porCuit[k].total + signo * (Number(c.importeTotal) || 0));
    const kc = String(c.cuitReceptor || c.razonSocialReceptor || 'Consumidor Final');
    const cl = porCliente.get(kc) || { nombre: c.razonSocialReceptor || 'Consumidor Final', doc: c.cuitReceptor || '', cantidad: 0, total: 0 };
    cl.cantidad++; cl.total = r2(cl.total + signo * (Number(c.importeTotal) || 0));
    porCliente.set(kc, cl);
  }
  return {
    cantidad: lista.length,
    autorizados: validos.length,
    pruebas: lista.length - validos.length,
    facturas: facturas.length,
    notas: notas.length,
    anuladas: facturas.filter(c => c.anuladoPor).length,
    facturado: r2(facturado),
    notasCredito: r2(notasCredito),
    total: r2(facturado - notasCredito),
    porCuit,
    topClientes: [...porCliente.values()].sort((a, b) => b.total - a.total).slice(0, 5),
  };
}

// Comprobantes de un mes (por defecto, el actual) de los CUITs del usuario
router.get('/comprobantes', async (req: Request, res: Response) => {
  const mes = String(req.query.mes || inicioDeMes());
  if (!rangoMes(mes)) return res.status(400).json({ success: false, message: 'El mes tiene que ser aaaa-mm.' });
  const lista = await comprobantesService.listarMes(cuitsPedidos(req), mes);
  const comprobantes = lista.map(({ detalle, ...c }) => ({ ...c, tienePdf: !!detalle }));
  res.json({ success: true, mes, resumen: resumir(lista), comprobantes });
});

// Descarga del mes: ZIP con los PDF y la planilla, o solo la planilla (formato=csv)
router.get('/comprobantes/descarga', async (req: Request, res: Response) => {
  const mes = String(req.query.mes || '');
  if (!rangoMes(mes)) return res.status(400).json({ success: false, message: 'El mes tiene que ser aaaa-mm.' });
  const lista = await comprobantesService.listarMes(cuitsPedidos(req), mes);
  if (!lista.length) return res.status(404).json({ success: false, message: 'No hay comprobantes en ese mes.' });
  if (req.query.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="comprobantes-${mes}.csv"`);
    return res.send(comprobantesService.planilla(lista));
  }
  if (lista.length > 1500) {
    return res.status(413).json({ success: false, message: `Ese mes tiene ${lista.length} comprobantes: bajá la planilla, o el ZIP de a un CUIT por vez.` });
  }
  try {
    const zip = await comprobantesService.zipDelMes(lista, mes);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="comprobantes-${mes}.zip"`);
    res.setHeader('X-Sin-Pdf', String(zip.sinPdf));
    res.send(zip.buffer);
  } catch (err: any) {
    logger.error('COMPROBANTES', `No se pudo armar el ZIP de ${mes}: ${err.message}`);
    res.status(500).json({ success: false, message: 'No se pudo armar la descarga. Probá de nuevo en un rato.' });
  }
});

// Estadísticas de los últimos meses (por defecto 12), para el tablero de Inicio
router.get('/estadisticas', async (req: Request, res: Response) => {
  const meses = Math.min(24, Math.max(1, parseInt(String(req.query.meses || '12'), 10) || 12));
  const hasta = String(req.query.hasta || inicioDeMes());
  if (!rangoMes(hasta)) return res.status(400).json({ success: false, message: 'El mes tiene que ser aaaa-mm.' });
  const lista: string[] = [];
  let [a, m] = hasta.split('-').map(Number);
  for (let i = 0; i < meses; i++) { lista.unshift(`${a}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; a--; } }
  const todos = await comprobantesService.listarRango(cuitsPedidos(req), { desde: `${lista[0]}-01`, hasta: rangoMes(hasta)!.hasta });
  const serie = lista.map(mes => {
    const delMes = todos.filter(c => String(c.fechaEmision || '').slice(0, 7) === mes);
    const rs = resumir(delMes);
    return { mes, facturado: rs.facturado, notasCredito: rs.notasCredito, neto: rs.total, facturas: rs.facturas, notas: rs.notas };
  });
  res.json({ success: true, serie });
});

// Detalle de un comprobante (ítems y qué se puede hacer con él)
router.get('/comprobantes/:id', async (req: Request, res: Response) => {
  const c = await comprobanteVisibleAsync(req, String(req.params.id));
  if (!c) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const { detalle, ...resto } = c;
  const anuladoPor = c.anuladoPor || (esNotaCredito(c) ? undefined : await comprobantesService.notaQueAnula(c.id));
  const p = comprobantesService.pedidoDe(c);
  const ambienteComp = esPrueba(c) ? 'homologacion' : 'produccion';
  const mismoAmbiente = ambienteComp === ambienteActual();
  res.json({
    success: true,
    comprobante: {
      ...resto,
      anuladoPor,
      tienePdf: !!detalle,
      items: detalle?.items || [],
      totales: detalle?.totales,
      periodo: detalle?.periodo,
      condicionVenta: detalle?.condicionVenta,
      puedeRefacturar: p.ok && mismoAmbiente,
      puedeAnular: p.ok && mismoAmbiente && !esNotaCredito(c) && !anuladoPor,
      motivo: !p.ok ? p.mensaje
        : !mismoAmbiente ? (ambienteComp === 'homologacion' ? 'Es un comprobante de prueba y el sistema ahora factura en serio: no se puede anular ni repetir.' : 'Es un comprobante real y el sistema está en modo prueba.')
        : esNotaCredito(c) ? 'Es una nota de crédito: no se anula.'
        : anuladoPor ? 'Ya está anulado con una nota de crédito.' : '',
    },
  });
});

/** Emite a partir de un comprobante existente: anular (nota de crédito) o refacturar (igual, con fecha de hoy). */
async function emitirDesde(req: Request, res: Response, accion: 'anular' | 'refacturar') {
  const usuario = usuarioDe(req);
  const c = await comprobanteVisibleAsync(req, String(req.params.id));
  if (!c) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  if (req.body?.confirmado !== true) return res.status(400).json({ success: false, message: 'Falta confirmar la operación.' });
  const p = comprobantesService.pedidoDe(c);
  if (!p.ok) return res.status(409).json({ success: false, message: p.mensaje });
  if ((esPrueba(c) ? 'homologacion' : 'produccion') !== ambienteActual()) {
    return res.status(409).json({ success: false, message: 'El comprobante es de otro ambiente (prueba / real) que el actual.' });
  }
  const limite = await excedeLimite(usuario, 'comprobantesMes');
  if (limite) return res.status(403).json({ success: false, message: limite });

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  let pedido: FacturaRequest;
  if (accion === 'anular') {
    if (esNotaCredito(c)) return res.status(409).json({ success: false, message: 'Una nota de crédito no se anula.' });
    const ya = c.anuladoPor || await comprobantesService.notaQueAnula(c.id);
    if (ya) return res.status(409).json({ success: false, message: 'Este comprobante ya está anulado con una nota de crédito.' });
    const letra = String(c.tipoComprobante).trim().slice(-1).toUpperCase();
    if (!/^Factura [ABC]$/i.test(String(c.tipoComprobante).trim())) return res.status(409).json({ success: false, message: `No se puede anular un "${c.tipoComprobante}" desde acá.` });
    pedido = {
      ...p.pedido,
      tipoComprobante: `Nota de Crédito ${letra}` as any,
      fechaEmision: hoy,
      vencimientoPago: undefined,
      comprobanteAsociado: { tipo: c.tipoComprobante, puntoVenta: c.puntoVenta, numero: String(c.numero), fecha: c.fechaEmision, id: c.id },
    };
  } else {
    // Igual al original, con fecha de hoy y (si es de servicios) el período del mes en curso
    pedido = { ...p.pedido, fechaEmision: hoy, periodoDesde: undefined, periodoHasta: undefined, vencimientoPago: undefined, comprobanteAsociado: undefined };
  }
  if (typeof req.body?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())) {
    pedido.receptor = { ...pedido.receptor, email: req.body.email.trim() };
  }
  try {
    logger.info('ERP-FACTURACION', `${accion === 'anular' ? 'Nota de crédito para anular' : 'Refacturación de'} ${c.tipoComprobante} ${c.comprobanteFormato} (usuario @${usuario?.username || '?'})`);
    const r = await emitirComprobante({ ...pedido, cuitEmisor: c.cuitEmisor }, { usuarioId: usuario?.id });
    if (r.success && accion === 'anular' && r.comprobanteId) await comprobantesService.marcarAnulado(c.id, r.comprobanteId);
    return res.status(r.success ? 200 : 400).json(r);
  } catch (err: any) {
    logger.error('ERP-FACTURACION', `Error al ${accion}: ${err.message}`);
    return res.status(500).json({ success: false, message: `No se pudo emitir: ${err.message}` });
  }
}
router.post('/comprobantes/:id/anular', (req, res) => emitirDesde(req, res, 'anular'));
router.post('/comprobantes/:id/refacturar', (req, res) => emitirDesde(req, res, 'refacturar'));

// Uso y límites del usuario
router.get('/uso', async (req: Request, res: Response) => {
  const u = usuarioDe(req)!;
  if (esAdmin(u)) return res.json({ success: true, sinLimites: true, uso: await usoDe(u.id) });
  res.json({ success: true, sinLimites: false, limites: limitesDe(u.id), uso: await usoDe(u.id) });
});

router.get('/comprobantes/:id/pdf', async (req: Request, res: Response) => {
  if (!(await comprobanteVisibleAsync(req, String(req.params.id)))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const r = await comprobantesService.pdf(String(req.params.id));
  if (!r.ok) return res.status(404).json({ success: false, message: r.mensaje });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.nombre)}"`);
  res.send(r.buffer);
});

// Enlace temporal para abrir el PDF en una pestaña nueva (sin la sesión en la URL)
router.post('/comprobantes/:id/enlace', async (req: Request, res: Response) => {
  if (!(await comprobanteVisibleAsync(req, String(req.params.id)))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
  const r = await comprobantesService.pdf(String(req.params.id));
  if (!r.ok) return res.status(404).json({ success: false, message: r.mensaje });
  res.json({ success: true, url: crearEnlace(r.buffer, r.nombre) });
});

router.post('/comprobantes/:id/enviar', async (req: Request, res: Response) => {
  if (!(await comprobanteVisibleAsync(req, String(req.params.id)))) return res.status(404).json({ success: false, message: 'Comprobante no encontrado.' });
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
