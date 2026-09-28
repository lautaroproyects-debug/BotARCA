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
      resendKeyMasked: cfg.resendApiKey ? `${cfg.resendApiKey.slice(0, 6)}...${cfg.resendApiKey.slice(-4)}` : '',
      hasBrevoKey: !!cfg.brevoApiKey,
      brevoKeyMasked: cfg.brevoApiKey ? `${cfg.brevoApiKey.slice(0, 8)}...${cfg.brevoApiKey.slice(-4)}` : '',
      senderEmail: cfg.senderEmail,
      senderName: cfg.senderName,
      adminNotifyEmail: cfg.adminNotifyEmail,
    }
  });
});

// Guardar configuración de correo (Solo Admin)
router.post('/mail', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const { provider, resendApiKey, brevoApiKey, senderEmail, senderName, adminNotifyEmail } = req.body;
  const current = db.getSettings();

  const update: any = {};
  if (provider !== undefined) update.mailProvider = provider;
  if (resendApiKey !== undefined && resendApiKey !== '') update.resendApiKey = resendApiKey.trim();
  if (brevoApiKey !== undefined && brevoApiKey !== '') update.brevoApiKey = brevoApiKey.trim();
  if (senderEmail !== undefined) update.mailSenderEmail = senderEmail.trim();
  if (senderName !== undefined) update.mailSenderName = senderName.trim();
  if (adminNotifyEmail !== undefined) update.adminNotifyEmail = adminNotifyEmail.trim();

  db.updateSettings(update);
  logger.info('CONFIG', `Configuración de correo (Brevo/Resend) actualizada por ${req.user!.username}.`);

  res.json({
    success: true,
    message: 'Configuración de notificaciones por email guardada con éxito.',
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
