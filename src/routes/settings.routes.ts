import { Router, Response } from 'express';
import { db } from '../database.js';
import { mailService } from '../services/mailService.js';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { logger } from '../services/logger.js';

const router = Router();

// Obtener configuración de correo (Solo Admin)
router.get('/mail', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const cfg = mailService.getConfig();
  const settings = db.getSettings();

  res.json({
    success: true,
    mail: {
      provider: cfg.provider,
      hasResendKey: !!cfg.resendApiKey,
      hasBrevoKey: !!cfg.brevoApiKey,
      senderEmail: cfg.senderEmail,
      senderName: cfg.senderName,
      adminNotifyEmail: cfg.adminNotifyEmail,
      hasGroqKey: !!(settings.groqApiKey || process.env.GROQ_API_KEY),
    }
  });
});

// Guardar configuración de correo y Groq AI (Solo Admin)
router.post('/mail', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  // Las claves de Resend, Brevo y Groq viven solo en las variables de entorno de Render
  const { provider, senderEmail, senderName, adminNotifyEmail } = req.body || {};
  const current = db.getSettings();

  // Validación del lado del servidor (el panel también valida, pero no se confía en él)
  const esEmail = (v: any) => v === undefined || v === '' || (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.length <= 200);
  if (provider !== undefined && !['auto', 'resend', 'brevo', 'simulation'].includes(provider)) return res.status(400).json({ success: false, message: 'Proveedor de correo inválido.' });
  if (!esEmail(senderEmail) || !esEmail(adminNotifyEmail)) return res.status(400).json({ success: false, message: 'Hay un email inválido.' });
  if (senderName !== undefined && (typeof senderName !== 'string' || senderName.length > 80)) return res.status(400).json({ success: false, message: 'El nombre del remitente es demasiado largo.' });

  const update: any = {};
  if (provider !== undefined) update.mailProvider = provider;
  if (senderEmail !== undefined) update.mailSenderEmail = senderEmail.trim();
  if (senderName !== undefined) update.mailSenderName = senderName.trim();
  if (adminNotifyEmail !== undefined) update.adminNotifyEmail = adminNotifyEmail.trim();

  db.updateSettings(update);
  logger.info('CONFIG', `Configuración de correo actualizada por ${req.user!.username}.`);

  res.json({
    success: true,
    message: 'Configuración de correo guardada.',
  });
});

// Probar envío de email de test
router.post('/mail/test', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { testEmail } = req.body;
  const target = testEmail || req.user?.email;

  if (!target) {
    return res.status(400).json({ success: false, message: 'Ingresa una dirección de email para la prueba.' });
  }

  const result = await mailService.sendTestEmail(target);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

export default router;
