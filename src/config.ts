import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  encryptionKey: process.env.ENCRYPTION_KEY || process.env.APP_SECRET || 'botarca_dev_secret_key_9988_min32chars_required',
  appSecret: process.env.APP_SECRET || 'botarca_dev_secret_key_9988_min32chars_required',
  arca: {
    cuit: (process.env.ARCA_CUIT || process.env.AFIP_CUIT || '').replace(/\D/g, ''),
    claveFiscal: process.env.ARCA_CLAVE_FISCAL || process.env.AFIP_PASSWORD || process.env.AFIP_CLAVE_FISCAL || '',
    puntoVenta: parseInt(process.env.ARCA_PUNTO_VENTA || process.env.AFIP_PTO_VENTA || '1', 10),
    razonSocial: process.env.ARCA_RAZON_SOCIAL || process.env.AFIP_RAZON_SOCIAL || '',
  },
  storage: {
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'facturas-adjuntos',
  },
  cors: {
    allowedOrigins: (process.env.CORS_ORIGIN || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
  },
  keepAlive: {
    enabled: process.env.KEEP_ALIVE_ENABLED !== 'false',
    intervalMinutes: parseInt(process.env.KEEP_ALIVE_INTERVAL_MINUTES || '10', 10),
    externalUrl: process.env.RENDER_EXTERNAL_URL || 'https://botarca.onrender.com',
  },
  uptimeRobotApiKey: process.env.UPTIMEROBOT_API_KEY || '',
  engine: {
    headless: process.env.HEADLESS_MODE !== 'false',
    slowMo: parseInt(process.env.SLOW_MO_MS || '50', 10),
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    timeoutMs: 45000,
  },
  scheduler: {
    cronExpression: process.env.AUTO_SYNC_CRON || '0 9 * * *',
  },
  paths: {
    dataDir: path.resolve(process.cwd(), 'data'),
    publicDir: path.resolve(__dirname, 'public'),
  }
};

