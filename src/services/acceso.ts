import { Request, Response, NextFunction } from 'express';
import { db } from '../database.js';

/*
 * Acceso por usuario a los CUITs.
 *
 * Cada usuario es independiente: carga y administra sus propios CUITs (propios, representados
 * u otros) y solo ve lo de esos CUITs (comprobantes, cola, clientes, configuración de ARCA).
 * El administrador ve todo y puede compartir un CUIT con otros usuarios.
 */

export interface UsuarioSesion { id: string; role: 'admin' | 'operator' | 'viewer'; username?: string }

export function usuarioDe(req: Request): UsuarioSesion | undefined {
  return (req as any).user;
}

export function esAdmin(u?: UsuarioSesion) {
  return u?.role === 'admin';
}

/** CUITs que el usuario puede ver y usar. */
export function cuitsVisibles(u?: UsuarioSesion): string[] {
  if (!u) return [];
  const cuentas = db.data.accounts || [];
  if (esAdmin(u)) return cuentas.map(a => a.cuit);
  return cuentas.filter(a => (a.usuarios || []).includes(u.id)).map(a => a.cuit);
}

export function puedeUsarCuit(u: UsuarioSesion | undefined, cuit: string): boolean {
  const limpio = String(cuit || '').replace(/\D/g, '');
  return !!limpio && cuitsVisibles(u).includes(limpio);
}

/** Middleware para rutas con :cuit — corta con 404 si el usuario no tiene ese CUIT. */
export function exigirAccesoCuit(req: Request, res: Response, next: NextFunction, cuit: string) {
  if (!puedeUsarCuit(usuarioDe(req), cuit)) {
    return res.status(404).json({ success: false, message: 'No tenés ese CUIT en tu cuenta.' });
  }
  next();
}

/** CUIT con el que factura el usuario por defecto (su último elegido, o el primero que tenga). */
export function cuitActivoDe(u?: UsuarioSesion): string {
  const visibles = cuitsVisibles(u);
  const preferido = u ? db.getCuitActivoUsuario(u.id) : '';
  return preferido && visibles.includes(preferido) ? preferido : visibles[0] || '';
}
