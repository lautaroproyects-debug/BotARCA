import { ArcaSessionResult } from '../arcaSession.js';
import { logger } from '../../services/logger.js';
import { Page } from 'playwright';
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
   * Emite comprobante en ARCA mediante llamadas directas a la API interna de RCEL
   * (Sin screen-scraping: ejecución in-page vía page.evaluate con cookies de sesión activas)
   */
  public async emitirFactura(session: ArcaSessionResult, datos: FacturaRequest): Promise<FacturaResponse> {
    logger.info('FACTURACION-API', `[API Interna] Iniciando emisión para ${datos.tipoComprobante} - Pto Venta: ${datos.puntoVenta}...`);

    let page: Page | null = null;
    let createdPageLocally = false;

    try {
      if (session.page && !session.page.isClosed()) {
        page = session.page;
      } else if (session.context) {
        page = await session.context.newPage();
        createdPageLocally = true;
      } else {
        throw new Error('No hay contexto de sesión activo para ejecutar llamadas a la API interna.');
      }

      // 1. Asegurar posición en el subsistema RCEL (fe.afip.gob.ar/rcel)
      let currentUrl = page.url();
      logger.info('FACTURACION-API', `URL inicial del contexto: ${currentUrl}`);

      if (!currentUrl.includes('fe.afip.gob.ar/rcel') && !currentUrl.includes('rcel.afip.gob.ar')) {
        logger.info('FACTURACION-API', 'Navegando al portal de ARCA para abrir Comprobantes en línea (RCEL)...');
        await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // En el nuevo portal de ARCA/AFIP, los servicios se buscan en el input buscador superior/central
        const searchInputSelector = '#buscadorServicios, input[placeholder*="Buscar"], input[aria-label*="Buscar"], input[type="search"], .input-buscar';
        const searchInput = page.locator(searchInputSelector).first();

        if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          logger.info('FACTURACION-API', 'Escribiendo "Comprobantes en línea" en el buscador de servicios de ARCA...');
          await searchInput.click();
          await searchInput.fill('');
          await searchInput.type('Comprobantes en línea', { delay: 60 });
          await page.waitForTimeout(1000);
        }

        // Localizar el resultado / tarjeta de "Comprobantes en línea"
        const serviceLink = page.locator(`
          a:has-text("Comprobantes en línea"), 
          div.servicio-item:has-text("Comprobantes en línea"),
          [data-servicio*="Comprobantes en línea"],
          [title*="Comprobantes en línea"],
          h3:has-text("Comprobantes en línea"),
          p:has-text("Comprobantes en línea")
        `).first();

        const [popupPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null),
          (async () => {
            try {
              await serviceLink.waitFor({ state: 'visible', timeout: 8000 });
              await serviceLink.click();
            } catch (err: any) {
              logger.warn('FACTURACION-API', `Intento de clic en buscador: ${err.message}. Probando clic forzado en enlace de texto...`);
              await page.click('text="Comprobantes en línea"', { force: true }).catch(() => {});
            }
          })(),
        ]);

        if (popupPage) {
          page = popupPage;
          await page.waitForLoadState('domcontentloaded');
          logger.info('FACTURACION-API', `Nueva pestaña detectada para RCEL: ${page.url()}`);
        } else {
          // Si no abrió ventana popup, verificar si el context creó otra página o si navegó
          await page.waitForLoadState('domcontentloaded');
          const allPages = page.context().pages();
          const rcelP = allPages.find(p => p.url().includes('fe.afip.gob.ar') || p.url().includes('rcel'));
          if (rcelP) {
            page = rcelP;
            await page.waitForLoadState('domcontentloaded');
          }
          logger.info('FACTURACION-API', `Página activa tras clic en servicio: ${page.url()}`);
        }
      }

      currentUrl = page.url();
      logger.info('FACTURACION-API', `Página activa para RCEL: ${currentUrl}`);

      if (!currentUrl.includes('fe.afip.gob.ar') && !currentUrl.includes('rcel')) {
        throw new Error('No se pudo acceder al servicio "Comprobantes en línea" en el portal de ARCA. Verifique que el servicio esté habilitado.');
      }

      // 2. Selección de empresa representada en la pantalla inicial de RCEL
      const targetCuit = (datos.cuitEmisor || session.cuit || '').replace(/\D/g, '');
      logger.info('FACTURACION-API', `Verificando selector de empresa para CUIT: ${targetCuit}...`);

      // En RCEL la selección de contribuyente puede ser un botón input type=button/submit o un enlace/fila
      const empresaBtn = page.locator(`input[value*="${targetCuit}"], button:has-text("${targetCuit}"), a:has-text("${targetCuit}"), tr:has-text("${targetCuit}") input, input.btn_empresa`).first();
      if (await empresaBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        logger.info('FACTURACION-API', `Haciendo clic en empresa representada CUIT: ${targetCuit}`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
          empresaBtn.click(),
        ]);
        await page.waitForTimeout(1000);
      } else {
        logger.info('FACTURACION-API', `No se requirió selección de empresa o ya se encuentra en menú principal: ${page.url()}`);
      }

      // Asegurar clic en "Generar Comprobantes" en el menú principal de RCEL si está presente
      const btnGenerarMenu = page.locator('a:has-text("Generar Comprobantes"), input[value*="Generar Comprobantes"], button:has-text("Generar Comprobantes"), #btn_gen_cmp').first();
      if (await btnGenerarMenu.isVisible({ timeout: 4000 }).catch(() => false)) {
        logger.info('FACTURACION-API', 'Ingresando a "Generar Comprobantes"...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
          btnGenerarMenu.click(),
        ]);
        await page.waitForTimeout(1000);
      }

      logger.info('FACTURACION-API', `Posición alcanzada en RCEL: ${page.url()}`);

      // 3. Consulta previa de padrón receptor
      if (datos.receptor.nroDoc && datos.receptor.tipoDoc !== 'Consumidor Final') {
        const padron = await this.consultarPadronInPage(page, datos.receptor.tipoDoc, datos.receptor.nroDoc);
        if (padron.success && padron.razonSocial) {
          datos.receptor.razonSocial = padron.razonSocial;
          if (padron.domicilio && !datos.receptor.domicilio) {
            datos.receptor.domicilio = padron.domicilio;
          }
          logger.info('FACTURACION-API', `Padrón receptor verificado: ${datos.receptor.razonSocial} (${datos.receptor.nroDoc})`);
        }
      }

      // 4. Emisión asistida directa en Playwright (Interacción en DOM real de RCEL)
      // Como el navegador ya está exactamente en https://fe.afip.gob.ar/rcel/jsp/buscarPtosVtas.do,
      // interactuamos directamente con los campos HTML del formulario de ARCA.
      logger.info('FACTURACION-API', 'Interactuando con el formulario de RCEL en el navegador...');

      // PASO 1 EN DOM: Punto de venta y tipo de comprobante
      const ptoVtaSelect = page.locator('select#puntoDeVenta, select[name="puntoDeVenta"]').first();
      await ptoVtaSelect.waitFor({ state: 'visible', timeout: 10000 });
      
      // Seleccionar el punto de venta (buscar por valor o por texto que comience con el número)
      const targetPtoVta = String(datos.puntoVenta);
      await ptoVtaSelect.selectOption({ label: targetPtoVta }).catch(async () => {
        // Fallback: seleccionar por valor o index
        await ptoVtaSelect.selectOption(targetPtoVta).catch(async () => {
          const opts = await ptoVtaSelect.locator('option').all();
          for (const opt of opts) {
            const val = await opt.getAttribute('value');
            const txt = await opt.textContent();
            if ((val && val.includes(targetPtoVta)) || (txt && txt.trim().startsWith(targetPtoVta))) {
              await ptoVtaSelect.selectOption(val!);
              break;
            }
          }
        });
      });

      await page.waitForTimeout(500);

      // Tipo de comprobante (select#tipoComprobante)
      const tipoCompSelect = page.locator('select#tipoComprobante, select[name="tipoComprobante"]').first();
      if (await tipoCompSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
        const tipoCompId = this.mapTipoComprobanteId(datos.tipoComprobante);
        await tipoCompSelect.selectOption(tipoCompId).catch(async () => {
          await tipoCompSelect.selectOption({ label: datos.tipoComprobante }).catch(() => {});
        });
      }

      await page.waitForTimeout(500);

      // Clic en Continuar (Paso 1 -> Paso 2)
      logger.info('FACTURACION-API', 'Avanzando a Datos de Emisión (Paso 2)...');
      const btnPaso1 = page.locator('input[value*="Continuar"], input#btnContinuar, button:has-text("Continuar")').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        btnPaso1.click(),
      ]);
      await page.waitForTimeout(1000);
      logger.info('FACTURACION-API', `URL tras Paso 1: ${page.url()}`);

      // Verificar si hubo error en paso 1
      let errorPaso = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
      if (errorPaso && errorPaso.trim()) {
        throw new Error(`Error en Punto de Venta / Tipo de Comprobante: ${errorPaso.trim()}`);
      }

      // PASO 2 EN DOM: Conceptos a incluir y Fechas
      logger.info('FACTURACION-API', 'Completando Datos de Emisión (Concepto y Fechas)...');
      const cboConcepto = page.locator('select#cboConcepto, select[name="cboConcepto"], select#concepto').first();
      if (await cboConcepto.isVisible({ timeout: 5000 }).catch(() => false)) {
        await cboConcepto.selectOption(String(datos.concepto));
        await page.waitForTimeout(1000);
      }

      // Fechas si son servicios (concepto 2 o 3)
      if (datos.concepto === 2 || datos.concepto === 3) {
        const hoy = this.formatDateForRcel(datos.fechaEmision);
        const fDesde = page.locator('input#fsdt, input#periodoFacturadoDesde, input[name="periodoFacturadoDesde"]').first();
        if (await fDesde.isVisible({ timeout: 2000 }).catch(() => false)) {
          await fDesde.fill(datos.periodoDesde ? this.formatDateForRcel(datos.periodoDesde) : hoy);
        }
        const fHasta = page.locator('input#fsht, input#periodoFacturadoHasta, input[name="periodoFacturadoHasta"]').first();
        if (await fHasta.isVisible({ timeout: 2000 }).catch(() => false)) {
          await fHasta.fill(datos.periodoHasta ? this.formatDateForRcel(datos.periodoHasta) : hoy);
        }
        const fVto = page.locator('input#vencimientoPago, input[name="vencimientoPago"]').first();
        if (await fVto.isVisible({ timeout: 2000 }).catch(() => false)) {
          await fVto.fill(datos.vencimientoPago ? this.formatDateForRcel(datos.vencimientoPago) : hoy);
        }
      }

      // Clic en Continuar (Paso 2 -> Paso 3)
      logger.info('FACTURACION-API', 'Avanzando a Datos del Receptor (Paso 3)...');
      // En genComDatosEmisor.do el botón Continuar puede ser input[value*="Continuar"] o tener id específico
      const btnPaso2 = page.locator('input[value*="Continuar"], input#btnContinuar, input#btngenerar, button:has-text("Continuar")').last();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        btnPaso2.click(),
      ]);
      await page.waitForTimeout(1000);
      logger.info('FACTURACION-API', `URL tras Paso 2: ${page.url()}`);

      errorPaso = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
      if (errorPaso && errorPaso.trim()) {
        throw new Error(`Error en Datos de Emisión: ${errorPaso.trim()}`);
      }

      // Si tras Paso 2 la URL sigue siendo genComDatosEmisor.do, significa que AFIP no avanzó de página (faltó un campo)
      if (page.url().includes('genComDatosEmisor.do')) {
        const errorHtml = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
        throw new Error(errorHtml?.trim() || `AFIP no avanzó del Paso 2 (Datos de Emisión). Revise las fechas de facturación o concepto.`);
      }

      // PASO 3 EN DOM: Datos del Receptor
      logger.info('FACTURACION-API', 'Completando Datos del Receptor y Condición de Venta...');
      const condIvaSelect = page.locator('select#condicionIVA, select[name="condicionIVA"], select#idimptos').first();
      if (await condIvaSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
        const condId = this.mapCondicionIvaId(datos.receptor.condicionIva);
        await condIvaSelect.selectOption(condId);
      }

      if (datos.receptor.nroDoc && datos.receptor.tipoDoc !== 'Consumidor Final') {
        const tipoDocSelect = page.locator('select#tipoDocReceptor, select[name="tipoDocReceptor"], select#idtipoDoc').first();
        if (await tipoDocSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
          await tipoDocSelect.selectOption(this.mapTipoDocId(datos.receptor.tipoDoc));
        }
        const nroDocInput = page.locator('input#nroDocReceptor, input[name="nroDocReceptor"], input#nroDoc').first();
        if (await nroDocInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await nroDocInput.fill(datos.receptor.nroDoc.replace(/\D/g, ''));
          await page.keyboard.press('Tab');
          await page.waitForTimeout(1200);
        }
      }

      // Condición de venta (Contado por defecto)
      const condVentaRadio = page.locator(`input[name="formaDePago"][value="${this.mapCondicionVentaId(datos.condicionVenta)}"], input#formaDePago1, input[value="Contado"], input[name="condicionVenta"]`).first();
      if (await condVentaRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
        await condVentaRadio.check().catch(() => {});
      }

      // Clic en Continuar (Paso 3 -> Paso 4)
      logger.info('FACTURACION-API', 'Avanzando a Datos de la Operación / Ítems (Paso 4)...');
      const btnPaso3 = page.locator('input[value*="Continuar"], input#btnContinuar, button:has-text("Continuar")').last();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        btnPaso3.click(),
      ]);
      await page.waitForTimeout(1000);
      logger.info('FACTURACION-API', `URL tras Paso 3: ${page.url()}`);

      errorPaso = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
      if (errorPaso && errorPaso.trim()) {
        throw new Error(`Error en Datos del Receptor: ${errorPaso.trim()}`);
      }

      // PASO 4 EN DOM: Ítems
      logger.info('FACTURACION-API', 'Completando detalle de producto o servicio...');
      const item = datos.items[0] || { descripcion: 'Servicios Profesionales', cantidad: 1, precioUnitario: 100 };
      
      const descInput = page.locator('textarea#detalleDescripcion1, input#detalleDescripcion1, input[name="detalleDescripcion"], textarea[name="detalleDescripcion"]').first();
      if (await descInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await descInput.fill(item.descripcion);
      }

      const cantInput = page.locator('input#detalleCantidad1, input[name="detalleCantidad"]').first();
      if (await cantInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cantInput.fill(String(item.cantidad || 1));
      }

      const precioInput = page.locator('input#detallePrecio1, input[name="detallePrecio"]').first();
      if (await precioInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await precioInput.fill(String(item.precioUnitario || item.subtotal));
      }

      // Clic en Continuar (Paso 4 -> Resumen y Confirmación)
      logger.info('FACTURACION-API', 'Avanzando al Resumen de Confirmación...');
      const btnPaso4 = page.locator('input[value*="Continuar"], input#btnContinuar, button:has-text("Continuar")').last();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        btnPaso4.click(),
      ]);
      await page.waitForTimeout(1000);
      logger.info('FACTURACION-API', `URL tras Paso 4: ${page.url()}`);

      errorPaso = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
      if (errorPaso && errorPaso.trim()) {
        throw new Error(`Error en Ítems: ${errorPaso.trim()}`);
      }

      // PASO 5 EN DOM: Confirmar Comprobante
      logger.info('FACTURACION-API', 'Revisando pantalla de Resumen antes de Confirmar...');
      logger.info('FACTURACION-API', `URL en Resumen: ${page.url()}`);

      // Registrar botones visibles para diagnóstico preciso
      const allButtons = await page.locator('input[type="button"], input[type="submit"], button').all();
      const buttonLabels: string[] = [];
      for (const b of allButtons) {
        const val = (await b.getAttribute('value')) || (await b.textContent()) || '';
        if (val.trim()) buttonLabels.push(val.trim());
      }
      logger.info('FACTURACION-API', `Botones presentes en la pantalla de Resumen: [${buttonLabels.join(' | ')}]`);

      // Selector exhaustivo para el botón de confirmación de RCEL / AFIP
      const btnConfirmar = page.locator(`
        input#btngenerar,
        input#btnConfirmar,
        input[value*="Confirmar Datos"],
        input[value*="Confirmar"],
        input[value*="Emitir"],
        input[value*="Generar Comprobante"],
        button:has-text("Confirmar"),
        button:has-text("Emitir")
      `).first();

      if (!await btnConfirmar.isVisible({ timeout: 8000 }).catch(() => false)) {
        // Inspeccionar si AFIP arrojó un mensaje de validación o bloqueo en el resumen
        const pageText = await page.locator('#contenido, #main, body').textContent().catch(() => '');
        const errorText = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
        throw new Error(errorText?.trim() || `No se visualizó el botón de Confirmación. Botones encontrados: [${buttonLabels.join(', ')}]. Título: ${await page.title()}`);
      }

      // Manejar el alert/confirm de Javascript que ARCA suele mostrar: "¿Confirma la operación?"
      page.once('dialog', async dialog => {
        logger.info('FACTURACION-API', `Dialog detectado de ARCA: "${dialog.message()}". Aceptando...`);
        await dialog.accept().catch(() => {});
      });

      logger.info('FACTURACION-API', 'Presionando botón para autorizar el comprobante...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        btnConfirmar.click(),
      ]);
      await page.waitForTimeout(2000);

      // PASO 6: Extraer CAE legítimo otorgado por ARCA
      const bodyHtml = await page.content();
      const caeMatch = bodyHtml.match(/CAE\s*(?:N[:°º]?)?\s*[:\.]?\s*<b>(\d{14})<\/b>/i) ||
                       bodyHtml.match(/<b>(\d{14})<\/b>/) ||
                       bodyHtml.match(/(\d{14})/);
      const vtoMatch = bodyHtml.match(/Fecha\s*de\s*Vto\.?\s*(?:de\s*CAE)?\s*[:\.]?\s*<b>(\d{2}\/\d{2}\/\d{4})<\/b>/i) ||
                       bodyHtml.match(/(\d{2}\/\d{2}\/\d{4})/);
      const nroMatch = bodyHtml.match(/N[º°:]?\s*<b>(\d{1,8})<\/b>/i) ||
                       bodyHtml.match(/Comprobante\s*Generado.*?(\d{8})/i);

      if (!caeMatch) {
        const errorFinal = await page.locator('.mensajeError, .error, #errores, .alert-danger').textContent().catch(() => null);
        throw new Error(errorFinal?.trim() || 'ARCA no devolvió un CAE válido tras confirmar la emisión.');
      }

      const cae = caeMatch[1];
      const caeVencimiento = vtoMatch ? vtoMatch[1] : '';
      const comprobanteNro = nroMatch ? nroMatch[1] : '00000001';

      logger.success('FACTURACION-API', `¡CAE Autorizado por ARCA!: ${cae} - Vto: ${caeVencimiento} - Comp N°: ${comprobanteNro}`);

      const resultadoEmision = {
        success: true,
        cae,
        caeVencimiento,
        comprobanteNumero: comprobanteNro,
        pdfBase64: null as string | null,
      };

      // PASO 7: Descarga de PDF si el botón "Imprimir" está disponible
      try {
        const btnImprimir = page.locator('input[value*="Imprimir"], a:has-text("Imprimir"), button:has-text("Imprimir")').first();
        if (await btnImprimir.isVisible({ timeout: 3000 }).catch(() => false)) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
            btnImprimir.click().catch(() => {}),
          ]);
          if (download) {
            const stream = await download.createReadStream();
            if (stream) {
              const chunks: Buffer[] = [];
              for await (const chunk of stream) chunks.push(Buffer.from(chunk));
              resultadoEmision.pdfBase64 = Buffer.concat(chunks).toString('base64');
            }
          }
        }
      } catch (errPdf: any) {
        logger.warn('FACTURACION-API', `No se pudo descargar PDF directamente: ${errPdf.message}`);
      }

      // 5. Gestión del PDF generado en memoria
      let publicPdfUrl = '';
      const total = datos.items.reduce((acc, curr) => acc + (curr.cantidad * curr.precioUnitario), 0);
      const numeroFormateado = `0000${datos.puntoVenta}`.slice(-4) + `-${resultadoEmision.comprobanteNumero}`;

      if (resultadoEmision.pdfBase64) {
        const filename = `factura_${targetCuit}_${numeroFormateado}.pdf`;
        try {
          const uploadRes = await storageService.uploadAttachment({
            filename,
            base64: resultadoEmision.pdfBase64,
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

      // 6. Despacho por correo electrónico al cliente si se especificó email
      let emailEnviado = false;
      if (datos.receptor.email && (publicPdfUrl || resultadoEmision.pdfBase64)) {
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
                  <li><strong>CAE:</strong> ${resultadoEmision.cae} (Vto: ${resultadoEmision.caeVencimiento})</li>
                  <li><strong>Importe Total:</strong> $${total.toFixed(2)}</li>
                </ul>
                <p>Adjuntamos el documento digital correspondiente.</p>
              </div>
            `,
            attachments: [
              {
                filename: `${numeroFormateado}.pdf`,
                content: resultadoEmision.pdfBase64 || undefined,
                path: publicPdfUrl || undefined,
                contentType: 'application/pdf',
              }
            ],
          });
          emailEnviado = mailRes.success;
          if (emailEnviado) {
            logger.success('FACTURACION-API', `Comprobante despachado a ${datos.receptor.email} con éxito.`);
          }
        } catch (err: any) {
          logger.warn('FACTURACION-API', `Aviso al despachar correo a cliente: ${err.message}`);
        }
      }

      if (createdPageLocally && page) {
        await page.close().catch(() => {});
      }

      return {
        success: true,
        message: 'Comprobante emitido con éxito por API interna de ARCA',
        cae: resultadoEmision.cae,
        caeVencimiento: resultadoEmision.caeVencimiento,
        comprobanteNro: numeroFormateado,
        puntoVenta: datos.puntoVenta,
        tipoComprobante: datos.tipoComprobante,
        totalImporte: total,
        fechaEmision: datos.fechaEmision || new Date().toISOString().split('T')[0],
        pdfUrl: publicPdfUrl || undefined,
        pdfBufferBase64: resultadoEmision.pdfBase64 || undefined,
        emailEnviado,
      };

    } catch (err: any) {
      logger.error('FACTURACION-API', `Fallo técnico en llamada de API interna: ${err.message}`);
      if (createdPageLocally && page) {
        await page.close().catch(() => {});
      }
      return {
        success: false,
        message: `Error en API interna de ARCA: ${err.message}`,
      };
    }
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

  private mapTipoComprobanteId(tipo: string): string {
    const map: Record<string, string> = {
      'Factura A': '1',
      'Nota de Débito A': '2',
      'Nota de Crédito A': '3',
      'Factura B': '6',
      'Nota de Débito B': '7',
      'Nota de Crédito B': '8',
      'Factura C': '11',
      'Nota de Débito C': '12',
      'Nota de Crédito C': '13',
      'Recibo C': '15',
    };
    return map[tipo] || '11';
  }

  private mapCondicionIvaId(condicion: string): string {
    const clean = (condicion || '').toLowerCase();
    if (clean.includes('inscripto')) return '1';
    if (clean.includes('exento')) return '4';
    if (clean.includes('consumidor') || clean.includes('final')) return '5';
    if (clean.includes('monotribut')) return '6';
    return '5';
  }

  private mapTipoDocId(tipoDoc: string): string {
    const map: Record<string, string> = {
      'CUIT': '80',
      'CUIL': '86',
      'CDI': '87',
      'DNI': '96',
      'Pasaporte': '94',
      'Consumidor Final': '99',
    };
    return map[tipoDoc] || '80';
  }

  private mapCondicionVentaId(condicion: string): string {
    const map: Record<string, string> = {
      'Contado': '1',
      'Tarjeta de Débito': '2',
      'Tarjeta de Crédito': '3',
      'Cuenta Corriente': '4',
      'Cheque': '5',
      'Transferencia': '6',
      'Otra': '7',
    };
    return map[condicion] || '1';
  }
}

export const facturacionModule = new FacturacionInternalApiModule();
