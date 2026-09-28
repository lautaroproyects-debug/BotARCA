import axios from 'axios';
import { db } from '../database.js';
import { logger } from './logger.js';

export interface SendMailOptions {
  to: string;
  name?: string;
  subject: string;
  html: string;
}

class MailService {
  /**
   * Obtiene la configuración activa de correo desde DB o variables de entorno
   */
  public getConfig() {
    const settings = db.getSettings() as any;
    const provider = settings.mailProvider || process.env.MAIL_PROVIDER || 'auto';
    const resendApiKey = settings.resendApiKey || process.env.RESEND_API_KEY || '';
    const brevoApiKey = settings.brevoApiKey || process.env.BREVO_API_KEY || '';
    const senderEmail = settings.mailSenderEmail || process.env.MAIL_SENDER_EMAIL || 'onboarding@resend.dev';
    const senderName = settings.mailSenderName || process.env.MAIL_SENDER_NAME || 'BotArca Cloud';
    const adminNotifyEmail = settings.adminNotifyEmail || process.env.ADMIN_NOTIFY_EMAIL || '';

    // Determinar proveedor activo
    let activeProvider = provider;
    if (activeProvider === 'auto') {
      if (resendApiKey) activeProvider = 'resend';
      else if (brevoApiKey) activeProvider = 'brevo';
      else activeProvider = 'simulation';
    }

    return {
      provider: activeProvider,
      resendApiKey,
      brevoApiKey,
      senderEmail,
      senderName,
      adminNotifyEmail,
    };
  }

  /**
   * Envía un email utilizando Resend o Brevo según la configuración
   */
  public async sendMail(options: SendMailOptions): Promise<{ success: boolean; message: string; id?: string }> {
    const cfg = this.getConfig();

    // 1. Modo Simulación (si no hay API keys configuradas)
    if (cfg.provider === 'simulation' || (!cfg.resendApiKey && !cfg.brevoApiKey)) {
      logger.info('MAIL-SIMULATOR', `[SIMULADO] Email para: ${options.to} | Asunto: "${options.subject}" (Para envíos reales agrega RESEND_API_KEY o BREVO_API_KEY en Configuración)`);
      return {
        success: true,
        message: 'Email simulado correctamente en entorno de desarrollo.',
      };
    }

    // 2. Enviar vía RESEND API
    if (cfg.provider === 'resend') {
      if (!cfg.resendApiKey) {
        logger.warn('MAIL-RESEND', 'API Key de Resend no encontrada.');
        return { success: false, message: 'Falta la API Key de Resend.' };
      }

      try {
        const fromHeader = cfg.senderEmail.includes('<') 
          ? cfg.senderEmail 
          : `${cfg.senderName} <${cfg.senderEmail}>`;

        const response = await axios.post(
          'https://api.resend.com/emails',
          {
            from: fromHeader,
            to: [options.to],
            subject: options.subject,
            html: options.html,
          },
          {
            headers: {
              'Authorization': `Bearer ${cfg.resendApiKey.trim()}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );

        logger.success('MAIL-RESEND', `Email enviado a ${options.to} con éxito (ID: ${response.data?.id || 'OK'}).`);
        return { success: true, message: 'Email enviado exitosamente vía Resend.', id: response.data?.id };
      } catch (error: any) {
        const errMsg = error.response?.data?.message || error.message;
        logger.error('MAIL-RESEND', `Error enviando correo vía Resend a ${options.to}: ${errMsg}`);
        return { success: false, message: `Error Resend: ${errMsg}` };
      }
    }

    // 3. Enviar vía BREVO API (Sendinblue v3)
    if (cfg.provider === 'brevo') {
      if (!cfg.brevoApiKey) {
        logger.warn('MAIL-BREVO', 'API Key de Brevo no encontrada.');
        return { success: false, message: 'Falta la API Key de Brevo.' };
      }

      try {
        const response = await axios.post(
          'https://api.brevo.com/v3/smtp/email',
          {
            sender: {
              name: cfg.senderName,
              email: cfg.senderEmail,
            },
            to: [
              {
                email: options.to,
                name: options.name || options.to.split('@')[0],
              }
            ],
            subject: options.subject,
            htmlContent: options.html,
          },
          {
            headers: {
              'api-key': cfg.brevoApiKey.trim(),
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            timeout: 10000,
          }
        );

        const msgId = response.data?.messageId || 'OK';
        logger.success('MAIL-BREVO', `Email enviado a ${options.to} con éxito vía Brevo (ID: ${msgId}).`);
        return { success: true, message: 'Email enviado exitosamente vía Brevo.', id: msgId };
      } catch (error: any) {
        const errMsg = error.response?.data?.message || error.message;
        logger.error('MAIL-BREVO', `Error enviando correo vía Brevo a ${options.to}: ${errMsg}`);
        return { success: false, message: `Error Brevo: ${errMsg}` };
      }
    }

    return { success: false, message: 'Proveedor de correo no reconocido.' };
  }

  /**
   * Envía email de bienvenida cuando un usuario se registra o es creado
   */
  public async sendWelcomeEmail(user: { name: string; username: string; email: string; role?: string }): Promise<void> {
    const settings = db.getSettings();
    const appUrl = settings.externalUrl || process.env.RENDER_EXTERNAL_URL || 'https://botarca.onrender.com';

    const subject = `⚡ Bienvenido a BotArca - Tu cuenta ha sido activada`;
    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #08090c; color: #f1f5f9; margin: 0; padding: 0; }
    .wrapper { max-width: 580px; margin: 30px auto; background: #101217; border: 1px solid #1f242e; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .header { background: #090a0d; padding: 24px; border-bottom: 1px solid #1f242e; text-align: center; }
    .logo { color: #f59e0b; font-size: 20px; font-weight: 800; font-family: monospace; letter-spacing: 1px; }
    .badge { display: inline-block; background: rgba(245, 158, 11, 0.1); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.2); font-size: 10px; font-weight: bold; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; margin-top: 6px; }
    .content { padding: 32px 28px; line-height: 1.6; color: #cbd5e1; }
    .greeting { font-size: 18px; font-weight: 700; color: #ffffff; margin-bottom: 16px; }
    .card { background: #161922; border: 1px solid #2a303d; border-radius: 8px; padding: 18px; margin: 20px 0; }
    .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; font-family: monospace; }
    .label { color: #94a3b8; }
    .value { color: #f59e0b; font-weight: bold; }
    .btn { display: inline-block; background: #f59e0b; color: #000000 !important; font-weight: 800; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 15px; }
    .footer { background: #090a0d; padding: 18px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #1f242e; font-family: monospace; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">⚡ BOTARCA CLOUD ERP</div>
      <div class="badge">Facturación Headless ARCA</div>
    </div>
    <div class="content">
      <div class="greeting">¡Hola, ${user.name || user.username}!</div>
      <p>Tu cuenta de usuario ha sido creada y configurada correctamente en el sistema <strong>BotArca</strong>.</p>
      
      <div class="card">
        <div style="font-size: 11px; font-weight: bold; color: #94a3b8; text-transform: uppercase; margin-bottom: 10px; border-bottom: 1px solid #2a303d; padding-bottom: 6px;">
          Tus datos de acceso
        </div>
        <div style="margin-bottom: 6px; font-size: 13px;">
          <span style="color: #94a3b8;">Usuario:</span> <strong style="color: #ffffff; font-family: monospace;">${user.username}</strong>
        </div>
        <div style="margin-bottom: 6px; font-size: 13px;">
          <span style="color: #94a3b8;">Email:</span> <span style="color: #e2e8f0; font-family: monospace;">${user.email}</span>
        </div>
        <div style="margin-bottom: 6px; font-size: 13px;">
          <span style="color: #94a3b8;">Rol asignado:</span> <span style="color: #fbbf24; font-weight: bold; text-transform: uppercase; font-size: 11px;">${user.role || 'Operador'}</span>
        </div>
      </div>

      <p>Ya podés ingresar a la plataforma para emitir comprobantes fiscales, gestionar la cola de lotes desde Excel y administrar tus cuentas de ARCA.</p>

      <div style="text-align: center; margin: 25px 0;">
        <a href="${appUrl}" class="btn" target="_blank">Ingresar a BotArca</a>
      </div>

      <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #1f242e; padding-top: 16px;">
        <em>Nota de seguridad:</em> Si no solicitaste esta cuenta o tienes dudas sobre este registro, por favor contacta al administrador de tu organización.
      </p>
    </div>
    <div class="footer">
      BotArca &copy; ${new Date().getFullYear()} &bull; Servidor Cloud Render &bull; Supabase Database
    </div>
  </div>
</body>
</html>
    `;

    // 1. Enviar email al usuario
    await this.sendMail({
      to: user.email,
      name: user.name,
      subject,
      html,
    });

    // 2. Notificar al administrador si hay correo configurado
    const cfg = this.getConfig();
    if (cfg.adminNotifyEmail && cfg.adminNotifyEmail !== user.email) {
      await this.sendAdminAlertNewUser(user, cfg.adminNotifyEmail);
    }
  }

  /**
   * Notifica al administrador general cuando un nuevo usuario se registra
   */
  public async sendAdminAlertNewUser(newUser: { name: string; username: string; email: string; role?: string }, adminEmail: string): Promise<void> {
    const subject = `🔔 [BotArca] Nuevo usuario registrado: @${newUser.username}`;
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; background-color: #08090c; color: #e2e8f0; padding: 20px;">
  <div style="max-width: 500px; margin: 0 auto; background: #101217; border: 1px solid #1f242e; border-radius: 8px; padding: 20px;">
    <h3 style="color: #f59e0b; margin-top: 0;">🔔 Nuevo Usuario Registrado</h3>
    <p>Se ha registrado un nuevo usuario en la plataforma BotArca:</p>
    <ul>
      <li><strong>Nombre:</strong> ${newUser.name}</li>
      <li><strong>Usuario:</strong> @${newUser.username}</li>
      <li><strong>Email:</strong> ${newUser.email}</li>
      <li><strong>Rol:</strong> ${newUser.role || 'Operador'}</li>
      <li><strong>Fecha:</strong> ${new Date().toLocaleString('es-AR')}</li>
    </ul>
    <p style="font-size: 12px; color: #94a3b8;">Puedes gestionar o revocar permisos desde la pestaña "Usuarios" en el panel de administración.</p>
  </div>
</body>
</html>
    `;

    await this.sendMail({
      to: adminEmail,
      subject,
      html,
    });
  }

  /**
   * Envía un email de prueba para verificar credenciales de Brevo/Resend
   */
  public async sendTestEmail(targetEmail: string): Promise<{ success: boolean; message: string }> {
    const cfg = this.getConfig();
    const subject = `🧪 Test de Conexión de Correo - BotArca (${cfg.provider.toUpperCase()})`;
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; background-color: #08090c; color: #e2e8f0; padding: 20px;">
  <div style="max-width: 500px; margin: 0 auto; background: #101217; border: 1px solid #1f242e; border-radius: 8px; padding: 20px; text-align: center;">
    <h2 style="color: #10b981; margin-top: 0;">✓ Conexión Exitosa</h2>
    <p>El servicio de notificaciones por correo electrónico de <strong>BotArca</strong> está funcionando correctamente.</p>
    <div style="background: #161922; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #f59e0b; margin: 15px 0;">
      Proveedor Activo: ${cfg.provider.toUpperCase()}<br>
      Remitente: ${cfg.senderEmail}
    </div>
    <p style="font-size: 12px; color: #64748b;">Enviado el ${new Date().toLocaleString('es-AR')}</p>
  </div>
</body>
</html>
    `;

    return await this.sendMail({
      to: targetEmail,
      subject,
      html,
    });
  }
}

export const mailService = new MailService();
