import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../../database.js';
import { config } from '../../config.js';
import { supabase } from '../supabase.js';
import { logger } from '../logger.js';
import { mailService } from '../mailService.js';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'operator' | 'viewer';
  active: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface UserPublicProfile {
  id: string;
  username: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  active: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

class UserService {
  private users: UserRecord[] = [];

  constructor() {
    this.init();
  }

  public async init() {
    // 1. Cargar usuarios locales o crear superadmin por defecto
    const saved = this.loadLocalUsers();
    if (saved && saved.length > 0) {
      this.users = saved;
    } else {
      // Crear cuenta inicial de Super Admin
      const initialAdminPass = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(initialAdminPass, salt);

      const defaultAdmin: UserRecord = {
        id: 'user_admin_root',
        username: 'admin',
        email: 'admin@botarca.local',
        name: 'Super Administrador',
        passwordHash: hash,
        role: 'admin',
        active: true,
        createdAt: new Date().toISOString(),
      };

      this.users = [defaultAdmin];
      this.saveLocalUsers();
      logger.info('AUTH-SISTEMA', `Creado usuario inicial de administración: "admin" (Clave: "${initialAdminPass}").`);
    }

    // 2. Sincronizar con Supabase si está disponible
    this.syncFromSupabase().catch(() => {});
  }

  private loadLocalUsers(): UserRecord[] {
    const raw = (db as any).data?.users;
    return Array.isArray(raw) ? raw : [];
  }

  private saveLocalUsers() {
    (db as any).data.users = this.users;
    (db as any).save();
  }

  private async syncFromSupabase() {
    const client = supabase.getClient();
    if (!client) return;
    try {
      const { data, error } = await client.from('usuarios').select('*');
      if (error) return;
      if (Array.isArray(data) && data.length > 0) {
        // Unir usuarios remotos
        for (const u of data) {
          const exists = this.users.find(x => x.username === u.username || x.id === u.id);
          if (!exists) {
            this.users.push({
              id: u.id,
              username: u.username,
              email: u.email,
              name: u.name || u.username,
              passwordHash: u.password_hash,
              role: u.role || 'operator',
              active: u.active ?? true,
              lastLoginAt: u.last_login_at,
              createdAt: u.created_at || new Date().toISOString(),
            });
          }
        }
        this.saveLocalUsers();
      }
    } catch (e) {}
  }

  public toPublicProfile(u: UserRecord): UserPublicProfile {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    };
  }

  /**
   * Autenticación de usuario con usuario/email y contraseña
   */
  public async authenticate(usernameOrEmail: string, passwordPlain: string): Promise<{ success: boolean; message: string; token?: string; user?: UserPublicProfile }> {
    const clean = (usernameOrEmail || '').trim().toLowerCase();
    const user = this.users.find(u => u.username.toLowerCase() === clean || u.email.toLowerCase() === clean);

    if (!user) {
      logger.warn('AUTH-LOGIN', `Intento de acceso fallido para usuario: "${usernameOrEmail}" (No encontrado)`);
      return { success: false, message: 'Usuario o contraseña incorrectos.' };
    }

    if (!user.active) {
      logger.warn('AUTH-LOGIN', `Acceso denegado: Usuario "${user.username}" desactivado.`);
      return { success: false, message: 'Tu cuenta ha sido desactivada por el administrador.' };
    }

    const match = bcrypt.compareSync(passwordPlain, user.passwordHash);
    if (!match) {
      logger.warn('AUTH-LOGIN', `Contraseña incorrecta para usuario: "${user.username}"`);
      return { success: false, message: 'Usuario o contraseña incorrectos.' };
    }

    user.lastLoginAt = new Date().toISOString();
    this.saveLocalUsers();

    // Sincronizar login en Supabase
    this.asyncUpdateSupabase(user.id, { last_login_at: user.lastLoginAt });

    // Generar JWT
    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    const token = jwt.sign(payload, config.appSecret, { expiresIn: '7d' });
    logger.success('AUTH-LOGIN', `Inicio de sesión exitoso: ${user.name} (@${user.username}) [Rol: ${user.role}]`);

    return {
      success: true,
      message: 'Inicio de sesión exitoso.',
      token,
      user: this.toPublicProfile(user),
    };
  }

  private async asyncUpdateSupabase(id: string, data: any) {
    try {
      const supa = supabase.getClient();
      if (supa) {
        await supa.from('usuarios').update(data).eq('id', id);
      }
    } catch (e) {}
  }

  private async asyncInsertSupabase(data: any) {
    try {
      const supa = supabase.getClient();
      if (supa) {
        await supa.from('usuarios').insert(data);
      }
    } catch (e) {}
  }

  private async asyncDeleteSupabase(id: string) {
    try {
      const supa = supabase.getClient();
      if (supa) {
        await supa.from('usuarios').delete().eq('id', id);
      }
    } catch (e) {}
  }

  public verifyToken(token: string): any {
    try {
      return jwt.verify(token, config.appSecret);
    } catch (e) {
      return null;
    }
  }

  public getAllUsers(): UserPublicProfile[] {
    return this.users.map(u => this.toPublicProfile(u));
  }

  public getUserById(id: string): UserRecord | null {
    return this.users.find(u => u.id === id) || null;
  }

  public async createUser(data: { username: string; email: string; name: string; passwordPlain: string; role: UserRecord['role'] }): Promise<{ success: boolean; message: string; user?: UserPublicProfile }> {
    const cleanUser = data.username.trim().toLowerCase();
    const cleanEmail = data.email.trim().toLowerCase();

    if (this.users.some(u => u.username.toLowerCase() === cleanUser)) {
      return { success: false, message: 'El nombre de usuario ya está en uso.' };
    }

    if (this.users.some(u => u.email.toLowerCase() === cleanEmail)) {
      return { success: false, message: 'El correo electrónico ya está registrado.' };
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(data.passwordPlain, salt);

    const newUser: UserRecord = {
      id: 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      username: cleanUser,
      email: cleanEmail,
      name: data.name.trim(),
      passwordHash: hash,
      role: data.role || 'operator',
      active: true,
      createdAt: new Date().toISOString(),
    };

    this.users.push(newUser);
    this.saveLocalUsers();

    // Sincronizar en Supabase
    this.asyncInsertSupabase({
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      name: newUser.name,
      password_hash: newUser.passwordHash,
      role: newUser.role,
      active: newUser.active,
    });

    logger.info('AUTH-ADMIN', `Nuevo usuario creado: @${newUser.username} (${newUser.name}) por admin.`);
    
    // Enviar notificación de bienvenida por Brevo/Resend de forma asíncrona
    mailService.sendWelcomeEmail({
      name: newUser.name,
      username: newUser.username,
      email: newUser.email,
      role: newUser.role,
    }).catch(err => logger.warn('MAIL', `No se pudo enviar bienvenida: ${err.message}`));

    return { success: true, message: 'Usuario creado exitosamente.', user: this.toPublicProfile(newUser) };
  }

  /**
   * Registro público de un nuevo usuario desde la pantalla de login
   */
  public async registerUser(data: { name: string; username: string; email: string; passwordPlain: string }): Promise<{ success: boolean; message: string; token?: string; user?: UserPublicProfile }> {
    const cleanUser = (data.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const cleanEmail = (data.email || '').trim().toLowerCase();
    const cleanName = (data.name || '').trim();

    if (!cleanName || cleanName.length < 2) {
      return { success: false, message: 'Ingresa tu nombre y apellido completo.' };
    }

    if (!cleanUser || cleanUser.length < 3) {
      return { success: false, message: 'El nombre de usuario debe tener al menos 3 caracteres alfanuméricos.' };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return { success: false, message: 'Por favor ingresa una dirección de correo electrónico válida.' };
    }

    if (!data.passwordPlain || data.passwordPlain.length < 4) {
      return { success: false, message: 'La contraseña debe tener al menos 4 caracteres.' };
    }

    if (this.users.some(u => u.username.toLowerCase() === cleanUser)) {
      return { success: false, message: 'El nombre de usuario ya se encuentra registrado. Prueba con otro.' };
    }

    if (this.users.some(u => u.email.toLowerCase() === cleanEmail)) {
      return { success: false, message: 'El correo electrónico ya está registrado. Inicia sesión o usa otro email.' };
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(data.passwordPlain, salt);

    const newUser: UserRecord = {
      id: 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      username: cleanUser,
      email: cleanEmail,
      name: cleanName,
      passwordHash: hash,
      role: 'operator',
      active: true,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.users.push(newUser);
    this.saveLocalUsers();

    // Sincronizar en Supabase Cloud
    this.asyncInsertSupabase({
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      name: newUser.name,
      password_hash: newUser.passwordHash,
      role: newUser.role,
      active: newUser.active,
      created_at: newUser.createdAt,
      last_login_at: newUser.lastLoginAt,
    });

    logger.success('AUTH-REGISTER', `Nuevo usuario auto-registrado: @${newUser.username} (${newUser.email})`);

    // Enviar notificación por Brevo o Resend
    mailService.sendWelcomeEmail({
      name: newUser.name,
      username: newUser.username,
      email: newUser.email,
      role: 'Operador',
    }).catch(err => logger.warn('MAIL', `Fallo al enviar notificación de registro: ${err.message}`));

    // Generar JWT para login instantáneo
    const payload = {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
    };
    const token = jwt.sign(payload, config.appSecret, { expiresIn: '7d' });

    return {
      success: true,
      message: '¡Cuenta creada con éxito! Se ha enviado una confirmación a tu correo electrónico.',
      token,
      user: this.toPublicProfile(newUser),
    };
  }

  public async updateUser(id: string, update: { name?: string; email?: string; role?: UserRecord['role']; active?: boolean }): Promise<{ success: boolean; message: string }> {
    const user = this.users.find(u => u.id === id);
    if (!user) return { success: false, message: 'Usuario no encontrado.' };

    if (update.name !== undefined) user.name = update.name.trim();
    if (update.email !== undefined) {
      const cleanEmail = update.email.trim().toLowerCase();
      const duplicate = this.users.find(u => u.email.toLowerCase() === cleanEmail && u.id !== id);
      if (duplicate) {
        return { success: false, message: 'El correo electrónico ya está registrado por otro usuario.' };
      }
      user.email = cleanEmail;
    }
    if (update.role !== undefined) user.role = update.role;
    if (update.active !== undefined) user.active = Boolean(update.active);

    this.saveLocalUsers();

    this.asyncUpdateSupabase(user.id, {
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    });

    return { success: true, message: 'Usuario actualizado con éxito.' };
  }

  public async resetPassword(id: string, newPasswordPlain: string): Promise<{ success: boolean; message: string }> {
    const user = this.users.find(u => u.id === id);
    if (!user) return { success: false, message: 'Usuario no encontrado.' };

    if (!newPasswordPlain || newPasswordPlain.length < 4) {
      return { success: false, message: 'La contraseña debe tener al menos 4 caracteres.' };
    }

    const salt = bcrypt.genSaltSync(10);
    user.passwordHash = bcrypt.hashSync(newPasswordPlain, salt);
    this.saveLocalUsers();

    this.asyncUpdateSupabase(user.id, { password_hash: user.passwordHash });

    logger.info('AUTH-ADMIN', `Contraseña restablecida para usuario @${user.username}.`);
    return { success: true, message: 'Contraseña actualizada correctamente.' };
  }

  public async deleteUser(id: string, requesterId: string): Promise<{ success: boolean; message: string }> {
    if (id === requesterId) {
      return { success: false, message: 'No puedes eliminar tu propia cuenta de usuario.' };
    }

    const idx = this.users.findIndex(u => u.id === id);
    if (idx === -1) return { success: false, message: 'Usuario no encontrado.' };

    const deleted = this.users.splice(idx, 1)[0];
    this.saveLocalUsers();

    this.asyncDeleteSupabase(id);

    logger.warn('AUTH-ADMIN', `Usuario eliminado: @${deleted.username} (${deleted.name})`);
    return { success: true, message: 'Usuario eliminado correctamente.' };
  }
}

export const userService = new UserService();
