import { supabase } from './supabase.js';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface UploadAttachmentOptions {
  filename: string;
  buffer?: Buffer;
  base64?: string;
  contentType?: string;
  folder?: string;
  cuit?: string;
  bucketName?: string;
  isPublic?: boolean;
}

export interface UploadAttachmentResult {
  success: boolean;
  url?: string;
  publicUrl?: string;
  path?: string;
  key?: string;
  filename?: string;
  size?: number;
  error?: string;
}

class StorageService {
  private defaultBucket: string;
  private verifiedBuckets: Set<string> = new Set();

  constructor() {
    this.defaultBucket = config.storage.bucket || 'facturas-adjuntos';
  }

  /**
   * Asegura que el bucket exista en Supabase Storage (lo crea automáticamente si no existe)
   */
  public async ensureBucket(bucketName: string = this.defaultBucket, isPublic: boolean = true): Promise<boolean> {
    if (this.verifiedBuckets.has(bucketName)) {
      return true;
    }

    const client = supabase.getClient();
    if (!client) {
      logger.warn('STORAGE', 'Supabase Client no inicializado al verificar bucket.');
      return false;
    }

    try {
      const { data: buckets, error: listError } = await client.storage.listBuckets();
      if (!listError && buckets) {
        const exists = buckets.some(b => b.name === bucketName);
        if (exists) {
          this.verifiedBuckets.add(bucketName);
          return true;
        }
      }

      // Crear bucket si no existe
      logger.info('STORAGE', `Creando bucket de almacenamiento "${bucketName}" en Supabase...`);
      const { data, error } = await client.storage.createBucket(bucketName, {
        public: isPublic,
        fileSizeLimit: 52428800, // 50MB
        allowedMimeTypes: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'text/csv',
          'text/plain',
          'application/json',
          'image/png',
          'image/jpeg',
          'image/webp',
          'application/xml',
          'text/xml'
        ]
      });

      if (error && !error.message?.includes('already exists')) {
        logger.warn('STORAGE', `Aviso al crear bucket "${bucketName}": ${error.message}`);
      }

      this.verifiedBuckets.add(bucketName);
      return true;
    } catch (err: any) {
      logger.error('STORAGE', `Excepción verificando bucket "${bucketName}": ${err.message}`);
      return false;
    }
  }

  /**
   * Sube un archivo adjunto (PDF de factura, planilla, comprobante, etc.) a Supabase Storage
   */
  public async uploadAttachment(options: UploadAttachmentOptions): Promise<UploadAttachmentResult> {
    const client = supabase.getClient();
    if (!client) {
      logger.error('STORAGE', 'No se puede subir archivo: Supabase no está configurado o conectado.');
      return {
        success: false,
        error: 'Supabase Storage no está configurado (faltan SUPABASE_URL y SUPABASE_KEY en Render).'
      };
    }

    const bucket = options.bucketName || this.defaultBucket;
    await this.ensureBucket(bucket, options.isPublic !== false);

    try {
      // 1. Obtener Buffer
      let fileBuffer: Buffer;
      if (options.buffer) {
        fileBuffer = options.buffer;
      } else if (options.base64) {
        const cleanBase64 = options.base64.replace(/^data:[^;]+;base64,/, '');
        fileBuffer = Buffer.from(cleanBase64, 'base64');
      } else {
        return { success: false, error: 'No se proveyó contenido binario ni base64 para el archivo.' };
      }

      // 2. Determinar MIME Type
      let contentType = options.contentType || 'application/octet-stream';
      const ext = options.filename.split('.').pop()?.toLowerCase();
      if (!options.contentType) {
        if (ext === 'pdf') contentType = 'application/pdf';
        else if (ext === 'xlsx') contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (ext === 'xls') contentType = 'application/vnd.ms-excel';
        else if (ext === 'csv') contentType = 'text/csv';
        else if (ext === 'png') contentType = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
        else if (ext === 'xml') contentType = 'application/xml';
        else if (ext === 'json') contentType = 'application/json';
      }

      // 3. Construir ruta limpia en la nube
      const cleanFilename = options.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = Date.now();
      const cuitFolder = options.cuit ? `cuit_${options.cuit}` : 'general';
      const subFolder = options.folder ? options.folder.replace(/^\/+|\/+$/g, '') : 'adjuntos';
      const storagePath = `${cuitFolder}/${subFolder}/${timestamp}_${cleanFilename}`;

      logger.info('STORAGE', `Subiendo archivo a Supabase Storage: [${bucket}] ${storagePath} (${fileBuffer.length} bytes)...`);

      // 4. Subir a Supabase Storage
      const { data, error } = await client.storage
        .from(bucket)
        .upload(storagePath, fileBuffer, {
          contentType,
          upsert: true,
        });

      if (error) {
        logger.error('STORAGE', `Error subiendo a Supabase Storage: ${error.message}`);
        return { success: false, error: error.message };
      }

      // 5. Obtener URL pública
      const { data: publicUrlData } = client.storage.from(bucket).getPublicUrl(storagePath);
      const publicUrl = publicUrlData?.publicUrl || '';

      logger.success('STORAGE', `¡Archivo guardado en Supabase Storage exitosamente! URL: ${publicUrl}`);

      return {
        success: true,
        url: publicUrl,
        publicUrl,
        path: storagePath,
        key: data?.path || storagePath,
        filename: cleanFilename,
        size: fileBuffer.length,
      };

    } catch (err: any) {
      logger.error('STORAGE', `Excepción al subir a Supabase Storage: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Descarga un archivo desde Supabase Storage a memoria Buffer
   */
  public async downloadAttachment(storagePath: string, bucketName: string = this.defaultBucket): Promise<{ success: boolean; data?: Buffer; contentType?: string; error?: string }> {
    const client = supabase.getClient();
    if (!client) {
      return { success: false, error: 'Supabase no está configurado.' };
    }

    try {
      const { data, error } = await client.storage.from(bucketName).download(storagePath);
      if (error || !data) {
        return { success: false, error: error?.message || 'Archivo no encontrado' };
      }

      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return {
        success: true,
        data: buffer,
        contentType: data.type,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Elimina un archivo de Supabase Storage
   */
  public async deleteAttachment(storagePath: string, bucketName: string = this.defaultBucket): Promise<{ success: boolean; error?: string }> {
    const client = supabase.getClient();
    if (!client) return { success: false, error: 'Supabase no conectado' };

    try {
      const { error } = await client.storage.from(bucketName).remove([storagePath]);
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Lista archivos en una carpeta de Supabase Storage
   */
  public async listAttachments(folder: string = '', bucketName: string = this.defaultBucket): Promise<{ success: boolean; files?: any[]; error?: string }> {
    const client = supabase.getClient();
    if (!client) return { success: false, error: 'Supabase no conectado' };

    try {
      const { data, error } = await client.storage.from(bucketName).list(folder, {
        limit: 100,
        sortBy: { column: 'created_at', order: 'desc' }
      });
      if (error) return { success: false, error: error.message };
      return { success: true, files: data || [] };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Genera un enlace firmado temporal para descargas privadas
   */
  public async getSignedUrl(storagePath: string, expiresInSeconds: number = 3600, bucketName: string = this.defaultBucket): Promise<{ success: boolean; signedUrl?: string; error?: string }> {
    const client = supabase.getClient();
    if (!client) return { success: false, error: 'Supabase no conectado' };

    try {
      const { data, error } = await client.storage.from(bucketName).createSignedUrl(storagePath, expiresInSeconds);
      if (error) return { success: false, error: error.message };
      return { success: true, signedUrl: data?.signedUrl };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

export const storageService = new StorageService();
