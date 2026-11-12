import { ArcaSessionResult } from '../arcaSession.js';
import { logger } from '../../services/logger.js';
import { Page, Locator } from 'playwright';
import { storageService } from '../../services/storageService.js';
import { mailService } from '../../services/mailService.js';

export interface FacturaRequest {
  puntoVenta: number;
  tipoComprobante: 'Factura C' | 'Factura B' | 'Factura A' | 'Recibo C' | 'Nota de Crédito C' | 'Nota de Crédito A' | 'Nota de Crédito B';
  concepto: 1 | 2 | 3; // 1: Productos, 2: Servicios, 3: Productos y Servicios
  fechaEmision?: string; // YYYY-MM-DD o DD/MM/YYYY
  periodoDesde?: string;
  periodoHasta?: string;
  vencimientoPago?: string;
  cuitEmisor?: string;
  razonSocialEmisor?: string;
  receptor: {
    tipoDoc: 'CUIT' | 'CUIL' | 'CDI' | 'DNI' | 'Pasaporte' | 'Consumidor Final' | 'Sin Identificar';
    nroDoc?: string;
    razonSocial?: string;
    condicionIva: 'Responsable Inscripto' | 'Monotributo' | 'Consumidor Final' | 'Exento' | string;
    domicilio?: string;
    email?: string;
  };
  condicionVenta: 'Contado' | 'Tarjeta de Débito' | 'Tarjeta de Crédito' | 'Cuenta Corriente' | 'Cheque' | 'Transferencia' | 'Otra';
  comprobanteAsociado?: {
    tipo: string;
    puntoVenta: number;
    numero: string;
  };
  items: Array<{
    codigo?: string;
    descripcion: string;
    cantidad: number;
    unidadMedida?: string;
    precioUnitario: number;
    bonificacionPorcentaje?: number;
    alicuotaIva?: string;
    subtotal: number;
  }>;
}

export interface FacturaResponse {
  success: boolean;
  message: string;
  cae?: string;
  caeVencimiento?: string;
  comprobanteNro?: string;
  puntoVenta?: number;
  tipoComprobante?: string;
  totalImporte?: number;
  fechaEmision?: string;
  pdfUrl?: string;
  pdfBufferBase64?: string;
  emailEnviado?: boolean;
}

export interface PadronResult {
  success: boolean;
  docNro: string;
  razonSocial?: string;
  domicilio?: string;
  condicionIva?: string;
  estado?: string;
  error?: string;
}

/*
 * Flujo de "Comprobantes en línea" (RCEL) portado de ARCABOT Facturador
 * (agente/motor_arca.py), que ya está probado contra ARCA real. Reglas que vienen de ahí:
 *
 * - Los campos se ubican por el TEXTO de su etiqueta ("Punto de Ventas a utilizar",
 *   "Conceptos a incluír", ...) y no por ids internos: los JSP de ARCA no son estables.
 * - Cada "Continuar" navega a otra página .do: se espera la navegación y después se
 *   busca el cartel rojo "Error:" que ARCA muestra cuando rechaza el paso.
 * - Paso 2: ARCA ya autocompleta la fecha, el período facturado y el vencimiento de
 *   pago. No se tocan salvo que la factura traiga fechas explícitas.
 * - La confirmación es doble: "Confirmar Datos" -> "¿Confirma la Operación?" -> "Confirmar".
 * - La pantalla "Comprobante Generado" no muestra el número como texto: sale del
 *   nombre del PDF que descarga "Imprimir" ({cuit}_{tipo}_{numero}.pdf).
 *
 * IMPORTANTE: nunca pasar strings a page.evaluate() con sintaxis TypeScript (`as any`):
 * el navegador los ejecuta tal cual y fallan con SyntaxError. Usar funciones.
 */

const URL_RCEL_MENU = 'https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp';
const URL_RCEL_EMPRESAS = 'https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp';

const CONCEPTO_LABEL: Record<number, string> = {
  1: 'Productos',
  2: 'Servicios',
  3: 'Productos y Servicios',
};

// Texto de cada opción de "Condición frente al IVA" en ARCA, según lo que manda el panel
const CONDICION_IVA_ARCA: Record<string, string[]> = {
  'responsable inscripto': ['IVA Responsable Inscripto', 'Responsable Inscripto'],
  'monotributo': ['Responsable Monotributo', 'Monotributista Social', 'Monotributo'],
  'exento': ['IVA Sujeto Exento', 'Exento'],
  'consumidor final': ['Consumidor Final'],
};

// Texto exacto de cada opción del combo "Alícuota IVA" en ARCA (solo Factura A/B)
const ALICUOTAS_IVA: Record<string, string> = {
  'no gravado': 'No gravado',
  'exento': 'Exento',
  '0': '0%',
  '2.5': '2,5%',
  '5': '5%',
  '10.5': '10,5%',
  '21': '21%',
  '27': '27%',
};

/** Página RCEL -> última empresa representada elegida en ella (para re-elegir si cambia el CUIT). */
const empresaPorPagina = new WeakMap<Page, string>();

function normalizarTexto(texto: string): string {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '') // "S.R.L." == "SRL", "S.A." == "SA"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** El <select> que aparece después del texto de una etiqueta (los JSP de ARCA no asocian <label>). */
function selectDespuesDe(page: Page, textoLabel: string): Locator {
  return page.getByText(textoLabel, { exact: false }).first().locator('xpath=following::select[1]');
}

/** El <input> que aparece después del texto de una etiqueta. */
function inputDespuesDe(page: Page, textoLabel: string): Locator {
  return page.getByText(textoLabel, { exact: false }).first().locator('xpath=following::input[1]');
}

/**
 * Elige la opción cuyo texto visible coincide (sin mayúsculas/acentos) con alguno de los
 * candidatos. Reintenta durante `timeoutMs` porque algunos combos se repueblan por AJAX
 * (ej. "Tipo de Comprobante" depende del punto de venta recién elegido).
 * Con `permitirContiene`, como último recurso acepta una opción que contenga el candidato.
 */
async function seleccionarPorLabel(
  select: Locator,
  candidatos: string[],
  opts: { timeoutMs?: number; permitirContiene?: boolean; prefijo?: boolean } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const buscados = candidatos.map(normalizarTexto).filter(Boolean);
  const limite = Date.now() + timeoutMs;
  let opciones: string[] = [];

  await select.waitFor({ state: 'attached', timeout: timeoutMs });
  while (true) {
    opciones = await select.locator('option').allTextContents();
    const norm = opciones.map(normalizarTexto);

    for (const b of buscados) {
      const idx = opts.prefijo ? norm.findIndex(o => o.startsWith(b)) : norm.findIndex(o => o === b);
      if (idx !== -1) {
        await select.selectOption({ label: opciones[idx].trim() }).catch(async () => {
          await select.selectOption({ index: idx });
        });
        return opciones[idx].trim();
      }
    }
    if (opts.permitirContiene) {
      for (const b of buscados) {
        const idx = norm.findIndex(o => o.includes(b));
        if (idx !== -1) {
          await select.selectOption({ index: idx });
          return opciones[idx].trim();
        }
      }
    }
    if (Date.now() >= limite) break;
    await select.page().waitForTimeout(250);
  }
  const disponibles = opciones.map(o => o.trim()).filter(Boolean).join(', ');
  throw new Error(`No encontré la opción "${candidatos[0]}". Disponibles en ARCA: ${disponibles || '(ninguna)'}.`);
}

/** Después de un "Continuar", ARCA a veces vuelve a mostrar la pantalla con un cartel rojo "Error: ...". */
async function verificarSinErrorArca(page: Page, paso: string) {
  const cartel = page.getByText('Error:', { exact: false }).first();
  const texto = await cartel.textContent({ timeout: 2000 }).catch(() => null);
  if (texto && texto.trim()) {
    throw new Error(`ARCA no aceptó el ${paso}: ${texto.trim()}`);
  }
}

/** Click en "Continuar" esperando que cargue la siguiente página .do del asistente. */
async function clickContinuar(page: Page, paso: string) {
  const urlAntes = page.url();
  const boton = page.getByText('Continuar', { exact: false }).first();
  await boton.waitFor({ state: 'visible', timeout: 10000 });

  const avisos: string[] = [];
  const onDialog = async (dialog: any) => {
    avisos.push(dialog.message());
    logger.warn('FACTURACION-API', `ARCA mostró un aviso en ${paso}: "${dialog.message()}"`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      boton.click(),
    ]);
  } catch (err: any) {
    const detalle = avisos.length ? ` Aviso de ARCA: ${avisos.join(' | ')}` : '';
    throw new Error(`ARCA no avanzó desde el ${paso} (sigue en ${urlAntes}).${detalle}`);
  } finally {
    page.off('dialog', onDialog);
  }
  await verificarSinErrorArca(page, paso);
  logger.info('FACTURACION-API', `${paso} OK -> ${page.url()}`);
}

/** Setea un input de fecha (puede ser readonly con calendario) y dispara los eventos de ARCA. */
async function setFecha(page: Page, selector: string, valor: string): Promise<boolean> {
  const input = page.locator(selector).first();
  if (!(await input.count())) return false;
  // (tsconfig no incluye la lib DOM, por eso el elemento va tipado como any)
  await input.evaluate((el: any, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, valor);
  return true;
}

class FacturacionInternalApiModule {
  /**
   * Consulta padrón receptor directo por endpoint interno de RCEL / ARCA
   * Ejecutado in-page con cookies vivas
   */
  public async consultarPadronInPage(page: Page, tipoDoc: string, nroDoc: string): Promise<PadronResult> {
    const cleanDoc = String(nroDoc || '').replace(/\D/g, '');
    if (!cleanDoc) {
      return { success: false, docNro: '', error: 'Número de documento vacío' };
    }

    try {
      const res: any = await page.evaluate(async ({ doc, tipo }) => {
        try {
          const url = `/rcel/consultarPadron.do?nroDoc=${encodeURIComponent(doc)}&tipoDoc=${encodeURIComponent(tipo)}&_=${Date.now()}`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json, text/javascript, */*; q=0.01',
              'X-Requested-With': 'XMLHttpRequest',
            },
            credentials: 'include',
          });

          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('json')) {
              const data = await response.json();
              return { success: true, data };
            }
            const text = await response.text();
            return { success: true, rawText: text };
          }

          return { success: false, status: response.status, statusText: response.statusText };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }, { doc: cleanDoc, tipo: tipoDoc });

      if (res.success && res.data) {
        return {
          success: true,
          docNro: cleanDoc,
          razonSocial: res.data.denominacion || res.data.razonSocial || res.data.nombre,
          domicilio: res.data.domicilioFiscal || res.data.domicilio,
          condicionIva: res.data.condicionIva || res.data.impuesto,
        };
      }

      return {
        success: true,
        docNro: cleanDoc,
      };
    } catch (err: any) {
      logger.warn('PADRON-API', `Aviso en consulta interna de padrón: ${err.message}`);
      return { success: false, docNro: cleanDoc, error: err.message };
    }
  }

  /**
   * Emite un comprobante en "Comprobantes en línea" de ARCA completando el asistente
   * real de RCEL con Playwright (mismo recorrido que ARCABOT).
   */
  public async emitirFactura(session: ArcaSessionResult, datos: FacturaRequest): Promise<FacturaResponse> {
    logger.info('FACTURACION-API', `Iniciando emisión de ${datos.tipoComprobante} - Pto Venta: ${datos.puntoVenta}...`);

    // Validaciones antes de tocar ARCA
    if (!datos.items || datos.items.length === 0) {
      return { success: false, message: 'La factura no tiene ítems.' };
    }
    if (datos.items.length > 1) {
      // RCEL carga una fila por ítem; por ahora solo está probado el flujo de 1 ítem (igual que ARCABOT).
      // Antes se emitía solo el primero en silencio, con un total distinto al cargado.
      return {
        success: false,
        message: `Por ahora BotArca emite un solo ítem por comprobante y esta factura tiene ${datos.items.length}. Unificalos en una línea o emitilos por separado.`,
      };
    }
    if (!CONCEPTO_LABEL[datos.concepto]) {
      return { success: false, message: `Concepto inválido: ${datos.concepto}.` };
    }

    let page: Page | null = null;
    let createdPageLocally = false;
    let confirmacionEnviada = false; // a partir de acá el comprobante puede haber quedado emitido en ARCA
    const targetCuit = (datos.cuitEmisor || session.cuit || '').replace(/\D/g, '');

    try {
      if (session.page && !session.page.isClosed()) {
        page = session.page;
      } else if (session.context) {
        const existente = session.context.pages().find(p => !p.isClosed() && p.url().includes('fe.afip.gob.ar'));
        if (existente) {
          page = existente;
        } else {
          page = await session.context.newPage();
          createdPageLocally = true;
        }
      } else {
        throw new Error('No hay contexto de sesión activo en ARCA.');
      }

      // 1. Llegar a RCEL (fe.afip.gob.ar/rcel)
      page = await this.abrirRcel(page);

      // 2. Empresa representada + menú principal + "Generar Comprobantes"
      await this.posicionarEnGenerarComprobantes(page, targetCuit, datos.razonSocialEmisor);

      // 3. Consulta previa de padrón receptor (informativa, no bloquea)
      if (datos.receptor.nroDoc && datos.receptor.tipoDoc !== 'Consumidor Final') {
        const padron = await this.consultarPadronInPage(page, datos.receptor.tipoDoc, datos.receptor.nroDoc);
        if (padron.success && padron.razonSocial) {
          datos.receptor.razonSocial = datos.receptor.razonSocial || padron.razonSocial;
          if (padron.domicilio && !datos.receptor.domicilio) datos.receptor.domicilio = padron.domicilio;
          logger.info('FACTURACION-API', `Padrón receptor: ${padron.razonSocial} (${datos.receptor.nroDoc})`);
        }
      }

      // 4. Asistente de RCEL
      await this.paso1PuntoVentaYTipo(page, datos);
      await this.paso2DatosEmision(page, datos);
      await this.paso3DatosReceptor(page, datos);
      await this.paso4Items(page, datos);

      // 5. Confirmación doble (PUNTO DE NO RETORNO)
      logger.info('FACTURACION-API', `Resumen de datos alcanzado: ${page.url()}. Confirmando...`);
      await page.getByText('Confirmar Datos', { exact: false }).first().click({ timeout: 15000 });
      await page.getByText('¿Confirma la Operación?', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });

      // Por si además aparece un confirm() nativo
      page.once('dialog', async dialog => {
        logger.info('FACTURACION-API', `Dialog de ARCA: "${dialog.message()}". Aceptando...`);
        await dialog.accept().catch(() => {});
      });
      confirmacionEnviada = true;
      await page.getByText('Confirmar', { exact: true }).first().click({ timeout: 15000 });
      await page.getByText('Comprobante Generado', { exact: false }).first().waitFor({ state: 'visible', timeout: 60000 });
      logger.success('FACTURACION-API', 'ARCA confirmó: "Comprobante Generado".');

      // 6. Datos del comprobante generado (best effort: el comprobante YA está emitido)
      const textoPagina = (await page.locator('body').innerText().catch(() => '')) || '';
      const caeMatch = textoPagina.match(/C\.?A\.?E\.?[^0-9]{0,80}?(\d{14})(?!\d)/i);
      const vtoMatch = textoPagina.match(/V(?:enc|to)[^0-9]{0,80}?(\d{2}\/\d{2}\/\d{4})/i);
      const cae = caeMatch ? caeMatch[1] : '';
      const caeVencimiento = vtoMatch ? vtoMatch[1] : '';
      if (!cae) logger.warn('FACTURACION-API', 'El comprobante se generó pero no pude leer el CAE en pantalla (queda en el PDF).');

      // 7. PDF: "Imprimir" descarga {cuit}_{tipo}_{numero}.pdf -> de ahí sale el número
      let pdfBase64: string | null = null;
      let numeroComprobante = '';
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }),
          page.getByText('Imprimir', { exact: false }).first().click({ timeout: 10000 }),
        ]);
        const m = download.suggestedFilename().match(/_(\d+)\.pdf$/i);
        if (m) numeroComprobante = m[1].padStart(8, '0');
        const stream = await download.createReadStream();
        if (stream) {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          pdfBase64 = Buffer.concat(chunks).toString('base64');
        }
      } catch (errPdf: any) {
        logger.warn('FACTURACION-API', `No se pudo descargar el PDF: ${errPdf.message}`);
      }
      if (!numeroComprobante) logger.warn('FACTURACION-API', 'No pude obtener el número de comprobante (revisalo en ARCA).');

      // Volver al menú principal para la próxima factura (ARCA no vuelve sola)
      await page.getByText('Menú Principal', { exact: false }).first().click({ timeout: 5000 }).catch(() => {});

      const numeroFormateado = `${String(datos.puntoVenta).padStart(4, '0')}-${numeroComprobante || 'S/N'}`;
      logger.success('FACTURACION-API', `Comprobante ${numeroFormateado} emitido. CAE: ${cae || '(no leído)'} Vto: ${caeVencimiento || '-'}`);

      const total = datos.items.reduce((acc, curr) => acc + (curr.cantidad * curr.precioUnitario), 0);

      // 8. Guardar PDF en Storage
      let publicPdfUrl = '';
      if (pdfBase64) {
        const filename = `factura_${targetCuit}_${numeroFormateado}.pdf`;
        try {
          const uploadRes = await storageService.uploadAttachment({
            filename,
            base64: pdfBase64,
            contentType: 'application/pdf',
            cuit: targetCuit,
            isPublic: true,
          });
          if (uploadRes.success && uploadRes.publicUrl) {
            publicPdfUrl = uploadRes.publicUrl;
            logger.success('FACTURACION-API', `PDF almacenado en Supabase Storage: ${publicPdfUrl}`);
          }
        } catch (err: any) {
          logger.warn('FACTURACION-API', `No se pudo subir PDF a Storage: ${err.message}`);
        }
      }

      // 9. Envío por mail al cliente si hay email
      let emailEnviado = false;
      if (datos.receptor.email && (publicPdfUrl || pdfBase64)) {
        try {
          const mailRes = await mailService.sendMail({
            to: datos.receptor.email,
            subject: `Comprobante Electrónico ${datos.tipoComprobante} N° ${numeroFormateado}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
                <h2 style="color: #4f46e5;">Comprobante Electrónico Autorizado</h2>
                <p>Estimado/a <strong>${datos.receptor.razonSocial || 'Cliente'}</strong>,</p>
                <p>Le informamos que se ha emitido un comprobante a su nombre con los siguientes datos:</p>
                <ul>
                  <li><strong>Tipo:</strong> ${datos.tipoComprobante}</li>
                  <li><strong>Número:</strong> ${numeroFormateado}</li>
                  ${cae ? `<li><strong>CAE:</strong> ${cae}${caeVencimiento ? ` (Vto: ${caeVencimiento})` : ''}</li>` : ''}
                  <li><strong>Importe Total:</strong> $${total.toFixed(2)}</li>
                </ul>
                <p>Adjuntamos el documento digital correspondiente.</p>
              </div>
            `,
            attachments: [
              {
                filename: `${numeroFormateado}.pdf`,
                content: pdfBase64 || undefined,
                path: publicPdfUrl || undefined,
                contentType: 'application/pdf',
              }
            ],
          });
          emailEnviado = mailRes.success;
          if (emailEnviado) logger.success('FACTURACION-API', `Comprobante enviado a ${datos.receptor.email}.`);
        } catch (err: any) {
          logger.warn('FACTURACION-API', `Aviso al enviar correo al cliente: ${err.message}`);
        }
      }

      if (createdPageLocally && page) {
        await page.close().catch(() => {});
      }

      return {
        success: true,
        message: cae
          ? 'Comprobante emitido en ARCA'
          : 'Comprobante emitido en ARCA (no se pudo leer el CAE en pantalla: verificalo en el PDF o en "Consultas" de RCEL)',
        cae: cae || undefined,
        caeVencimiento: caeVencimiento || undefined,
        comprobanteNro: numeroFormateado,
        puntoVenta: datos.puntoVenta,
        tipoComprobante: datos.tipoComprobante,
        totalImporte: total,
        fechaEmision: datos.fechaEmision || new Date().toISOString().split('T')[0],
        pdfUrl: publicPdfUrl || undefined,
        pdfBufferBase64: pdfBase64 || undefined,
        emailEnviado,
      };

    } catch (err: any) {
      logger.error('FACTURACION-API', `Fallo en la emisión: ${err.message}`);
      const urlActual = page && !page.isClosed() ? page.url() : '?';
      if (createdPageLocally && page) {
        await page.close().catch(() => {});
      } else if (page && !page.isClosed() && !confirmacionEnviada) {
        // Dejar RCEL en el menú principal para que el próximo intento arranque limpio
        await page.goto(URL_RCEL_MENU, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      if (confirmacionEnviada) {
        return {
          success: false,
          message: `ATENCIÓN: se presionó "Confirmar" en ARCA pero no se pudo verificar el resultado (${err.message}). ` +
            'El comprobante PUEDE haber quedado emitido: revisá "Consultas" en Comprobantes en línea antes de reintentar, para no duplicarlo.',
        };
      }
      return {
        success: false,
        message: `No se emitió el comprobante: ${err.message} (URL: ${urlActual})`,
      };
    }
  }

  /** Lleva la página a RCEL: si no está, abre "Comprobantes en línea" desde el portal de ARCA. */
  private async abrirRcel(page: Page): Promise<Page> {
    if (page.url().includes('fe.afip.gob.ar')) return page;

    const yaAbierta = page.context().pages().find(p => !p.isClosed() && p.url().includes('fe.afip.gob.ar'));
    if (yaAbierta) return yaAbierta;

    logger.info('FACTURACION-API', 'Abriendo "Comprobantes en línea" desde el portal de ARCA...');
    if (!page.url().includes('portalcf.cloud.afip.gob.ar')) {
      await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
    if (page.url().includes('auth.afip.gob.ar')) {
      throw new Error('La sesión de ARCA expiró (el portal redirigió al login).');
    }

    // Buscador de servicios del portal (selectores confirmados en ARCABOT primero)
    const buscador = page.locator('#buscador, input.rbt-input-main, #buscadorServicios, input[placeholder*="Buscar" i], input[placeholder*="servicio" i], input[type="search"], input[aria-label*="Buscar" i]').first();
    if (await buscador.isVisible({ timeout: 5000 }).catch(() => false)) {
      await buscador.click();
      await buscador.fill('');
      await buscador.type('COMPROBANTES EN LINEA', { delay: 40 });
      await page.waitForTimeout(1000);
    } else {
      logger.warn('FACTURACION-API', 'No encontré el buscador del portal; busco el enlace directo.');
    }

    const regexServicio = /Comprobantes en l[ií]nea/i;
    const candidatos = [
      page.locator('.rbt-menu .dropdown-item, .dropdown-menu .dropdown-item').filter({ hasText: regexServicio }),
      page.locator('a, button, div, span').filter({ hasText: regexServicio }),
    ];

    let rcel: Page | null = null;
    for (const loc of candidatos) {
      const opcion = loc.first();
      if (!(await opcion.isVisible({ timeout: 3000 }).catch(() => false))) continue;
      const [nueva] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
        opcion.click().catch(() => {}),
      ]);
      rcel = nueva || page.context().pages().find(p => p.url().includes('fe.afip.gob.ar')) || null;
      if (rcel) break;
    }
    if (!rcel && page.url().includes('fe.afip.gob.ar')) rcel = page;
    if (!rcel) {
      throw new Error('No se pudo abrir "Comprobantes en línea" desde el portal de ARCA. Verificá que el servicio esté habilitado para este CUIT.');
    }
    await rcel.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    logger.info('FACTURACION-API', `RCEL abierto: ${rcel.url()}`);
    return rcel;
  }

  private async estaEnSeleccionEmpresa(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes('index_bis') || url.includes('index_relacion') || url.includes('/rcel/jsp/index')) return true;
    if ((await page.locator('input.btn_empresa, input.btn_empresa_padre').count().catch(() => 0)) > 0) return true;
    return (await page.getByText('Seleccione la Empresa a representar', { exact: false }).count().catch(() => 0)) > 0;
  }

  /**
   * Pantalla "Seleccione la Empresa a representar". Igual que ARCABOT: si hay una sola
   * empresa se elige; si hay varias se busca por razón social y después por CUIT.
   * Si no hay coincidencia segura NO se adivina (antes se tomaba la primera = riesgo de
   * facturar con otro emisor).
   */
  private async seleccionarEmpresaRepresentada(page: Page, cuit: string, razonSocial?: string) {
    logger.info('FACTURACION-API', 'Pantalla de selección de empresa representada detectada.');
    await page.waitForSelector('input.btn_empresa, input.btn_empresa_padre, input[type="button"], input[type="submit"], button', { timeout: 8000 }).catch(() => {});

    const excluidas = new Set(['volver', 'salir', 'ayuda', 'cerrar', 'cancelar']);
    const botones: Array<{ loc: Locator; texto: string; html: string }> = [];
    for (const b of await page.locator('input.btn_empresa, input.btn_empresa_padre, input[type="button"], input[type="submit"], button').all()) {
      const texto = ((await b.getAttribute('value').catch(() => null)) || (await b.textContent().catch(() => null)) || '').trim();
      if (!texto || excluidas.has(texto.toLowerCase())) continue;
      const html = await b.evaluate((el: any) => String(el.outerHTML || '')).catch(() => '');
      botones.push({ loc: b, texto, html });
    }
    if (botones.length === 0) {
      throw new Error('No encontré empresas para representar en "Comprobantes en línea".');
    }

    let elegido = botones.length === 1 ? botones[0] : undefined;

    if (!elegido && razonSocial) {
      const rs = normalizarTexto(razonSocial);
      elegido = botones.find(b => normalizarTexto(b.texto) === rs)
        || botones.find(b => normalizarTexto(b.texto).includes(rs) || rs.includes(normalizarTexto(b.texto)));
    }
    if (!elegido && cuit) {
      elegido = botones.find(b => b.texto.replace(/\D/g, '').includes(cuit) || b.html.replace(/-/g, '').includes(cuit));
    }
    if (!elegido) {
      const disponibles = botones.map(b => `"${b.texto}"`).join(', ');
      throw new Error(`Hay varias empresas para representar (${disponibles}) y ninguna coincide con CUIT ${cuit}${razonSocial ? ` / "${razonSocial}"` : ''}. Revisá la razón social cargada en la cuenta.`);
    }

    logger.info('FACTURACION-API', `Seleccionando empresa representada: "${elegido.texto}"`);
    await elegido.loc.click({ timeout: 8000 }).catch(async () => {
      await elegido!.loc.dispatchEvent('click');
    });
    await page.getByText('Generar Comprobantes', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
    empresaPorPagina.set(page, cuit);
  }

  /** Deja la página en "Punto de venta y tipo de comprobante" (buscarPtosVtas.do). */
  private async posicionarEnGenerarComprobantes(page: Page, cuit: string, razonSocial?: string) {
    // Si en esta página ya se eligió OTRA empresa, volver a la pantalla de selección
    const anterior = empresaPorPagina.get(page);
    if (anterior && cuit && anterior !== cuit) {
      logger.info('FACTURACION-API', `Cambio de CUIT emisor (${anterior} -> ${cuit}). Volviendo a elegir empresa...`);
      await page.goto(URL_RCEL_EMPRESAS, { waitUntil: 'domcontentloaded' });
    }

    if (await this.estaEnSeleccionEmpresa(page)) {
      await this.seleccionarEmpresaRepresentada(page, cuit, razonSocial);
    }

    if (page.url().includes('buscarPtosVtas.do')) return;

    let btnGenerar = page.getByText('Generar Comprobantes', { exact: false }).first();
    if (!(await btnGenerar.isVisible({ timeout: 3000 }).catch(() => false))) {
      // Quedó en una pantalla intermedia (ej. una factura anterior que falló a mitad): ir al menú
      logger.info('FACTURACION-API', `RCEL no está en el menú principal (${page.url()}). Navegando al menú...`);
      await page.goto(URL_RCEL_MENU, { waitUntil: 'domcontentloaded' });
      if (await this.estaEnSeleccionEmpresa(page)) {
        await this.seleccionarEmpresaRepresentada(page, cuit, razonSocial);
      }
      btnGenerar = page.getByText('Generar Comprobantes', { exact: false }).first();
    }
    await btnGenerar.waitFor({ state: 'visible', timeout: 15000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      btnGenerar.click(),
    ]);
    logger.info('FACTURACION-API', `En "Generar Comprobantes": ${page.url()}`);
  }

  /** Paso 1 (buscarPtosVtas.do): punto de venta y tipo de comprobante. */
  private async paso1PuntoVentaYTipo(page: Page, datos: FacturaRequest) {
    // El panel manda "1"; ARCA muestra la opción como "00001-Domicilio..."
    const pv = String(datos.puntoVenta).padStart(5, '0');
    const elegido = await seleccionarPorLabel(selectDespuesDe(page, 'Punto de Ventas a utilizar'), [pv], { prefijo: true });
    logger.info('FACTURACION-API', `Punto de venta: ${elegido}`);

    await seleccionarPorLabel(selectDespuesDe(page, 'Tipo de Comprobante'), [datos.tipoComprobante]);
    await clickContinuar(page, 'Paso 1 (Punto de venta / Tipo de comprobante)');
  }

  /** Paso 2 (genComDatosEmisor.do): concepto. Las fechas las autocompleta ARCA. */
  private async paso2DatosEmision(page: Page, datos: FacturaRequest) {
    await seleccionarPorLabel(selectDespuesDe(page, 'Conceptos a incluír'), [CONCEPTO_LABEL[datos.concepto]]); // tilde real de ARCA
    await page.waitForTimeout(800); // el onchange de ARCA muestra/oculta los campos de servicios

    // Actividad asociada: solo si ARCA la muestra y está vacía (contribuyentes con varias actividades)
    const actividad = page.locator('select#actiAsociadaId, select[name="actiAsociadaId"]').first();
    if (await actividad.isVisible({ timeout: 1500 }).catch(() => false)) {
      const actual = await actividad.inputValue().catch(() => '');
      if (!actual) {
        const opciones = await actividad.locator('option').evaluateAll((els: any[]) => els.map(e => String(e.value || '')));
        const idx = opciones.findIndex(v => v.trim() !== '');
        if (idx !== -1) {
          await actividad.selectOption({ index: idx });
          logger.info('FACTURACION-API', `Actividad asociada seleccionada: ${opciones[idx]}`);
        }
      }
    }

    // Solo pisar las fechas que ARCA autocompleta si la factura trae fechas explícitas
    if (datos.fechaEmision) {
      await setFecha(page, 'input#fc, input[name="fechaEmisionComprobante"]', this.formatDateForRcel(datos.fechaEmision));
    }
    if (datos.concepto === 2 || datos.concepto === 3) {
      if (datos.periodoDesde) await setFecha(page, 'input#fsd, input[name="periodoFacturadoDesde"]', this.formatDateForRcel(datos.periodoDesde));
      if (datos.periodoHasta) await setFecha(page, 'input#fsh, input[name="periodoFacturadoHasta"]', this.formatDateForRcel(datos.periodoHasta));
      if (datos.vencimientoPago) await setFecha(page, 'input#vencimientopago, input[name="vencimientoPago"]', this.formatDateForRcel(datos.vencimientoPago));
    }

    await clickContinuar(page, 'Paso 2 (Datos de emisión)');
  }

  /**
   * A veces, después de escribir el documento del receptor, ARCA abre su propio pop-up
   * "Confirmación de datos" con la persona encontrada. Hay que aceptarlo para que se
   * complete el nombre (comportamiento confirmado en vivo en ARCABOT).
   */
  private async confirmarDatosReceptorSiAparece(page: Page) {
    const titulo = page.getByText('Confirmación de datos', { exact: false }).first();
    if (!(await titulo.isVisible({ timeout: 2000 }).catch(() => false))) return;
    await page.getByText('Aceptar', { exact: true }).first().click({ timeout: 2000 });
    await titulo.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    logger.info('FACTURACION-API', 'ARCA pidió confirmar los datos del receptor: aceptado.');
  }

  /** Paso 3 (genComDatosReceptor.do): condición IVA, documento, domicilio y condición de venta. */
  private async paso3DatosReceptor(page: Page, datos: FacturaRequest) {
    const condKey = normalizarTexto(datos.receptor.condicionIva || 'Consumidor Final');
    const candidatosIva = Object.entries(CONDICION_IVA_ARCA).find(([k]) => condKey.includes(k))?.[1]
      || [datos.receptor.condicionIva];
    await seleccionarPorLabel(selectDespuesDe(page, 'Condición frente al IVA'), candidatosIva, { permitirContiene: true });

    const nroDoc = String(datos.receptor.nroDoc || '').replace(/\D/g, '');
    const conDocumento = !!nroDoc && datos.receptor.tipoDoc !== 'Consumidor Final' && datos.receptor.tipoDoc !== 'Sin Identificar';
    const inputNombre = inputDespuesDe(page, 'A. y Nombre o Razón Social');

    if (conDocumento) {
      const selectTipoDoc = selectDespuesDe(page, 'Tipo y Nro. de Documento');
      await seleccionarPorLabel(selectTipoDoc, [datos.receptor.tipoDoc]);
      const inputNroDoc = selectTipoDoc.locator('xpath=following::input[1]');
      await inputNroDoc.fill(nroDoc);
      await inputNroDoc.press('Tab'); // dispara el autocompletado de ARCA
      await page.waitForTimeout(1000);
      await this.confirmarDatosReceptorSiAparece(page);

      const nombreArca = ((await inputNombre.inputValue().catch(() => '')) || '').trim();
      logger.info('FACTURACION-API', `ARCA devolvió para ${datos.receptor.tipoDoc} ${nroDoc}: "${nombreArca || '(vacío)'}"`);
      if (!nombreArca && datos.receptor.razonSocial && (await inputNombre.isEditable().catch(() => false))) {
        await inputNombre.fill(datos.receptor.razonSocial);
      }
    } else if (datos.receptor.razonSocial && (await inputNombre.isEditable({ timeout: 1000 }).catch(() => false))) {
      await inputNombre.fill(datos.receptor.razonSocial);
    }

    // "Domicilio Comercial": hay un <select> oculto antes del input real. Si ARCA lo
    // autocompletó desde el padrón queda readonly y no se toca.
    if (datos.receptor.domicilio) {
      const inputDomicilio = inputDespuesDe(page, 'Domicilio Comercial');
      if ((await inputDomicilio.count()) && (await inputDomicilio.getAttribute('readonly')) === null) {
        await inputDomicilio.fill(datos.receptor.domicilio);
      }
    }

    // Condiciones de venta: son CHECKBOXES, el que está antes del texto de la opción
    const condicionVenta = datos.condicionVenta || 'Contado';
    const checkVenta = page.getByText(condicionVenta, { exact: false }).first().locator("xpath=preceding::input[@type='checkbox'][1]");
    await checkVenta.check({ timeout: 5000 });

    await this.completarComprobanteAsociado(page, datos);
    await clickContinuar(page, 'Paso 3 (Datos del receptor)');
  }

  /** Comprobante asociado (Notas de Crédito/Débito). Selectores confirmados en ARCABOT. */
  private async completarComprobanteAsociado(page: Page, datos: FacturaRequest) {
    const asociado = datos.comprobanteAsociado;
    if (!asociado || !String(asociado.numero || '').trim()) return;
    await seleccionarPorLabel(page.locator('select[name="cmpAsociadoTipo"]'), [asociado.tipo]);
    // Pto. Vta. con 5 dígitos (maxlength=5 y validador de ARCA)
    await page.locator('input[name="cmpAsociadoPtoVta"]').fill(String(asociado.puntoVenta).padStart(5, '0'));
    await page.locator('input[name="cmpAsociadoNro"]').fill(String(asociado.numero).trim());
  }

  /** Paso 4 (genComDatosOperacion.do): un ítem, ubicado por el `name` real de cada campo. */
  private async paso4Items(page: Page, datos: FacturaRequest) {
    const item = datos.items[0];
    // La fila de carga es la que está justo antes de "Agregar línea descripción"
    const fila = page.getByText('Agregar línea descripción', { exact: false }).first().locator('xpath=preceding::tr[1]');

    await fila.locator('[name="detalleDescripcion"]').fill(String(item.descripcion));
    await fila.locator('[name="detalleCantidad"]').fill(String(item.cantidad || 1));
    const medida = fila.locator('[name="detalleMedida"]');
    if (await medida.count()) {
      await seleccionarPorLabel(medida, [item.unidadMedida || 'unidades']);
    }
    await fila.locator('[name="detallePrecio"]').fill(String(item.precioUnitario));

    // Alícuota IVA: solo existe como <select> en comprobantes que discriminan IVA (A/B)
    const alicuota = fila.locator('[name="detalleTipoIVA"]');
    if (await alicuota.count()) {
      await seleccionarPorLabel(alicuota, [this.labelAlicuotaIva(item.alicuotaIva ?? '21')]);
    }

    await clickContinuar(page, 'Paso 4 (Ítems)');
  }

  private labelAlicuotaIva(valor: string | number): string {
    const texto = String(valor).trim().toLowerCase().replace(/%$/, '').trim();
    if (ALICUOTAS_IVA[texto]) return ALICUOTAS_IVA[texto];
    const num = parseFloat(texto.replace(',', '.'));
    if (!isNaN(num) && ALICUOTAS_IVA[String(num)]) return ALICUOTAS_IVA[String(num)];
    throw new Error(`Alícuota de IVA "${valor}" no reconocida.`);
  }

  private formatDateForRcel(d?: string): string {
    if (!d) {
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }
    // Si viene como YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [yyyy, mm, dd] = d.split('-');
      return `${dd}/${mm}/${yyyy}`;
    }
    return d;
  }
}

export const facturacionModule = new FacturacionInternalApiModule();
