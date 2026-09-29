import { Router, Request, Response } from 'express';
import { storageService } from '../services/storageService.js';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * POST /api/storage/upload
 * Sube un archivo adjunto a Supabase Storage
 */
router.post('/upload', async (req: Request, res: Response) => {
  const { filename, base64, contentType, folder, cuit, isPublic } = req.body;

  if (!filename || !base64) {
    return res.status(400).json({
      success: false,
      message: 'Se requieren los campos "filename" y "base64" para subir el archivo.'
    });
  }

  try {
    const result = await storageService.uploadAttachment({
      filename,
      base64,
      contentType,
      folder: folder || 'adjuntos',
      cuit,
      isPublic: isPublic !== false,
    });

    if (result.success) {
      return res.json({
        success: true,
        message: 'Archivo subido a Supabase Storage con éxito.',
        file: {
          url: result.url,
          publicUrl: result.publicUrl,
          path: result.path,
          filename: result.filename,
          size: result.size,
        }
      });
    } else {
      return res.status(500).json({
        success: false,
        message: result.error || 'Error al guardar archivo en Supabase Storage.'
      });
    }
  } catch (err: any) {
    logger.error('STORAGE-API', `Error en upload: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: `Error interno: ${err.message}`
    });
  }
});

/**
 * GET /api/storage/files
 * Lista archivos almacenados en Supabase Storage
 */
router.get('/files', async (req: Request, res: Response) => {
  const folder = (req.query.folder as string) || '';
  const bucket = (req.query.bucket as string) || undefined;

  try {
    const result = await storageService.listAttachments(folder, bucket);
    if (result.success) {
      return res.json({ success: true, files: result.files });
    } else {
      return res.status(500).json({ success: false, message: result.error });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/storage/signed-url
 * Genera una URL firmada para un archivo
 */
router.get('/signed-url', async (req: Request, res: Response) => {
  const path = req.query.path as string;
  const expiresIn = parseInt((req.query.expiresIn as string) || '3600', 10);
  const bucket = req.query.bucket as string;

  if (!path) {
    return res.status(400).json({ success: false, message: 'Falta el parámetro "path".' });
  }

  try {
    const result = await storageService.getSignedUrl(path, expiresIn, bucket);
    if (result.success) {
      return res.json({ success: true, signedUrl: result.signedUrl });
    } else {
      return res.status(500).json({ success: false, message: result.error });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/storage/file
 * Elimina un archivo de Supabase Storage
 */
router.delete('/file', async (req: Request, res: Response) => {
  const path = (req.query.path as string) || req.body?.path;
  const bucket = (req.query.bucket as string) || req.body?.bucket;

  if (!path) {
    return res.status(400).json({ success: false, message: 'Falta especificar la ruta "path" del archivo.' });
  }

  try {
    const result = await storageService.deleteAttachment(path, bucket);
    if (result.success) {
      return res.json({ success: true, message: 'Archivo eliminado de Supabase Storage.' });
    } else {
      return res.status(500).json({ success: false, message: result.error });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
