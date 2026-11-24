import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

// ============================================================================
// 1. CORS: solo el dominio propio de BotArca (y localhost para desarrollo)
// ============================================================================

/**
 * Orígenes permitidos: RENDER_EXTERNAL_URL (el dominio de la app), lo que se agregue en
 * CORS_ORIGIN (separado por comas) y localhost solo fuera de producción.
 * Antes se aceptaba CUALQUIER origen (incluso los no listados) y con credenciales.
 */
function getAllowedOrigins(): string[] {
  const lista = new Set<string>(['https://botarca.onrender.com']);
  const externa = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (externa) lista.add(externa);
  for (const o of config.cors.allowedOrigins) if (o && o !== '*') lista.add(o.replace(/\/+$/, ''));
  if (process.env.NODE_ENV !== 'production') {
    ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3999', 'http://localhost:5173'].forEach(o => lista.add(o));
  }
  return [...lista];
}

export function secureCors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');

  // Sin cabecera Origin = mismo sitio, navegación directa, monitores (UptimeRobot) o curl:
  // no es un pedido de otro sitio, no hace falta CORS.
  if (!origin) return next();

  // Mismo dominio desde el que se sirve el panel
  const host = req.headers.host || '';
  let mismoSitio = false;
  try { mismoSitio = new URL(origin).host === host; } catch { /* origen inválido */ }

  if (mismoSitio || getAllowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  logger.warn('SECURITY-CORS', `Pedido bloqueado desde un origen no permitido: ${String(origin).slice(0, 100)} → ${req.path}`);
  if (req.method === 'OPTIONS') return res.status(403).end();
  return res.status(403).json({ success: false, message: 'Origen no permitido.' });
}

// ============================================================================
// 2. CONTENT SECURITY POLICY (CSP) Y CABECERAS DE SEGURIDAD
// ============================================================================

/**
 * El panel solo usa: sus propios archivos, Google Fonts (CSS + fuentes) y estilos en línea
 * (atributos style). Nada más puede cargar ni ejecutar código.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  res.setHeader('Content-Security-Policy', cspDirectives);
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.removeHeader('X-Powered-By');

  next();
}

// ============================================================================
// 3. RATE LIMITING (SLIDING WINDOW POR IP)
// ============================================================================

interface RateLimitRecord {
  timestamps: number[];
}

const ipStore = new Map<string, RateLimitRecord>();

// Limpieza periódica de memoria cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of ipStore.entries()) {
    record.timestamps = record.timestamps.filter(t => now - t < 15 * 60 * 1000);
    if (record.timestamps.length === 0) {
      ipStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Obtiene la dirección IP real del cliente considerando proxies (Render, Cloudflare)
 */
/**
 * IP real del cliente. Con app.set('trust proxy', 1), Express toma la que agrega el proxy de
 * Render. Antes se usaba la primera de X-Forwarded-For, que el cliente puede inventar para
 * esquivar los límites.
 */
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Factoría de Rate Limiter configurable por ruta
 */
export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  message: string;
  keyPrefix?: string;
}) {
  const { windowMs, maxRequests, message, keyPrefix = 'rl' } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Si es petición interna o healthz, omitir limitación
    if (req.path === '/healthz' || req.path === '/api/ping') {
      return next();
    }

    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let record = ipStore.get(key);
    if (!record) {
      record = { timestamps: [] };
      ipStore.set(key, record);
    }

    // Filtrar marcas de tiempo fuera de la ventana actual
    record.timestamps = record.timestamps.filter(t => now - t < windowMs);

    const currentCount = record.timestamps.length;
    const remaining = Math.max(0, maxRequests - currentCount - 1);
    const oldestTimestamp = record.timestamps[0] || now;
    const resetTimeSeconds = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

    res.setHeader('RateLimit-Limit', maxRequests);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.max(1, resetTimeSeconds));

    if (currentCount >= maxRequests) {
      logger.warn('SECURITY-RATELIMIT', `Límite excedido para IP ${ip} en ${req.path} (${currentCount}/${maxRequests} reqs).`);
      return res.status(429).json({
        success: false,
        message,
        retryAfterSeconds: Math.max(1, resetTimeSeconds),
      });
    }

    record.timestamps.push(now);
    next();
  };
}

// Limitadores preconfigurados según sensibilidad del endpoint
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutos
  maxRequests: 15,          // Máximo 15 intentos de login/registro por IP
  message: 'Demasiados intentos de acceso o registro desde esta IP. Por favor espera 15 minutos.',
  keyPrefix: 'auth',
});

export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,      // 1 minuto
  maxRequests: 120,         // 120 peticiones por minuto
  message: 'Límite de peticiones por minuto alcanzado. Reduce la frecuencia de consultas.',
  keyPrefix: 'api',
});

export const heavyOperationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,      // 1 minuto
  maxRequests: 20,          // 20 operaciones pesadas (ARCA, IA, Batch) por minuto
  message: 'Operación en proceso o límite de ejecuciones simultáneas alcanzado. Espera un momento.',
  keyPrefix: 'heavy',
});

// ============================================================================
// 4. SANITIZACIÓN DE ENTRADAS CONTRA XSS Y PROTOTYPE POLLUTION
// ============================================================================

/**
 * Sanitiza una cadena eliminando etiquetas HTML peligrosas y caracteres de control
 */
export function sanitizeString(val: string): string {
  if (typeof val !== 'string') return val;
  return val
    .replace(/\0/g, '') // Elimina null bytes
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Elimina etiquetas <script>
    .replace(/<[^>]*>?/gm, '') // Elimina tags HTML
    .replace(/javascript:/gi, '') // Elimina pseudo-protocolos javascript:
    .replace(/onload|onerror|onclick|onmouseover/gi, '') // Elimina event handlers inline
    .trim();
}

/**
 * Sanitiza recursivamente objetos y arrays
 */
export function sanitizeData(data: any): any {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizeData(item));
  }

  if (typeof data === 'object') {
    const clean: any = {};
    for (const [key, value] of Object.entries(data)) {
      // Protección contra Prototype Pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      clean[sanitizeString(key)] = sanitizeData(value);
    }
    return clean;
  }

  return data;
}

/**
 * Middleware global de sanitización de peticiones
 */
export function inputSanitizer(req: Request, res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeData(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeData(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeData(req.params);
  }
  next();
}
