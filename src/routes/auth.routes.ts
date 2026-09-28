import { Router, Request, Response } from 'express';
import { db } from '../database.js';
import { arcaSession } from '../engine/arcaSession.js';
import { userService } from '../services/auth/userService.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validateLogin, validateRegister, validateCredentials } from '../middleware/validation.middleware.js';
import { logger } from '../services/logger.js';

const router = Router();

// Login de usuario al panel web
router.post('/login', validateLogin, async (req: Request, res: Response) => {
  const { username, password } = req.body;

  const result = await userService.authenticate(username, password);
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

// Registro público de usuario (con notificación por Brevo / Resend)
router.post('/register', validateRegister, async (req: Request, res: Response) => {
  const { name, username, email, password } = req.body;

  if (!name || !username || !email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Todos los campos son obligatorios (Nombre, Usuario, Email y Contraseña).',
    });
  }

  const result = await userService.registerUser({
    name,
    username,
    email,
    passwordPlain: password,
  });

  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// Perfil de usuario autenticado
router.get('/me', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const user = userService.getUserById(req.user!.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
  }
  res.json({ success: true, user: userService.toPublicProfile(user) });
});

// Estado actual de credenciales y sesión en ARCA
router.get('/status', (req: Request, res: Response) => {
  const creds = db.getCredentials();
  res.json({
    cuit: creds.cuit,
    hasClaveFiscal: !!creds.claveFiscal,
    puntoVentaDefault: creds.puntoVentaDefault,
    razonSocial: creds.razonSocial || null,
    sessionValid: creds.sessionValid || false,
    lastLoginAt: creds.lastLoginAt || null,
  });
});

// Guardar o actualizar credenciales
router.post('/credentials', (req: Request, res: Response) => {
  const { cuit, claveFiscal, puntoVentaDefault, razonSocial } = req.body;

  if (!cuit) {
    return res.status(400).json({ success: false, message: 'El CUIT es obligatorio.' });
  }

  const cleanCuit = cuit.replace(/\D/g, '');
  if (cleanCuit.length !== 11) {
    return res.status(400).json({ success: false, message: 'El CUIT debe tener 11 dígitos numéricos.' });
  }

  const creds = db.getCredentials();
  const passwordToSave = claveFiscal || creds.claveFiscal;

  if (!passwordToSave) {
    return res.status(400).json({ success: false, message: 'Debes ingresar una Clave Fiscal.' });
  }

  db.setCredentials(cleanCuit, passwordToSave, Number(puntoVentaDefault) || 1, razonSocial);
  logger.info('AUTH', `Credenciales actualizadas para CUIT ${cleanCuit}.`);

  res.json({
    success: true,
    message: 'Credenciales guardadas y encriptadas de forma segura.',
    cuit: cleanCuit,
    puntoVentaDefault: Number(puntoVentaDefault) || 1,
  });
});

// Probar login en vivo contra ARCA
router.post('/test-login', async (req: Request, res: Response) => {
  const { cuit, claveFiscal } = req.body;
  const creds = db.getCredentials();

  const targetCuit = cuit ? cuit.replace(/\D/g, '') : creds.cuit;
  const targetClave = claveFiscal || creds.claveFiscal;

  if (!targetCuit || !targetClave) {
    return res.status(400).json({
      success: false,
      message: 'Debes proporcionar CUIT y Clave Fiscal para probar la conexión.',
    });
  }

  const task = db.addTask({
    type: 'login_test',
    status: 'running',
    resultSummary: `Probando login en ARCA para CUIT ${targetCuit}`,
  });

  try {
    const loginResult = await arcaSession.login(targetCuit, targetClave);

    if (loginResult.success) {
      db.updateTask(task.id, {
        status: 'success',
        resultSummary: `Conexión con ARCA exitosa. Titular: ${loginResult.razonSocial}`,
        details: { razonSocial: loginResult.razonSocial },
      });
      res.json({
        success: true,
        message: loginResult.message,
        razonSocial: loginResult.razonSocial,
      });
    } else {
      db.updateTask(task.id, {
        status: 'failed',
        error: loginResult.message,
        resultSummary: 'Fallo al autenticar en ARCA',
      });
      res.status(401).json({
        success: false,
        message: loginResult.message,
      });
    }
  } catch (err: any) {
    db.updateTask(task.id, {
      status: 'failed',
      error: err.message,
      resultSummary: 'Error inesperado durante la prueba de login',
    });
    res.status(500).json({
      success: false,
      message: `Error al probar login: ${err.message}`,
    });
  }
});

// Cerrar sesión
router.post('/logout', async (req: Request, res: Response) => {
  await arcaSession.closeAll();
  db.updateSessionStatus(false);
  logger.info('AUTH', 'Sesión cerrada manualmente.');
  res.json({ success: true, message: 'Sesión cerrada correctamente.' });
});

export default router;
