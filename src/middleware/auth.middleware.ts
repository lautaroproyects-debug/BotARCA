import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/auth/userService.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    email: string;
    name: string;
    role: 'admin' | 'operator' | 'viewer';
  };
}

/**
 * Middleware para autenticar peticiones mediante JWT
 */
export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || (req.query.token as string);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Acceso no autorizado. Se requiere inicio de sesión.',
    });
  }

  const payload = userService.verifyToken(token);
  if (!payload) {
    return res.status(403).json({
      success: false,
      message: 'Token de sesión inválido o expirado.',
    });
  }

  req.user = payload;
  next();
}

/**
 * Middleware para requerir privilegios de Administrador (Role: admin)
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Acceso denegado. Se requieren permisos de Administrador.',
    });
  }
  next();
}
