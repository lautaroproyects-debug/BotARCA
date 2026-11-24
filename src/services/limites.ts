import { db } from '../database.js';
import { supabase } from './supabase.js';
import { UsuarioSesion, esAdmin } from './acceso.js';

/*
 * Límites de uso por usuario. Son holgados a propósito: alcanzan para que cualquiera cargue sus
 * CUITs y facture todo el mes sin pensarlo; solo frenan un uso desmedido (o un error que
 * dispare miles de comprobantes). El administrador no tiene límites y puede ampliar los de
 * cualquier usuario desde Ajustes → Usuarios.
 */

export interface Limites {
  /** CUITs que puede tener cargados o compartidos */
  cuits: number;
  /** Comprobantes que puede emitir por mes calendario */
  comprobantesMes: number;
  /** Clientes en su agenda */
  clientes: number;
  /** Comprobantes pendientes en la cola al mismo tiempo */
  colaPendientes: number;
}

export const LIMITES_POR_DEFECTO: Limites = {
  cuits: 25,
  comprobantesMes: 3000,
  clientes: 5000,
  colaPendientes: 2000,
};

const MAXIMOS: Limites = { cuits: 500, comprobantesMes: 100000, clientes: 100000, colaPendientes: 20000 };

export const NOMBRES: Record<keyof Limites, string> = {
  cuits: 'CUITs',
  comprobantesMes: 'comprobantes por mes',
  clientes: 'clientes en la agenda',
  colaPendientes: 'pendientes en la cola',
};

export function limitesDe(usuarioId: string): Limites {
  const propios = db.data.limitesUsuarios?.[usuarioId] || {};
  const r = { ...LIMITES_POR_DEFECTO };
  for (const k of Object.keys(r) as Array<keyof Limites>) {
    const v = Number((propios as any)[k]);
    if (Number.isFinite(v) && v > 0) r[k] = Math.floor(v);
  }
  return r;
}

/** Guarda los límites de un usuario. Un valor vacío vuelve al valor por defecto. */
export function definirLimites(usuarioId: string, datos: Record<string, unknown>): { ok: boolean; mensaje: string; limites?: Limites } {
  const nuevos: Record<string, number> = {};
  for (const k of Object.keys(LIMITES_POR_DEFECTO) as Array<keyof Limites>) {
    const crudo = datos[k];
    if (crudo === undefined || crudo === null || crudo === '') continue;
    const v = Number(crudo);
    if (!Number.isInteger(v) || v < 1 || v > MAXIMOS[k]) {
      return { ok: false, mensaje: `El límite de ${NOMBRES[k]} tiene que ser un número entero entre 1 y ${MAXIMOS[k].toLocaleString('es-AR')}.` };
    }
    if (v !== LIMITES_POR_DEFECTO[k]) nuevos[k] = v;
  }
  if (!db.data.limitesUsuarios) db.data.limitesUsuarios = {};
  if (Object.keys(nuevos).length) db.data.limitesUsuarios[usuarioId] = nuevos;
  else delete db.data.limitesUsuarios[usuarioId];
  db.save();
  const client = supabase.getClient();
  if (client) {
    Promise.resolve(client.from('configuraciones').upsert(
      { id: 'limites_usuarios', valor: db.data.limitesUsuarios, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )).catch(() => {});
  }
  return { ok: true, mensaje: 'Límites guardados.', limites: limitesDe(usuarioId) };
}

function cuitsDelUsuario(usuarioId: string): string[] {
  return (db.data.accounts || []).filter(a => (a.usuarios || []).includes(usuarioId)).map(a => a.cuit);
}

export function inicioDeMes(fecha = new Date()): string {
  // Mes calendario de Argentina (UTC-3)
  const ar = new Date(fecha.getTime() - 3 * 3600 * 1000);
  return `${ar.getUTCFullYear()}-${String(ar.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Comprobantes emitidos por el usuario en el mes actual (Supabase si está; si no, lo local). */
async function comprobantesDelMes(usuarioId: string): Promise<number> {
  const mes = inicioDeMes();
  const desdeIso = new Date(`${mes}-01T03:00:00Z`).toISOString();
  const locales = (db.data.comprobantes || []).filter(c => c.usuarioId === usuarioId && c.createdAt >= desdeIso).length;
  const client = supabase.getClient();
  if (!client) return locales;
  try {
    const { count, error } = await client.from('comprobantes').select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId).gte('created_at', desdeIso);
    if (error || typeof count !== 'number') return locales;
    return Math.max(count, locales);
  } catch {
    return locales;
  }
}

export async function usoDe(usuarioId: string) {
  const cuits = cuitsDelUsuario(usuarioId);
  return {
    cuits: cuits.length,
    comprobantesMes: await comprobantesDelMes(usuarioId),
    clientes: ((db.data.clientesV2 || []) as any[]).filter(c => c.usuarioId === usuarioId).length,
    colaPendientes: (db.data.queue || []).filter(q => q.estado === 'pendiente' && cuits.includes(String(q.cuitEmisor || ''))).length,
  };
}

/**
 * Devuelve un mensaje si sumar "cantidad" supera el límite del usuario; null si se puede.
 * El administrador no tiene límites.
 */
export async function excedeLimite(u: UsuarioSesion | undefined, tipo: keyof Limites, cantidad = 1): Promise<string | null> {
  if (!u || esAdmin(u)) return null;
  const limite = limitesDe(u.id)[tipo];
  const uso = (await usoDe(u.id))[tipo];
  if (uso + cantidad <= limite) return null;
  const quedan = Math.max(0, limite - uso);
  const base = `Llegaste al límite de ${limite.toLocaleString('es-AR')} ${NOMBRES[tipo]}`;
  return quedan > 0
    ? `${base}: te quedan ${quedan.toLocaleString('es-AR')}. Pedile al administrador que lo amplíe.`
    : `${base}. Pedile al administrador que lo amplíe.`;
}
