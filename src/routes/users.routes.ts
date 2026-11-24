import { Router, Response } from 'express';
import { userService } from '../services/auth/userService.js';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validateLogin, validateRegister } from '../middleware/validation.middleware.js';
import { db } from '../database.js';

const router = Router();

// Login público
router.post('/login', validateLogin, async (req: AuthenticatedRequest, res: Response) => {
  const { username, password } = req.body;

  const result = await userService.authenticate(username, password);
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

// Registro público
router.post('/register', validateRegister, async (req: AuthenticatedRequest, res: Response) => {
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

// Perfil del usuario actual autenticado
router.get('/me', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const user = userService.getUserById(req.user!.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
  }
  res.json({ success: true, user: userService.toPublicProfile(user) });
});

// Cambiar propia contraseña
router.put('/me/password', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Faltan datos de contraseña.' });
  }

  const user = userService.getUserById(req.user!.id);
  if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

  // Validar clave actual
  const auth = await userService.authenticate(user.username, currentPassword);
  if (!auth.success) {
    return res.status(400).json({ success: false, message: 'La contraseña actual no es correcta.' });
  }

  const result = await userService.resetPassword(user.id, newPassword, 'propio');
  res.json(result);
});

// --- RUTAS DE ADMINISTRADOR (GESTIÓN DE USUARIOS) ---

// Listar todos los usuarios
router.get('/', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const cuentas = db.data.accounts || [];
  const users = userService.getAllUsers().map(u => ({
    ...u,
    cuits: cuentas.filter(a => (a.usuarios || []).includes(u.id)).map(a => a.cuit),
  }));
  res.json({ success: true, users });
});

// Crear nuevo usuario
router.post('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { username, email, name, password, role } = req.body;

  if (!username || !email || !name || !password) {
    return res.status(400).json({
      success: false,
      message: 'Todos los campos son obligatorios (usuario, email, nombre, contraseña).',
    });
  }

  const result = await userService.createUser({
    username,
    email,
    name,
    passwordPlain: password,
    role: role || 'operator',
  });

  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// Actualizar usuario
// CUITs que puede usar un usuario (el admin los asigna o quita)
router.put('/:id/cuits', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  if (!userService.getUserById(id)) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
  const pedidos = Array.isArray(req.body?.cuits) ? req.body.cuits.map((c: any) => String(c).replace(/\D/g, '')) : null;
  if (!pedidos) return res.status(400).json({ success: false, message: 'Mandá la lista de CUITs.' });
  for (const acc of db.data.accounts || []) {
    const tiene = (acc.usuarios || []).includes(id);
    const debe = pedidos.includes(acc.cuit);
    if (tiene !== debe) {
      db.definirUsuariosCuenta(acc.cuit, debe ? [...(acc.usuarios || []), id] : (acc.usuarios || []).filter(u => u !== id));
    }
  }
  res.json({ success: true, message: 'CUITs del usuario actualizados.' });
});

router.put('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { name, email, role, active } = req.body;
  const result = await userService.updateUser(req.params.id as string, { name, email, role, active }, req.user!.id);
  res.json(result);
});

// Resetear contraseña de usuario por admin
router.put('/:id/reset-password', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ success: false, message: 'Ingresa la nueva contraseña.' });
  }
  const result = await userService.resetPassword(req.params.id as string, newPassword);
  res.json(result);
});

// Eliminar usuario
router.delete('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const result = await userService.deleteUser(req.params.id as string, req.user!.id);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

export default router;
