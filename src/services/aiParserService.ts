import axios from 'axios';
import { db, InvoicingQueueItem } from '../database.js';
import { logger } from './logger.js';

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
}

class AiParserService {
  /**
   * Obtiene la API Key de Groq desde base de datos o variable de entorno
   */
  public getGroqApiKey(): string {
    const settings = db.getSettings() as any;
    return settings.groqApiKey || process.env.GROQ_API_KEY || '';
  }

  /**
   * Parsea texto inteligente proveniente de Excel, WhatsApp, correos o texto desestructurado
   */
  public async parseSmart(rawText: string, options: { forceAi?: boolean } = {}): Promise<{
    items: ParsedInvoiceDraft[];
    parserUsed: 'groq_ai' | 'heuristic_nlp' | 'tabular';
    message?: string;
  }> {
    if (!rawText || !rawText.trim()) {
      return { items: [], parserUsed: 'tabular' };
    }

    const text = rawText.trim();
    const isTabular = text.includes('\t') || (text.includes(';') && text.includes('\n')) || (text.includes(',') && text.split('\n')[0].split(',').length >= 3);
    const groqKey = this.getGroqApiKey();

    // 1. Si se solicita IA explícitamente o tiene formato libre / mensaje de WhatsApp y hay API key de Groq
    if ((options.forceAi || !isTabular || text.length > 50) && groqKey) {
      try {
        const groqItems = await this.parseWithGroq(text, groqKey);
        if (groqItems.length > 0) {
          logger.success('AI-PARSER', `Interpretadas ${groqItems.length} facturas con IA Groq (Llama-3.3-70B).`);
          return { items: groqItems, parserUsed: 'groq_ai' };
        }
      } catch (err: any) {
        logger.warn('AI-PARSER', `Fallo al interpretar con Groq: ${err.message}. Pasando a parser heurístico...`);
      }
    }

    // 2. Si no es tabular tradicional pero contiene texto tipo WhatsApp o notas
    if (!isTabular || options.forceAi) {
      const heuristicItems = this.parseWithHeuristics(text);
      if (heuristicItems.length > 0) {
        return { items: heuristicItems, parserUsed: 'heuristic_nlp' };
      }
    }

    // 3. Parser tabular estándar (Excel / CSV)
    const tabularItems = this.parseTabular(text);
    return { items: tabularItems, parserUsed: 'tabular' };
  }

  /**
   * Extracción inteligente mediante Groq LLM API (Llama 3.3 70B Versatile)
   */
  public async parseWithGroq(rawText: string, apiKey: string): Promise<ParsedInvoiceDraft[]> {
    const creds = db.getCredentials();
    const defaultPtoVta = creds.puntoVentaDefault || 1;

    const systemPrompt = `Eres un extractor experto de datos de facturación fiscal para la República Argentina (ARCA / ex-AFIP).
Tu objetivo es analizar mensajes de texto libre, conversaciones de WhatsApp, correos electrónicos, notas desestructuradas o tablas pegadas, y extraer una lista de comprobantes a emitir en formato JSON estructurado.

Reglas de extracción para Argentina:
1. CUIT: Extrae números de CUIT válidos (11 dígitos, normalmente empiezan con 20, 23, 24, 27, 30, 33, 34). Limpia guiones y espacios.
2. DNI: Si son 7 u 8 dígitos sin prefijo de CUIT, asigna docTipo "DNI".
3. Razón Social: Extrae el nombre o empresa del receptor. Si no se menciona explícitamente, usa "Consumidor Final" o el nombre de contacto.
4. Importe: Extrae el monto total. Entiende formatos argentinos ($150.000, 150000, 150k = 150000, $ 2.500,50 = 2500.50).
5. Concepto:
   - 1 = Productos / Mercadería
   - 2 = Servicios / Honorarios / Consultoría / Desarrollo / Alquileres (Por defecto)
   - 3 = Productos y Servicios
6. Tipo Comprobante: "Factura C" por defecto para Monotributistas, o "Factura A" / "Factura B" según corresponda.
7. Condición IVA: "Responsable Inscripto", "Monotributo" o "Consumidor Final".

Devuelve EXCLUSIVAMENTE un arreglo JSON válido (sin explicaciones, sin formato markdown adicional, solo el JSON raw):
[
  {
    "puntoVenta": ${defaultPtoVta},
    "tipoComprobante": "Factura C",
    "concepto": 2,
    "docTipo": "CUIT",
    "docNro": "30712345678",
    "razonSocial": "Empresa Ejemplo SRL",
    "condicionIva": "Responsable Inscripto",
    "condicionVenta": "Contado",
    "descripcion": "Honorarios profesionales de desarrollo web",
    "cantidad": 1,
    "precioUnitario": 150000,
    "importeTotal": 150000,
    "email": "contacto@ejemplo.com"
  }
]`;

    const modelsToTry = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
    let content = '';

    for (const modelName of modelsToTry) {
      try {
        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: modelName,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: rawText }
            ],
            temperature: 0.1,
            max_tokens: 2048,
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey.trim()}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );

        content = response.data?.choices?.[0]?.message?.content || '';
        if (content) break;
      } catch (err: any) {
        logger.warn('AI-GROQ', `Modelo ${modelName} no disponible: ${err.message}. Probando siguiente...`);
      }
    }

    if (!content) return [];

    try {
      const cleanJson = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleanJson);
      const itemsArray: any[] = Array.isArray(parsed) 
        ? parsed 
        : (parsed.items || parsed.facturas || parsed.comprobantes || Object.values(parsed)[0] || []);

      if (!Array.isArray(itemsArray)) return [];

      return itemsArray.map(item => ({
        cuitEmisor: creds.cuit,
        puntoVenta: Number(item.puntoVenta) || defaultPtoVta,
        tipoComprobante: item.tipoComprobante || 'Factura C',
        concepto: Number(item.concepto) || 2,
        docTipo: item.docTipo || (String(item.docNro).length === 11 ? 'CUIT' : 'Consumidor Final'),
        docNro: String(item.docNro || '').replace(/\D/g, ''),
        razonSocial: item.razonSocial || `Receptor ${item.docNro}`,
        condicionIva: item.condicionIva || 'Consumidor Final',
        condicionVenta: item.condicionVenta || 'Contado',
        descripcion: item.descripcion || 'Servicios profesionales',
        cantidad: Number(item.cantidad) || 1,
        precioUnitario: Number(item.precioUnitario) || Number(item.importeTotal) || 0,
        importeTotal: Number(item.importeTotal) || (Number(item.precioUnitario) * (Number(item.cantidad) || 1)) || 0,
        email: item.email || '',
      })).filter(x => x.docNro && x.importeTotal > 0);
    } catch (e) {
      return [];
    }
  }

  /**
   * Parser heurístico basado en expresiones regulares y NLP para WhatsApp / Chat sin depender de APIs externas
   */
  public parseWithHeuristics(rawText: string): ParsedInvoiceDraft[] {
    const creds = db.getCredentials();
    const defaultPtoVta = creds.puntoVentaDefault || 1;
    const items: ParsedInvoiceDraft[] = [];

    // Limpiar marcas de tiempo de WhatsApp tipo "[28/9, 14:32] Juan:" o "28/09/2026 14:30 - Lautaro: "
    const cleanLines = rawText.split(/\r?\n/).map(line => {
      return line.replace(/^\[?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\]?\s*[-–]?\s*[^:]+:\s*/i, '').trim();
    }).filter(l => l.length > 0);

    // Agrupar mensajes continuos o analizarlos por bloques
    const textBlob = cleanLines.join('\n');
    const messageBlocks = textBlob.split(/(?=\b(?:facturar|factura|hacer factura|emitir|cuit|cliente|para)\b)/i).filter(b => b.trim().length > 0);

    const blocksToProcess = messageBlocks.length > 1 ? messageBlocks : cleanLines;

    for (const block of blocksToProcess) {
      // 1. Detectar CUIT o DNI
      const cuitMatch = block.match(/\b(20|23|24|27|30|33|34)-?(\d{8})-?(\d)\b/) || block.match(/\b(20|23|24|27|30|33|34)(\d{9})\b/);
      let docNro = '';
      let docTipo: 'CUIT' | 'DNI' | 'Consumidor Final' = 'CUIT';

      if (cuitMatch) {
        docNro = cuitMatch[0].replace(/\D/g, '');
        docTipo = 'CUIT';
      } else {
        const dniMatch = block.match(/\b(?:dni|documento)?\s*(\d{7,8})\b/i);
        if (dniMatch) {
          docNro = dniMatch[1];
          docTipo = 'DNI';
        }
      }

      // 2. Detectar Importe Monetario ($150.000, $150000, 150k, 50 mil)
      let importe = 0;
      const kMatch = block.match(/\b(\d+(?:[.,]\d+)?)\s*k\b/i);
      const milMatch = block.match(/\b(\d+(?:[.,]\d+)?)\s*(?:mil|lucas)\b/i);
      const currencyMatch = block.match(/\$\s*([\d.,]+)/) || block.match(/\b([\d.,]+)\s*(?:pesos|ars|\$)\b/i) || block.match(/\b(?:por|monto|total|suma de|importe)?\s*([\d.,]{3,})\b/i);

      if (kMatch) {
        importe = parseFloat(kMatch[1].replace(',', '.')) * 1000;
      } else if (milMatch) {
        importe = parseFloat(milMatch[1].replace(',', '.')) * 1000;
      } else if (currencyMatch) {
        importe = this.parseNumeric(currencyMatch[1]);
      }

      if (!docNro || importe <= 0) continue;

      // 3. Detectar Razón Social / Nombre
      let razonSocial = '';
      const razonMatch = block.match(/(?:a nombre de|cliente|razon social|titular|para|empresa)[:\s]+([^,\n\.$]+)/i)
        || block.match(/(?:facturale a|factura a|hacela a|emitir a)[:\s]+([^,\n\.$0-9]+)/i);

      if (razonMatch && razonMatch[1]) {
        razonSocial = razonMatch[1].trim().replace(/\b(?:cuit|dni|por|monto|pesos)\b.*/i, '').trim();
      }
      if (!razonSocial) {
        razonSocial = docTipo === 'CUIT' ? `Cliente CUIT ${docNro}` : `Consumidor Final ${docNro}`;
      }

      // 4. Detectar Descripción y Concepto
      let descripcion = 'Servicios profesionales';
      let concepto = 2; // Servicios por defecto

      const descMatch = block.match(/(?:concepto|descripcion|por|detalle|en concepto de)[:\s]+([^,\n\$]+)/i);
      if (descMatch && descMatch[1]) {
        descripcion = descMatch[1].trim();
      }

      if (/producto|mercaderia|articulos|venta de|insumo/i.test(block)) {
        concepto = 1;
      } else if (/servicio|honorario|consultoria|asesoramiento|mantenimiento|desarrollo|alquiler/i.test(block)) {
        concepto = 2;
      }

      // 5. Detectar Tipo Comprobante
      let tipoComprobante = 'Factura C';
      if (/factura a\b/i.test(block)) tipoComprobante = 'Factura A';
      else if (/factura b\b/i.test(block)) tipoComprobante = 'Factura B';
      else if (/recibo c\b/i.test(block)) tipoComprobante = 'Recibo C';

      items.push({
        cuitEmisor: creds.cuit,
        puntoVenta: defaultPtoVta,
        tipoComprobante,
        concepto,
        docTipo,
        docNro,
        razonSocial,
        condicionIva: docTipo === 'CUIT' ? 'Responsable Inscripto' : 'Consumidor Final',
        condicionVenta: 'Contado',
        descripcion,
        cantidad: 1,
        precioUnitario: importe,
        importeTotal: importe,
      });
    }

    return items;
  }

  /**
   * Parser tabular tradicional para filas de Excel o CSV
   */
  public parseTabular(rawText: string): ParsedInvoiceDraft[] {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const parsed: ParsedInvoiceDraft[] = [];
    const creds = db.getCredentials();
    const defaultPtoVta = creds.puntoVentaDefault || 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let cols: string[] = [];
      if (line.includes('\t')) cols = line.split('\t').map(c => c.trim());
      else if (line.includes(';')) cols = line.split(';').map(c => c.trim());
      else if (line.includes(',')) cols = line.split(',').map(c => c.trim());
      else cols = [line];

      const lowerHeader = cols.join(' ').toLowerCase();
      if (i === 0 && (lowerHeader.includes('cuit') || lowerHeader.includes('importe') || lowerHeader.includes('razon') || lowerHeader.includes('monto'))) {
        continue;
      }

      let ptoVta = defaultPtoVta;
      let tipoComp = 'Factura C';
      let docNro = '';
      let razonSocial = '';
      let descripcion = 'Servicios profesionales';
      let importe = 0;
      let email = '';

      if (cols.length >= 4 && cols[0].length <= 4 && !isNaN(Number(cols[0]))) {
        ptoVta = parseInt(cols[0], 10) || defaultPtoVta;
        tipoComp = cols[1] || 'Factura C';
        docNro = cols[2]?.replace(/\D/g, '') || '';
        razonSocial = cols[3] || 'Consumidor Final';
        descripcion = cols[4] || 'Servicios profesionales';
        importe = this.parseNumeric(cols[5] || cols[cols.length - 1]);
      } else if (cols.length >= 4) {
        docNro = cols[0]?.replace(/\D/g, '') || '';
        razonSocial = cols[1] || 'Consumidor Final';
        descripcion = cols[2] || 'Servicios profesionales';
        importe = this.parseNumeric(cols[3]);
        if (cols[4]) email = cols[4];
      } else if (cols.length === 3) {
        docNro = cols[0]?.replace(/\D/g, '') || '';
        if (isNaN(this.parseNumeric(cols[1])) && !isNaN(this.parseNumeric(cols[2]))) {
          razonSocial = cols[1];
          importe = this.parseNumeric(cols[2]);
        } else {
          descripcion = cols[1];
          importe = this.parseNumeric(cols[2]);
        }
      } else if (cols.length === 2) {
        docNro = cols[0]?.replace(/\D/g, '') || '';
        importe = this.parseNumeric(cols[1]);
        razonSocial = `Cliente ${docNro}`;
      }

      if (docNro && importe > 0) {
        parsed.push({
          cuitEmisor: creds.cuit,
          puntoVenta: ptoVta,
          tipoComprobante: tipoComp,
          concepto: 2,
          docTipo: docNro.length === 11 ? 'CUIT' : (docNro.length === 8 ? 'DNI' : 'Consumidor Final'),
          docNro,
          razonSocial: razonSocial || `Receptor ${docNro}`,
          condicionIva: docNro.length === 11 ? 'Responsable Inscripto' : 'Consumidor Final',
          condicionVenta: 'Contado',
          descripcion: descripcion || 'Servicios profesionales',
          cantidad: 1,
          precioUnitario: importe,
          importeTotal: importe,
          email,
        });
      }
    }

    return parsed;
  }

  private parseNumeric(val: string): number {
    if (!val) return 0;
    const clean = val.replace(/\$/g, '').trim().replace(/\./g, '').replace(',', '.');
    return parseFloat(clean) || 0;
  }
}

export const aiParserService = new AiParserService();
