import crypto from 'crypto';
import { db } from '../../database.js';
import { supabase } from '../supabase.js';
import { logger } from '../logger.js';

/*
 * Agenda de clientes, una por usuario: cada usuario ve y edita solo sus clientes
 * (el administrador ve todos). Se guarda en el archivo local y en Supabase
 * (tabla "configuraciones", id "clientes") para sobrevivir a los reinicios de Render.
 */

export interface ClienteRecord {
  id: string;
  /** Dueño del cliente. Los clientes viejos sin dueño solo los ve el administrador. */
  usuarioId?: string;
  cuit: string;
  tipoDoc: 'CUIT' | 'DNI' | 'Consumidor Final' | 'Pasaporte' | string;
  razonSocial: string;
  condicionIva: string;
  domicilio?: string;
  email?: string;
  telefono?: string;
  saldoCuenta: number;
  notas?: string;
  createdAt: string;
}

const TIPOS_DOC = ['CUIT', 'CUIL', 'DNI', 'Pasaporte', 'Consumidor Final'];
const CONDICIONES = ['Consumidor Final', 'Responsable Inscripto', 'Monotributo', 'Exento'];

class ClientesService {
  private cargado = false;

  private get lista(): ClienteRecord[] {
    if (!this.cargado) this.migrarLegado();
    if (!db.data.clientesV2) db.data.clientesV2 = [];
    return db.data.clientesV2 as ClienteRecord[];
  }

  /** Trae los clientes del formato anterior (sin dueño). Quedan visibles solo para el admin. */
  private migrarLegado() {
    this.cargado = true;
    if (db.data.clientesV2?.length) return;
    try {
      const viejos = process.env.BOTARCA_CLIENTES ? JSON.parse(process.env.BOTARCA_CLIENTES) : [];
      if (Array.isArray(viejos) && viejos.length) {
        // Se descartan los dos clientes de ejemplo que traía el sistema
        db.data.clientesV2 = viejos.filter((c: any) => !['cli_1', 'cli_2'].includes(c.id));
        logger.info('CRM', `Migrados ${db.data.clientesV2.length} clientes del formato anterior (visibles para el administrador).`);
      }
    } catch { /* variable inválida: se ignora */ }
  }

  private persistir() {
    db.save();
    const client = supabase.getClient();
    if (!client) return;
    Promise.resolve(client.from('configuraciones').upsert({ id: 'clientes', valor: this.lista, updated_at: new Date().toISOString() }, { onConflict: 'id' })).catch(() => {});
  }

  public getAll(usuario?: { id: string; role: string }): ClienteRecord[] {
    if (!usuario) return [];
    if (usuario.role === 'admin') return this.lista;
    return this.lista.filter(c => c.usuarioId === usuario.id);
  }

  /** Valida y normaliza. Devuelve el error en texto si algo no sirve. */
  public validar(datos: any): string | null {
    const doc = String(datos.cuit || '').replace(/\D/g, '');
    if (!String(datos.razonSocial || '').trim()) return 'Falta el nombre o razón social.';
    if (String(datos.razonSocial).length > 150) return 'El nombre es demasiado largo.';
    if (!doc) return 'Falta el CUIT o DNI.';
    if (!(doc.length === 11 || (doc.length >= 7 && doc.length <= 8))) return 'El documento tiene que ser un CUIT (11 números) o un DNI (7 u 8).';
    if (datos.tipoDoc && !TIPOS_DOC.includes(datos.tipoDoc)) return 'Tipo de documento inválido.';
    if (datos.condicionIva && !CONDICIONES.includes(datos.condicionIva)) return 'Condición frente al IVA inválida.';
    if (datos.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(datos.email).trim())) return 'El email no es válido.';
    return null;
  }

  public async save(datos: any, usuario: { id: string; role: string }): Promise<ClienteRecord> {
    const cuit = String(datos.cuit || '').replace(/\D/g, '');
    // Editar por id: el dueño (o el admin). Por CUIT: solo dentro de la agenda del propio usuario,
    // así nunca se pisa el cliente de otro aunque tenga el mismo CUIT.
    const propios = this.getAll(usuario);
    let existente = (datos.id && propios.find(c => c.id === datos.id)) || this.lista.find(c => c.cuit === cuit && c.usuarioId === usuario.id);
    const base = {
      cuit,
      tipoDoc: datos.tipoDoc || (cuit.length === 11 ? 'CUIT' : 'DNI'),
      razonSocial: String(datos.razonSocial).trim(),
      condicionIva: datos.condicionIva || 'Consumidor Final',
      domicilio: datos.domicilio ? String(datos.domicilio).trim().slice(0, 200) : undefined,
      email: datos.email ? String(datos.email).trim() : undefined,
      telefono: datos.telefono ? String(datos.telefono).trim().slice(0, 40) : undefined,
      notas: datos.notas ? String(datos.notas).trim().slice(0, 500) : undefined,
    };
    if (existente) {
      Object.assign(existente, base);
    } else {
      existente = { id: 'cli_' + crypto.randomUUID(), usuarioId: usuario.id, ...base, saldoCuenta: 0, createdAt: new Date().toISOString() };
      this.lista.unshift(existente);
    }
    this.persistir();
    logger.info('CRM', `Cliente guardado: ${existente.razonSocial} (${existente.cuit})`);
    return existente;
  }

  public async delete(id: string, usuario: { id: string; role: string }): Promise<boolean> {
    const idx = this.lista.findIndex(c => c.id === id && (usuario.role === 'admin' || c.usuarioId === usuario.id));
    if (idx === -1) return false;
    this.lista.splice(idx, 1);
    this.persistir();
    return true;
  }
}

export const clientesService = new ClientesService();
