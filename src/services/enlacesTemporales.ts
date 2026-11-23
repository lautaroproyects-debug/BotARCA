import crypto from 'crypto';

/**
 * Enlaces temporales para abrir PDFs en una pestaña nueva sin poner la sesión del usuario en la URL.
 * Cada enlace vale 10 minutos (el visor de PDF del navegador puede pedir el archivo más de una vez).
 */
interface Archivo { buffer: Buffer; nombre: string; vence: number }

const archivos = new Map<string, Archivo>();
const DURACION_MS = 10 * 60 * 1000;
const MAXIMO = 200;

function limpiar() {
  const ahora = Date.now();
  for (const [k, v] of archivos) if (v.vence < ahora) archivos.delete(k);
  while (archivos.size > MAXIMO) archivos.delete(archivos.keys().next().value as string);
}

export function crearEnlace(buffer: Buffer, nombre: string): string {
  limpiar();
  const ticket = crypto.randomBytes(24).toString('base64url');
  archivos.set(ticket, { buffer, nombre, vence: Date.now() + DURACION_MS });
  return `/archivo/${ticket}`;
}

export function obtenerArchivo(ticket: string): Archivo | null {
  limpiar();
  return archivos.get(String(ticket || '')) || null;
}
