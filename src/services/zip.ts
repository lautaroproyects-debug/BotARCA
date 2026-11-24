import zlib from 'zlib';

/**
 * ZIP mínimo (sin dependencias) para descargar los comprobantes de un mes.
 * Formato estándar PKZIP con compresión "deflate" y nombres en UTF-8.
 */

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fechaDos(d = new Date()) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, fecha };
}

export function crearZip(archivos: Array<{ nombre: string; datos: Buffer }>): Buffer {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { hora, fecha } = fechaDos();

  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre, 'utf8');
    const comprimido = zlib.deflateRawSync(a.datos);
    const usarDeflate = comprimido.length < a.datos.length;
    const cuerpo = usarDeflate ? comprimido : a.datos;
    const crc = crc32(a.datos);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // versión necesaria
    local.writeUInt16LE(0x0800, 6);          // nombres en UTF-8
    local.writeUInt16LE(usarDeflate ? 8 : 0, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(cuerpo.length, 18);
    local.writeUInt32LE(a.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    partes.push(local, nombre, cuerpo);

    const cab = Buffer.alloc(46);
    cab.writeUInt32LE(0x02014b50, 0);
    cab.writeUInt16LE(20, 4);
    cab.writeUInt16LE(20, 6);
    cab.writeUInt16LE(0x0800, 8);
    cab.writeUInt16LE(usarDeflate ? 8 : 0, 10);
    cab.writeUInt16LE(hora, 12);
    cab.writeUInt16LE(fecha, 14);
    cab.writeUInt32LE(crc, 16);
    cab.writeUInt32LE(cuerpo.length, 20);
    cab.writeUInt32LE(a.datos.length, 24);
    cab.writeUInt16LE(nombre.length, 28);
    cab.writeUInt32LE(offset, 42);
    central.push(cab, nombre);

    offset += local.length + nombre.length + cuerpo.length;
  }

  const centralBuf = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(centralBuf.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, centralBuf, fin]);
}
