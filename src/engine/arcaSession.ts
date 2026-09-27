import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { db } from '../database.js';
import { applyStealthEvasions, humanType, humanClick } from './stealthEvasions.js';

export interface ArcaSessionResult {
  success: boolean;
  message: string;
  razonSocial?: string;
  cookies?: any[];
  cuit?: string;
  context?: BrowserContext;
  page?: Page;
}

class ArcaSessionManager {
  private browser: Browser | null = null;
  private activeContext: BrowserContext | null = null;
  private lastSessionCheck: number = 0;
  private cachedRazonSocial: string = '';

  private readonly ARCA_LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
  private readonly ARCA_PORTAL_URL = 'https://portalcf.cloud.afip.gob.ar/portal/app/';

  /**
   * Inicia el navegador Chromium en modo headless con parámetros de evasión (stealth)
   */
  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      logger.info('MOTOR-ARCA', 'Lanzando instancia de Chromium en backend (Headless)...');
      this.browser = await chromium.launch({
        headless: config.engine.headless,
        slowMo: config.engine.slowMo,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--hide-scrollbars',
          '--mute-audio',
          '--disable-background-networking',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    }
    return this.browser;
  }

  /**
   * Crea un contexto de navegación configurado con evasión de detección de bots y WAFs
   */
  public async createStealthContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: config.engine.userAgent,
      viewport: { width: 1366, height: 768 },
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      extraHTTPHeaders: {
        'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });

    // Aplicar inyecciones profundas de evasión de cortafuegos / antibot
    await applyStealthEvasions(context);

    return context;
  }

  /**
   * Ejecuta el flujo de autenticación con Clave Fiscal en el portal de ARCA
   */
  public async login(cuit: string, claveFiscal: string): Promise<ArcaSessionResult> {
    logger.info('MOTOR-ARCA', `Iniciando autenticación en ARCA para CUIT ${cuit}...`);
    const cleanCuit = cuit.replace(/\D/g, '');

    if (!cleanCuit || cleanCuit.length !== 11) {
      return { success: false, message: 'El CUIT debe tener exactamente 11 dígitos.' };
    }

    if (!claveFiscal) {
      return { success: false, message: 'La Clave Fiscal no puede estar vacía.' };
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      context = await this.createStealthContext();
      page = await context.newPage();
      page.setDefaultTimeout(config.engine.timeoutMs);

      logger.info('MOTOR-ARCA', 'Navegando a la pasarela de autenticación de ARCA...');
      await page.goto(this.ARCA_LOGIN_URL, { waitUntil: 'domcontentloaded' });

      // Paso 1: Ingreso de CUIT con emulación humana
      logger.info('MOTOR-ARCA', 'Ingresando CUIT con tipeo estocástico humano...');
      const cuitSelector = 'input#F1\\:username, input[name="F1:username"], input#username, input[type="number"]';
      await page.waitForSelector(cuitSelector, { state: 'visible', timeout: 15000 });
      await humanType(page, cuitSelector, cleanCuit);

      // Botón Siguiente
      const btnSiguienteSelector = 'input#F1\\:btnSiguiente, button#btnSiguiente, input[value="Siguiente"], button:has-text("Siguiente")';
      await humanClick(page, btnSiguienteSelector);

      // Paso 2: Ingreso de Clave Fiscal
      logger.info('MOTOR-ARCA', 'Esperando campo de Clave Fiscal...');
      const passSelector = 'input#F1\\:password, input[name="F1:password"], input#password, input[type="password"]';
      await page.waitForSelector(passSelector, { state: 'visible', timeout: 15000 });
      await humanType(page, passSelector, claveFiscal);

      // Botón Ingresar
      logger.info('MOTOR-ARCA', 'Enviando credenciales...');
      const btnIngresarSelector = 'input#F1\\:btnIngresar, button#btnIngresar, input[value="Ingresar"], button:has-text("Ingresar")';
      await humanClick(page, btnIngresarSelector);

      // Esperar redirección al portal de contribuyente o mensaje de error
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});

      // Comprobar si hubo error en pantalla
      const errorMsg = await page.locator('.alert-danger, .rf-msgs-sum, #msgError, .mensaje-error').textContent().catch(() => null);
      if (errorMsg && errorMsg.trim().length > 0) {
        const cleanedError = errorMsg.trim();
        logger.error('MOTOR-ARCA', `ARCA devolvió error de acceso: ${cleanedError}`);
        await context.close();
        return { success: false, message: `Error ARCA: ${cleanedError}` };
      }

      // Obtener cookies de la sesión
      const cookies = await context.cookies();
      db.setSessionCookies(cookies);

      // Extraer nombre / razón social del contribuyente logueado
      let razonSocial = '';
      try {
        const userElement = page.locator('#avatarContribuyente, .nombre-contribuyente, .contribuyente-nombre, #personaLogueada, header span').first();
        const text = await userElement.textContent({ timeout: 5000 }).catch(() => null);
        if (text && text.trim()) {
          razonSocial = text.trim();
        }
      } catch (e) {
        // Ignorar si no se pudo leer el nombre exacto
      }

      this.cachedRazonSocial = razonSocial || `CUIT ${cleanCuit}`;
      this.activeContext = context;
      this.lastSessionCheck = Date.now();

      db.updateSessionStatus(true, new Date().toISOString(), this.cachedRazonSocial);
      logger.success('MOTOR-ARCA', `¡Autenticación en ARCA exitosa! Titular: ${this.cachedRazonSocial}`);

      return {
        success: true,
        message: 'Sesión iniciada correctamente',
        razonSocial: this.cachedRazonSocial,
        cuit: cleanCuit,
        cookies,
        context,
        page,
      };

    } catch (err: any) {
      logger.error('MOTOR-ARCA', `Error durante el inicio de sesión: ${err.message}`);
      if (context) {
        await context.close().catch(() => {});
      }
      db.updateSessionStatus(false);
      return {
        success: false,
        message: `Fallo de conexión con ARCA: ${err.message}`,
      };
    }
  }

  /**
   * Garantiza que exista una sesión activa válida, reutilizando o creando una nueva
   */
  public async ensureActiveSession(cuit?: string, claveFiscal?: string): Promise<ArcaSessionResult> {
    const creds = db.getCredentials();
    const targetCuit = cuit || creds.cuit;
    const targetClave = claveFiscal || creds.claveFiscal;

    if (!targetCuit || !targetClave) {
      return { success: false, message: 'Faltan credenciales configuradas (CUIT y Clave Fiscal).' };
    }

    // Si la sesión fue verificada hace menos de 10 minutos y tenemos contexto activo
    const TEN_MINUTES = 10 * 60 * 1000;
    if (this.activeContext && (Date.now() - this.lastSessionCheck < TEN_MINUTES)) {
      return {
        success: true,
        message: 'Sesión activa en memoria reutilizada',
        razonSocial: this.cachedRazonSocial,
        cuit: targetCuit,
        context: this.activeContext,
      };
    }

    // De lo contrario, iniciar sesión limpia
    return await this.login(targetCuit, targetClave);
  }

  /**
   * Cierra las instancias abiertas
   */
  public async closeAll() {
    if (this.activeContext) {
      await this.activeContext.close().catch(() => {});
      this.activeContext = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export const arcaSession = new ArcaSessionManager();
