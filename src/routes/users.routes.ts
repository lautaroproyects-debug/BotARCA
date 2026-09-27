import { Router, Response } from 'express';
import { userService } from '../services/auth/userService.js';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Login público
router.post('/login', async (req: AuthenticatedRequest, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Por favor ingresa usuario y contraseña.',
    });
  }

  const result = await userService.authenticate(username, password);
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
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

  const result = await userService.resetPassword(user.id, newPassword);
  res.json(result);
});

// --- RUTAS DE ADMINISTRADOR (GESTIÓN DE USUARIOS) ---

// Listar todos los usuarios
router.get('/', authenticateToken, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const users = userService.getAllUsers();
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
router.put('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { name, email, role, active } = req.body;
  const result = await userService.updateUser(req.params.id as string, { name, email, role, active });
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
