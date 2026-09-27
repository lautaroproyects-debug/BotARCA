import { Page, BrowserContext } from 'playwright';

/**
 * Inyecta técnicas avanzadas de evasión (Stealth) en el contexto de navegación de Playwright
 * para atravesar firewalls (Cloudflare, WAFs gubernamentales, huellas biométricas).
 */
export async function applyStealthEvasions(context: BrowserContext) {
  await context.addInitScript(() => {
    // 1. Eliminar detección de automatización (navigator.webdriver)
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // 2. Simular Plugins reales de Chrome
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
    ];

    Object.defineProperty(navigator, 'plugins', {
      get: () => fakePlugins,
      configurable: true,
    });

    // 3. Simular Idiomas y Hardware
    Object.defineProperty(navigator, 'languages', {
      get: () => ['es-AR', 'es', 'en-US', 'en'],
      configurable: true,
    });

    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });

    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
      configurable: true,
    });

    // 4. Simular Objeto Chrome de navegador real
    (globalThis as any).chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
      },
      csi: () => {},
      loadTimes: () => {},
    };

    // 5. Spoofing de WebGL Renderer y Vendor (Gráfica Intel / NVIDIA en vez de SwiftShader / Mesa)
    const gl = (globalThis as any).WebGLRenderingContext;
    if (gl && gl.prototype) {
      const getParameterProto = gl.prototype.getParameter;
      gl.prototype.getParameter = function(parameter: number) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterProto.apply(this, [parameter]);
      };
    }

    const gl2 = (globalThis as any).WebGL2RenderingContext;
    if (gl2 && gl2.prototype) {
      const getParameterProto2 = gl2.prototype.getParameter;
      gl2.prototype.getParameter = function(parameter: number) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterProto2.apply(this, [parameter]);
      };
    }
  });
}

/**
 * Escritura con emulación humana estocástica (jitter y demoras de pulsación)
 */
export async function humanType(page: Page, selector: string, text: string) {
  const locator = page.locator(selector).first();
  await locator.click();
  await locator.clear();
  
  for (const char of text) {
    const delay = Math.floor(Math.random() * (95 - 35 + 1)) + 35; // 35ms - 95ms por tecla
    await page.keyboard.type(char, { delay });
  }
  
  // Pausa humana breve después de tipear
  await page.waitForTimeout(Math.floor(Math.random() * 200) + 100);
}

/**
 * Click con movimiento humano de cursor
 */
export async function humanClick(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  
  if (box) {
    // Mover cursor a una posición ligeramente aleatoria dentro del botón
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 6) + 3 });
    await page.waitForTimeout(Math.floor(Math.random() * 80) + 40);
  }
  
  await locator.click();
}
