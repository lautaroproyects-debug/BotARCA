import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../../database.js';
import { config } from '../../config.js';
import { supabase } from '../supabase.js';
import { logger } from '../logger.js';
import { mailService } from '../mailService.js';

/*
 * Usuarios del panel.
 *
 * Dónde se guardan:
 * - data/botarca_db.json (campo "users"). En Render ese disco se BORRA en cada deploy/reinicio.
 * - Supabase, tabla "usuarios" (si SUPABASE_URL/SUPABASE_KEY están configuradas). Es la fuente
 *   de verdad: al arrancar se cargan desde ahí y pisan a los locales.
 * Las contraseñas se guardan solo como hash bcrypt (nunca en texto plano).
 * Los tokens de "olvidé mi contraseña" se guardan solo como hash SHA-256, duran 30 minutos y
 * sirven una sola vez.
 */

export const LARGO_MINIMO_CLAVE = 8;

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
  /** Se incrementa al cambiar la contraseña: invalida las sesiones abiertas */
  tokenVersion?: number;
  resetTokenHash?: string;
  resetTokenExp?: string;
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

export interface SessionPayload {
  id: string;
  username: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  tv?: number;
}

const ROLES = ['admin', 'operator', 'viewer'] as const;
const NOMBRE_ROL: Record<string, string> = { admin: 'Administrador', operator: 'Operador', viewer: 'Solo lectura' };

function validarClave(clave: string): string | null {
  if (!clave || clave.length < LARGO_MINIMO_CLAVE) return `La contraseña debe tener al menos ${LARGO_MINIMO_CLAVE} caracteres.`;
  if (!/[A-Za-z]/.test(clave) || !/\d/.test(clave)) return 'La contraseña debe combinar letras y números.';
  return null;
}

const HASH_FALSO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

class UserService {
  private users: UserRecord[] = [];
  /** Se resuelve cuando terminó la carga desde Supabase (el login la espera, máx. 8 s). */
  private listo: Promise<void>;

  constructor() {
    this.listo = this.init();
  }

  private async init() {
    this.users = this.loadLocalUsers();
    await this.syncFromSupabase().catch(() => {});
    if (!this.users.some(u => u.role === 'admin')) {
      this.crearAdminInicial();
    }
  }

  private crearAdminInicial() {
    let clave = process.env.ADMIN_INITIAL_PASSWORD || '';
    if (!clave) {
      // Antes se usaba "admin123" por defecto. Ahora se genera una clave aleatoria y se muestra
      // SOLO en la consola del servidor (logs de Render), nunca en el panel.
      clave = crypto.randomBytes(9).toString('base64url');
      console.warn(`[AUTH] No hay ADMIN_INITIAL_PASSWORD. Clave generada para el usuario "admin": ${clave} — cambiala al entrar.`);
    }
    const admin: UserRecord = {
      id: 'user_admin_root',
      username: 'admin',
      email: process.env.ADMIN_NOTIFY_EMAIL || 'admin@botarca.local',
      name: 'Administrador',
      passwordHash: bcrypt.hashSync(clave, 10),
      role: 'admin',
      active: true,
      createdAt: new Date().toISOString(),
      tokenVersion: 0,
    };
    this.users.push(admin);
    this.saveLocalUsers();
    this.upsertSupabase(admin);
    logger.info('AUTH-SISTEMA', 'Creado el usuario inicial "admin" (la clave NO se muestra en este registro).');
  }

  private loadLocalUsers(): UserRecord[] {
    const raw = (db as any).data?.users;
    return Array.isArray(raw) ? raw : [];
  }

  private saveLocalUsers() {
    (db as any).data.users = this.users;
    (db as any).save();
  }

  /** Supabase es la fuente de verdad: sus datos pisan a los locales (que en Render se pierden). */
  private async syncFromSupabase() {
    const client = supabase.getClient();
    if (!client) return;
    const { data, error } = await client.from('usuarios').select('*');
    if (error || !Array.isArray(data)) return;

    if (data.length === 0) {
      // Primera vez con Supabase: subir los usuarios locales para no perderlos
      for (const u of this.users) this.upsertSupabase(u);
      return;
    }
    for (const r of data as any[]) {
      const remoto: UserRecord = {
        id: r.id,
        username: String(r.username || '').toLowerCase(),
        email: String(r.email || '').toLowerCase(),
        name: r.name || r.username,
        passwordHash: r.password_hash,
        role: ROLES.includes(r.role) ? r.role : 'viewer',
        active: r.active ?? true,
        lastLoginAt: r.last_login_at || undefined,
        createdAt: r.created_at || new Date().toISOString(),
      };
      const idx = this.users.findIndex(x => x.id === remoto.id || x.username === remoto.username);
      if (idx === -1) {
        this.users.push({ ...remoto, tokenVersion: 0 });
      } else {
        const local = this.users[idx];
        // Si la clave cambió en otra instancia, invalidar sesiones locales
        const tv = local.passwordHash !== remoto.passwordHash ? (local.tokenVersion || 0) + 1 : local.tokenVersion || 0;
        this.users[idx] = { ...local, ...remoto, tokenVersion: tv, resetTokenHash: local.resetTokenHash, resetTokenExp: local.resetTokenExp };
      }
    }
    this.saveLocalUsers();
  }

  private async esperarCarga() {
    await Promise.race([this.listo, new Promise(r => setTimeout(r, 8000))]);
  }

  private upsertSupabase(u: UserRecord) {
    const supa = supabase.getClient();
    if (!supa) return;
    Promise.resolve(supa.from('usuarios').upsert({
      id: u.id,
      username: u.username,
      email: u.email,
      name: u.name,
      password_hash: u.passwordHash,
      role: u.role,
      active: u.active,
      created_at: u.createdAt,
      last_login_at: u.lastLoginAt || null,
    }, { onConflict: 'id' })).catch(() => {});
  }

  private deleteSupabase(id: string) {
    const supa = supabase.getClient();
    if (!supa) return;
    Promise.resolve(supa.from('usuarios').delete().eq('id', id)).catch(() => {});
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

  private emitirToken(u: UserRecord): string {
    const payload: SessionPayload = { id: u.id, username: u.username, email: u.email, name: u.name, role: u.role, tv: u.tokenVersion || 0 };
    return jwt.sign(payload, config.appSecret, { expiresIn: '7d' });
  }

  public async authenticate(usernameOrEmail: string, passwordPlain: string): Promise<{ success: boolean; message: string; token?: string; user?: UserPublicProfile }> {
    await this.esperarCarga();
    const clean = (usernameOrEmail || '').trim().toLowerCase();
    const user = this.users.find(u => u.username.toLowerCase() === clean || u.email.toLowerCase() === clean);

    // Siempre se compara un hash (aunque el usuario no exista) para no revelar por el tiempo de respuesta
    const hash = user?.passwordHash || HASH_FALSO;
    const coincide = bcrypt.compareSync(passwordPlain || '', hash);

    if (!user || !coincide) {
      logger.warn('AUTH-LOGIN', `Intento de acceso fallido para "${String(usernameOrEmail).slice(0, 60)}"`);
      return { success: false, message: 'Usuario o contraseña incorrectos.' };
    }
    if (!user.active) {
      logger.warn('AUTH-LOGIN', `Acceso denegado: usuario "${user.username}" desactivado.`);
      return { success: false, message: 'Tu cuenta está desactivada. Hablá con el administrador.' };
    }

    user.lastLoginAt = new Date().toISOString();
    this.saveLocalUsers();
    this.upsertSupabase(user);

    logger.success('AUTH-LOGIN', `Inicio de sesión: ${user.name} (@${user.username}) [Rol: ${user.role}]`);
    return { success: true, message: 'Inicio de sesión exitoso.', token: this.emitirToken(user), user: this.toPublicProfile(user) };
  }

  /**
   * Verifica el token Y el estado actual del usuario: si fue desactivado, borrado o cambió la
   * contraseña, la sesión deja de valer. El rol se toma del usuario actual, no del token.
   */
  public verifyToken(token: string): SessionPayload | null {
    let payload: SessionPayload;
    try {
      payload = jwt.verify(token, config.appSecret) as SessionPayload;
    } catch {
      return null;
    }
    const user = this.users.find(u => u.id === payload.id);
    if (!user || !user.active) return null;
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) return null;
    return { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, tv: user.tokenVersion || 0 };
  }

  public getAllUsers(): UserPublicProfile[] {
    return this.users.map(u => this.toPublicProfile(u));
  }

  public getUserById(id: string): UserRecord | null {
    return this.users.find(u => u.id === id) || null;
  }

  private validarAlta(data: { username: string; email: string; name: string; passwordPlain: string }): { error?: string; username: string; email: string; name: string } {
    const username = (data.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const email = (data.email || '').trim().toLowerCase();
    const name = (data.name || '').trim();
    if (name.length < 2) return { error: 'Ingresá nombre y apellido.', username, email, name };
    if (username.length < 3) return { error: 'El usuario debe tener al menos 3 caracteres (letras, números, punto o guion).', username, email, name };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Ingresá un email válido.', username, email, name };
    const errClave = validarClave(data.passwordPlain);
    if (errClave) return { error: errClave, username, email, name };
    if (this.users.some(u => u.username === username)) return { error: 'Ese nombre de usuario ya está en uso.', username, email, name };
    if (this.users.some(u => u.email === email)) return { error: 'Ese email ya está registrado.', username, email, name };
    return { username, email, name };
  }

  public async createUser(data: { username: string; email: string; name: string; passwordPlain: string; role: UserRecord['role'] }): Promise<{ success: boolean; message: string; user?: UserPublicProfile }> {
    await this.esperarCarga();
    const v = this.validarAlta(data);
    if (v.error) return { success: false, message: v.error };
    const role = ROLES.includes(data.role as any) ? data.role : 'operator';

    const newUser: UserRecord = {
      id: 'user_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      username: v.username,
      email: v.email,
      name: v.name,
      passwordHash: bcrypt.hashSync(data.passwordPlain, 10),
      role,
      active: true,
      createdAt: new Date().toISOString(),
      tokenVersion: 0,
    };
    this.users.push(newUser);
    this.saveLocalUsers();
    this.upsertSupabase(newUser);
    logger.info('AUTH-ADMIN', `Nuevo usuario creado: @${newUser.username} (${NOMBRE_ROL[role]}).`);

    mailService.sendWelcomeEmail({ name: newUser.name, username: newUser.username, email: newUser.email, role: NOMBRE_ROL[role] })
      .catch(err => logger.warn('MAIL', `No se pudo enviar la bienvenida: ${err.message}`));

    return { success: true, message: 'Usuario creado.', user: this.toPublicProfile(newUser) };
  }

  /** Registro público: entra como SOLO LECTURA hasta que un administrador lo habilite. */
  public async registerUser(data: { name: string; username: string; email: string; passwordPlain: string }): Promise<{ success: boolean; message: string; token?: string; user?: UserPublicProfile }> {
    await this.esperarCarga();
    if (String(process.env.REGISTRO_PUBLICO || '').toLowerCase() === 'false') {
      return { success: false, message: 'El registro está cerrado. Pedile un usuario al administrador.' };
    }
    const v = this.validarAlta(data);
    if (v.error) return { success: false, message: v.error };

    const ahora = new Date().toISOString();
    const newUser: UserRecord = {
      id: 'user_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      username: v.username,
      email: v.email,
      name: v.name,
      passwordHash: bcrypt.hashSync(data.passwordPlain, 10),
      role: 'viewer',
      active: true,
      lastLoginAt: ahora,
      createdAt: ahora,
      tokenVersion: 0,
    };
    this.users.push(newUser);
    this.saveLocalUsers();
    this.upsertSupabase(newUser);
    logger.success('AUTH-REGISTER', `Nuevo usuario auto-registrado (solo lectura): @${newUser.username}`);

    // Avisa al usuario y al administrador (ADMIN_NOTIFY_EMAIL) para que lo habilite si corresponde
    mailService.sendWelcomeEmail({ name: newUser.name, username: newUser.username, email: newUser.email, role: 'Solo lectura (pendiente de habilitación)' })
      .catch(err => logger.warn('MAIL', `No se pudo enviar la bienvenida: ${err.message}`));

    return {
      success: true,
      message: 'Cuenta creada. Por ahora es de solo lectura: un administrador tiene que habilitarte para facturar.',
      token: this.emitirToken(newUser),
      user: this.toPublicProfile(newUser),
    };
  }

  private cantidadAdminsActivos(excluirId?: string) {
    return this.users.filter(u => u.role === 'admin' && u.active && u.id !== excluirId).length;
  }

  public async updateUser(id: string, update: { name?: string; email?: string; role?: UserRecord['role']; active?: boolean }, requesterId?: string): Promise<{ success: boolean; message: string }> {
    const user = this.users.find(u => u.id === id);
    if (!user) return { success: false, message: 'Usuario no encontrado.' };

    const quitaAdmin = user.role === 'admin' && ((update.role !== undefined && update.role !== 'admin') || update.active === false);
    if (quitaAdmin && this.cantidadAdminsActivos(id) === 0) {
      return { success: false, message: 'No se puede: es el último administrador activo.' };
    }
    if (requesterId === id && update.active === false) {
      return { success: false, message: 'No podés desactivar tu propio usuario.' };
    }
    if (update.role !== undefined && !ROLES.includes(update.role as any)) {
      return { success: false, message: 'Rol inválido.' };
    }

    if (update.name !== undefined && update.name.trim()) user.name = update.name.trim();
    if (update.email !== undefined) {
      const email = update.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, message: 'Email inválido.' };
      if (this.users.some(u => u.email === email && u.id !== id)) return { success: false, message: 'Ese email ya lo usa otro usuario.' };
      user.email = email;
    }
    if (update.role !== undefined) user.role = update.role;
    if (update.active !== undefined) user.active = Boolean(update.active);

    this.saveLocalUsers();
    this.upsertSupabase(user);
    return { success: true, message: 'Usuario actualizado.' };
  }

  /** Cambia la contraseña e invalida todas las sesiones abiertas de ese usuario. */
  public async resetPassword(id: string, newPasswordPlain: string, motivo: 'admin' | 'propio' | 'mail' = 'admin'): Promise<{ success: boolean; message: string }> {
    const user = this.users.find(u => u.id === id);
    if (!user) return { success: false, message: 'Usuario no encontrado.' };
    const err = validarClave(newPasswordPlain);
    if (err) return { success: false, message: err };

    user.passwordHash = bcrypt.hashSync(newPasswordPlain, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.resetTokenHash = undefined;
    user.resetTokenExp = undefined;
    this.saveLocalUsers();
    this.upsertSupabase(user);
    logger.info('AUTH', `Contraseña cambiada para @${user.username} (${motivo}).`);

    // Aviso de seguridad al usuario
    mailService.sendMail({
      to: user.email,
      subject: 'Tu contraseña de BotArca cambió',
      html: `<div style="font-family:Arial,sans-serif;color:#17181a">
        <p>Hola ${escapeHtml(user.name)},</p>
        <p>La contraseña de tu usuario <strong>${escapeHtml(user.username)}</strong> se cambió el ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}${motivo === 'admin' ? ' (la cambió un administrador)' : ''}.</p>
        <p>Si no fuiste vos, avisale de inmediato al administrador.</p></div>`,
    }).catch(() => {});

    return { success: true, message: 'Contraseña actualizada. Las sesiones abiertas de ese usuario se cerraron.' };
  }

  /**
   * "Olvidé mi contraseña": manda un link por mail. La respuesta es siempre la misma, exista o no
   * el email, para no revelar quién tiene cuenta.
   */
  public async requestPasswordReset(email: string, baseUrl: string): Promise<{ success: boolean; message: string }> {
    await this.esperarCarga();
    const respuesta = { success: true, message: 'Si ese email tiene un usuario, te mandamos un link para crear una contraseña nueva. Revisá tu correo (y el spam).' };
    const clean = String(email || '').trim().toLowerCase();
    const user = this.users.find(u => u.email === clean && u.active);
    if (!user) return respuesta;

    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = sha256(token);
    user.resetTokenExp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    this.saveLocalUsers();

    const link = `${baseUrl.replace(/\/+$/, '')}/#restablecer=${token}`;
    const envio = await mailService.sendMail({
      to: user.email,
      subject: 'Crear una contraseña nueva en BotArca',
      html: `<div style="font-family:Arial,sans-serif;color:#17181a;max-width:520px">
        <p>Hola ${escapeHtml(user.name)},</p>
        <p>Pediste crear una contraseña nueva para el usuario <strong>${escapeHtml(user.username)}</strong>.</p>
        <p><a href="${link}" style="display:inline-block;background:#e8590c;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">Crear contraseña nueva</a></p>
        <p style="color:#6b6d71;font-size:13px">El link vence en 30 minutos y sirve una sola vez. Si no lo pediste, ignorá este mail: tu contraseña sigue igual.</p></div>`,
    }).catch((e: any) => ({ success: false, message: e.message }));
    if (!envio.success) logger.warn('AUTH', `No se pudo enviar el mail de recuperación a @${user.username}: ${envio.message}`);
    else logger.info('AUTH', `Mail de recuperación de contraseña enviado a @${user.username}.`);
    return respuesta;
  }

  public async resetPasswordWithToken(token: string, newPasswordPlain: string): Promise<{ success: boolean; message: string }> {
    await this.esperarCarga();
    const hash = sha256(String(token || ''));
    const user = this.users.find(u => u.resetTokenHash && u.resetTokenHash === hash);
    if (!user || !user.resetTokenExp || new Date(user.resetTokenExp).getTime() < Date.now()) {
      return { success: false, message: 'El link venció o ya se usó. Pedí uno nuevo desde "Olvidé mi contraseña".' };
    }
    return this.resetPassword(user.id, newPasswordPlain, 'mail');
  }

  public async deleteUser(id: string, requesterId: string): Promise<{ success: boolean; message: string }> {
    if (id === requesterId) return { success: false, message: 'No podés eliminar tu propio usuario.' };
    const idx = this.users.findIndex(u => u.id === id);
    if (idx === -1) return { success: false, message: 'Usuario no encontrado.' };
    if (this.users[idx].role === 'admin' && this.cantidadAdminsActivos(id) === 0) {
      return { success: false, message: 'No se puede: es el último administrador activo.' };
    }
    const deleted = this.users.splice(idx, 1)[0];
    this.saveLocalUsers();
    this.deleteSupabase(id);
    logger.warn('AUTH-ADMIN', `Usuario eliminado: @${deleted.username}`);
    return { success: true, message: 'Usuario eliminado.' };
  }
}

function escapeHtml(s: string) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const userService = new UserService();
