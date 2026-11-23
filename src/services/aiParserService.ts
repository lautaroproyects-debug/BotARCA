import axios from 'axios';
import { db } from '../database.js';
import { logger } from './logger.js';

/*
 * Convierte texto libre (WhatsApp, mails, notas) o filas pegadas de Excel/CSV en BORRADORES de
 * facturas. Nada se emite desde acá: el usuario revisa cada borrador y lo confirma.
 *
 * Regla principal: no inventar datos fiscales. Si la condición frente al IVA de un receptor con
 * CUIT no está escrita, queda vacía y el borrador se marca para revisar (antes se asumía
 * "Responsable Inscripto", y ARCA valida ese dato).
 */

export interface ParsedInvoiceDraft {
  cuitEmisor?: string;
  puntoVenta: number;
  tipoComprobante: string;
  concepto: number; // 1: Productos, 2: Servicios, 3: Productos y Servicios
  docTipo: 'CUIT' | 'DNI' | 'Consumidor Final';
  docNro: string;
  razonSocial: string;
  condicionIva: string;
  condicionVenta: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  importeTotal: number;
  email?: string;
  /** Lo que hay que revisar antes de emitir (vacío = listo) */
  advertencias: string[];
}

const CONDICIONES_IVA = ['Responsable Inscripto', 'Monotributo', 'Exento', 'Consumidor Final'];
const TIPOS = ['Factura A', 'Factura B', 'Factura C', 'Recibo C', 'Nota de Crédito A', 'Nota de Crédito B', 'Nota de Crédito C'];
const CONDICIONES_VENTA = ['Contado', 'Transferencia', 'Tarjeta de Débito', 'Tarjeta de Crédito', 'Cuenta Corriente', 'Cheque', 'Otra'];

// Modelos de Groq en orden de preferencia (si uno no está disponible, se prueba el siguiente)
const MODELOS_GROQ = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];

/** Verifica el dígito verificador de un CUIT/CUIL. */
export function cuitValido(cuit: string): boolean {
  const c = String(cuit || '').replace(/\D/g, '');
  if (c.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(c[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(c[10]);
}

/**
 * Interpreta importes en formato argentino o internacional:
 * "$ 150.000" -> 150000 · "2.500,50" -> 2500.5 · "1500.50" -> 1500.5 · "150k" -> 150000
 */
export function parseImporte(valor: unknown): number {
  if (typeof valor === 'number') return isFinite(valor) ? valor : 0;
  let s = String(valor || '').toLowerCase().replace(/\$|ars|pesos|\s/g, '');
  if (!s) return 0;
  let mult = 1;
  if (/k$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
  else if (/(mil|lucas)$/.test(s)) { mult = 1000; s = s.replace(/(mil|lucas)$/, ''); }
  const tienePunto = s.includes('.'), tieneComa = s.includes(',');
  if (tienePunto && tieneComa) {
    // El que aparece último es el separador decimal
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (tieneComa) {
    // "2500,50" es decimal; "150,000" son miles
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (tienePunto) {
    const partes = s.split('.');
    // "150.000" o "1.500.000" son miles; "1500.50" es decimal
    if (partes.length > 2 || (partes[1] || '').length === 3) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n * mult * 100) / 100 : 0;
}

function normalizarOpcion(valor: unknown, opciones: string[]): string {
  const v = String(valor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!v) return '';
  const exacta = opciones.find(o => o.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === v);
  if (exacta) return exacta;
  if (v.includes('inscripto') || v === 'ri') return opciones.includes('Responsable Inscripto') ? 'Responsable Inscripto' : '';
  if (v.includes('monotrib')) return opciones.includes('Monotributo') ? 'Monotributo' : '';
  if (v.includes('exento')) return opciones.includes('Exento') ? 'Exento' : '';
  if (v.includes('consumidor') || v === 'cf') return opciones.includes('Consumidor Final') ? 'Consumidor Final' : '';
  return opciones.find(o => v.includes(o.toLowerCase())) || '';
}

class AiParserService {
  public getGroqApiKey(): string {
    const settings = db.getSettings() as any;
    return settings.groqApiKey || process.env.GROQ_API_KEY || '';
  }

  private valoresPorDefecto() {
    const creds = db.getCredentials();
    const acc = creds.cuit ? db.getAccountRecord(creds.cuit) : undefined;
    return { cuitEmisor: creds.cuit, puntoVenta: acc?.ws?.puntoVentaWs || creds.puntoVentaDefault || 1 };
  }

  /** Completa, limpia y valida un borrador. Nunca inventa la condición frente al IVA de un CUIT. */
  public normalizarBorrador(raw: any): ParsedInvoiceDraft {
    const def = this.valoresPorDefecto();
    const adv: string[] = [];

    const docNro = String(raw.docNro || '').replace(/\D/g, '');
    let docTipo: ParsedInvoiceDraft['docTipo'] =
      docNro.length === 11 ? 'CUIT' : docNro.length >= 7 && docNro.length <= 8 ? 'DNI' : 'Consumidor Final';
    if (raw.docTipo === 'DNI' && docNro.length >= 7 && docNro.length <= 8) docTipo = 'DNI';
    if (docNro && docTipo === 'Consumidor Final') adv.push(`El documento "${raw.docNro}" no parece CUIT (11 dígitos) ni DNI (7 u 8).`);
    if (docTipo === 'CUIT' && !cuitValido(docNro)) adv.push(`El CUIT ${docNro} no es válido (dígito verificador). Revisalo.`);

    let condicionIva = normalizarOpcion(raw.condicionIva, CONDICIONES_IVA);
    if (!condicionIva) {
      if (docTipo === 'CUIT') adv.push('Falta la condición frente al IVA del cliente (no se adivina).');
      else condicionIva = 'Consumidor Final';
    }

    const tipoComprobante = normalizarOpcion(raw.tipoComprobante, TIPOS) || 'Factura C';
    if (tipoComprobante === 'Factura A' && docTipo !== 'CUIT') adv.push('Una Factura A necesita que el cliente tenga CUIT.');
    if (tipoComprobante.startsWith('Nota de Crédito')) adv.push('Las notas de crédito necesitan el comprobante asociado: cargalas desde "Facturar".');

    const cantidad = Number(raw.cantidad) > 0 ? Number(raw.cantidad) : 1;
    let precioUnitario = parseImporte(raw.precioUnitario);
    let importeTotal = parseImporte(raw.importeTotal);
    if (!precioUnitario && importeTotal) precioUnitario = Math.round((importeTotal / cantidad) * 100) / 100;
    if (!importeTotal && precioUnitario) importeTotal = Math.round(precioUnitario * cantidad * 100) / 100;
    if (importeTotal <= 0) adv.push('Falta el importe.');

    const razonSocial = String(raw.razonSocial || '').trim();
    if (!razonSocial && docTipo === 'CUIT') adv.push('Falta el nombre o razón social del cliente.');

    const descripcion = String(raw.descripcion || '').trim();
    if (!descripcion) adv.push('Falta la descripción de lo que se factura.');

    const concepto = [1, 2, 3].includes(Number(raw.concepto)) ? Number(raw.concepto) : 2;
    const email = String(raw.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) adv.push(`El email "${email}" no es válido.`);

    return {
      cuitEmisor: def.cuitEmisor,
      puntoVenta: Number(raw.puntoVenta) || def.puntoVenta,
      tipoComprobante,
      concepto,
      docTipo,
      docNro: docTipo === 'Consumidor Final' ? '' : docNro,
      razonSocial: razonSocial || (docTipo === 'CUIT' ? '' : 'Consumidor Final'),
      condicionIva,
      condicionVenta: normalizarOpcion(raw.condicionVenta, CONDICIONES_VENTA) || 'Contado',
      descripcion,
      cantidad,
      precioUnitario,
      importeTotal,
      email: email || undefined,
      advertencias: adv,
    };
  }

  public async parseSmart(rawText: string, options: { forceAi?: boolean } = {}): Promise<{
    items: ParsedInvoiceDraft[];
    parserUsed: 'groq_ai' | 'heuristic_nlp' | 'tabular';
    message?: string;
  }> {
    const text = String(rawText || '').trim();
    if (!text) return { items: [], parserUsed: 'tabular' };

    const pareceTabla = text.includes('\t') || /;.*\n/.test(text) || (text.split('\n')[0].split(',').length >= 3 && text.includes('\n'));
    const groqKey = this.getGroqApiKey();
    let aviso = '';

    if (groqKey && (options.forceAi || !pareceTabla)) {
      try {
        const items = await this.parseWithGroq(text, groqKey);
        if (items.length) {
          logger.success('AI-PARSER', `Groq armó ${items.length} borrador(es). Hay que revisarlos antes de emitir.`);
          return { items, parserUsed: 'groq_ai' };
        }
        aviso = 'La IA no encontró facturas en el texto.';
      } catch (err: any) {
        aviso = `No se pudo usar la IA (${err.message}).`;
        logger.warn('AI-PARSER', `Groq falló: ${err.message}. Se usa el lector sin IA.`);
      }
    } else if (!groqKey && !pareceTabla) {
      aviso = 'No hay clave de Groq configurada: se usó el lector sin IA, que entiende menos.';
    }

    if (pareceTabla) {
      return { items: this.parseTabular(text), parserUsed: 'tabular', message: aviso || undefined };
    }
    return { items: this.parseWithHeuristics(text), parserUsed: 'heuristic_nlp', message: aviso || undefined };
  }

  public async parseWithGroq(rawText: string, apiKey: string): Promise<ParsedInvoiceDraft[]> {
    const systemPrompt = `Extraés datos para emitir facturas electrónicas en Argentina (ARCA) a partir de mensajes, mails, notas o tablas.
Devolvé SOLO un objeto JSON con esta forma: {"comprobantes":[{...}]}. Cada comprobante tiene:
- "tipoComprobante": "Factura A" | "Factura B" | "Factura C" | "Recibo C". Si no se dice, "Factura C".
- "concepto": 1 (productos), 2 (servicios, honorarios, alquileres) o 3 (ambos). Si no se dice, 2.
- "docNro": CUIT (11 dígitos) o DNI (7-8 dígitos) del cliente, solo números. Vacío si no aparece.
- "razonSocial": nombre o razón social del cliente tal como aparece. Vacío si no aparece.
- "condicionIva": "Responsable Inscripto" | "Monotributo" | "Exento" | "Consumidor Final", SOLO si el texto lo dice. Si no lo dice, dejalo vacío: NO lo adivines.
- "condicionVenta": "Contado" | "Transferencia" | "Cuenta Corriente" | "Tarjeta de Débito" | "Tarjeta de Crédito". Si no se dice, "Contado".
- "descripcion": qué se factura, breve.
- "cantidad": número (1 si no se dice).
- "importeTotal": número sin símbolos ni separadores de miles (150k = 150000; $2.500,50 = 2500.5).
- "email": email del cliente si aparece; si no, vacío.
No inventes CUIT, nombres ni importes. Si un pedido no tiene importe, no lo incluyas.`;

    let content = '';
    let ultimoError = '';
    for (const model of MODELOS_GROQ) {
      for (const formatoJson of [true, false]) {
        try {
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model,
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: rawText.slice(0, 12000) }],
              temperature: 0,
              max_tokens: 4096,
              ...(formatoJson ? { response_format: { type: 'json_object' } } : {}),
            },
            { headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' }, timeout: 25000 }
          );
          content = response.data?.choices?.[0]?.message?.content || '';
          if (content) break;
        } catch (err: any) {
          const status = err.response?.status;
          ultimoError = `${model}: ${err.response?.data?.error?.message || err.message}`;
          if (status === 401) throw new Error('La clave de Groq no es válida.');
          // 400 con formato JSON: el modelo no lo soporta, se reintenta sin forzar el formato
          if (!(formatoJson && status === 400)) break;
        }
      }
      if (content) break;
      logger.warn('AI-GROQ', `Modelo no disponible (${ultimoError}). Probando el siguiente...`);
    }
    if (!content) throw new Error(ultimoError || 'Groq no respondió.');

    const limpio = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(limpio);
    } catch {
      const m = limpio.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    const lista: any[] = Array.isArray(parsed) ? parsed : (parsed?.comprobantes || parsed?.facturas || parsed?.items || []);
    if (!Array.isArray(lista)) return [];
    return lista
      .map(item => this.normalizarBorrador(item))
      .filter(b => b.importeTotal > 0);
  }

  /** Lector sin IA para mensajes simples (CUIT/DNI + importe por línea o bloque). */
  public parseWithHeuristics(rawText: string): ParsedInvoiceDraft[] {
    const lineas = rawText.split(/\r?\n/).map(line =>
      line.replace(/^\[?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\]?\s*[-–]?\s*[^:]+:\s*/i, '').trim()
    ).filter(Boolean);
    // Un pedido nuevo empieza con "factura/facturale/facturar/emitir"; el CUIT y el nombre quedan en el mismo bloque
    const bloques = lineas.join('\n').split(/(?=\b(?:facturar|facturale|factura|hacer factura|emitir)\b)/i).filter(b => /\d/.test(b));
    const fuentes = bloques.length > 1 ? bloques : lineas;

    const borradores: ParsedInvoiceDraft[] = [];
    for (const bloque of fuentes) {
      const cuit = (bloque.match(/\b(20|23|24|27|30|33|34)-?\d{8}-?\d\b/) || [])[0];
      const dni = cuit ? '' : ((bloque.match(/\b(?:dni|documento)\s*:?\s*(\d{7,8})\b/i) || [])[1] || '');
      const importeTxt = (bloque.match(/\$\s*([\d.,]+\s*(?:k|mil)?)/i) || bloque.match(/\b([\d.,]+\s*(?:k|mil|lucas))\b/i) || bloque.match(/\b(?:por|monto|total|importe)\s*:?\s*([\d.,]{3,})/i) || [])[1];
      const importe = parseImporte(importeTxt);
      if (!importe) continue;

      const nombre = ((bloque.match(/(?:a nombre de|factur(?:ale|ar|á|a) a|hacele (?:la )?factura a|cliente|raz[oó]n social|para)\s*:?\s+([^,\n.$0-9]+)/i) || [])[1] || '')
        .replace(/\b(?:cuit|dni|por|monto|pesos)\b.*/i, '').trim();
      const desc = ((bloque.match(/(?:concepto|descripci[oó]n|detalle|en concepto de)\s*:?\s+([^,\n$]+)/i) || [])[1] || '').trim();
      const condIva = /responsable inscripto|\bri\b/i.test(bloque) ? 'Responsable Inscripto'
        : /monotribut/i.test(bloque) ? 'Monotributo' : /exento/i.test(bloque) ? 'Exento' : /consumidor final/i.test(bloque) ? 'Consumidor Final' : '';
      // "Factura A" solo con la letra en mayúscula: en "factura a Acme" la "a" es una preposición
      const letra = (l: string) => new RegExp(`\\b[Ff]actura\\s+${l}\\b`).test(bloque) || new RegExp(`\\b[Ff]actura\\s+tipo\\s+${l}\\b`, 'i').test(bloque);
      const tipo = letra('A') ? 'Factura A' : letra('B') ? 'Factura B' : /recibo/i.test(bloque) ? 'Recibo C' : 'Factura C';

      borradores.push(this.normalizarBorrador({
        tipoComprobante: tipo,
        concepto: /producto|mercader[ií]a|art[ií]culo|insumo/i.test(bloque) ? 1 : 2,
        docNro: cuit || dni,
        docTipo: dni ? 'DNI' : undefined,
        razonSocial: nombre,
        condicionIva: condIva,
        descripcion: desc,
        importeTotal: importe,
        email: (bloque.match(/[^\s@]+@[^\s@]+\.[^\s@,]+/) || [])[0],
      }));
    }
    return borradores;
  }

  /**
   * Filas pegadas de Excel/CSV. Columnas aceptadas (con o sin encabezado):
   * CUIT/DNI · Razón social · Descripción · Importe · Email · Condición IVA
   * (o con punto de venta y tipo adelante: PV · Tipo · CUIT/DNI · Razón social · Descripción · Importe)
   */
  public parseTabular(rawText: string): ParsedInvoiceDraft[] {
    // Solo se recorta el final: las celdas vacías del principio (ej. sin CUIT) son tabuladores que no hay que perder
    const lineas = rawText.split(/\r?\n/).map(l => l.replace(/[\r\s]+$/, '')).filter(l => l.trim());
    const borradores: ParsedInvoiceDraft[] = [];

    lineas.forEach((linea, i) => {
      const sep = linea.includes('\t') ? '\t' : linea.includes(';') ? ';' : ',';
      const c = linea.split(sep).map(x => x.trim());
      const encabezado = c.join(' ').toLowerCase();
      if (i === 0 && /cuit|importe|raz[oó]n|monto|dni/.test(encabezado)) return;

      let fila: any;
      if (c.length >= 6 && /^\d{1,5}$/.test(c[0]) && /factura|recibo|nota/i.test(c[1])) {
        fila = { puntoVenta: c[0], tipoComprobante: c[1], docNro: c[2], razonSocial: c[3], descripcion: c[4], importeTotal: c[5], email: c[6], condicionIva: c[7] };
      } else {
        fila = { docNro: c[0], razonSocial: c[1], descripcion: c[2], importeTotal: c[3], email: c[4], condicionIva: c[5] };
        if (c.length === 2) fila = { docNro: c[0], importeTotal: c[1] };
        if (c.length === 3) fila = { docNro: c[0], descripcion: c[1], importeTotal: c[2] };
      }
      const b = this.normalizarBorrador(fila);
      if (b.importeTotal > 0) borradores.push(b);
    });
    return borradores;
  }
}

export const aiParserService = new AiParserService();
