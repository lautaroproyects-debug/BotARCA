import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  appSecret: process.env.APP_SECRET || 'botarca_default_secret_key_change_me_32chars!',
  keepAlive: {
    enabled: process.env.KEEP_ALIVE_ENABLED !== 'false',
    intervalMinutes: parseInt(process.env.KEEP_ALIVE_INTERVAL_MINUTES || '10', 10),
    externalUrl: process.env.RENDER_EXTERNAL_URL || '',
  },
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

