import { Router, Request, Response } from 'express';
import { db } from '../database.js';
import { supabase } from '../services/supabase.js';

const router = Router();

// Listar todas las cuentas CUIT
router.get('/', (req: Request, res: Response) => {
  const accounts = db.getAccounts();
  const currentCreds = db.getCredentials();
  res.json({
    success: true,
    activeCuit: currentCreds.cuit,
    accounts,
  });
});

// Agregar o actualizar cuenta CUIT
router.post('/', async (req: Request, res: Response) => {
  const { cuit, claveFiscal, puntoVentaDefault, razonSocial } = req.body;

  if (!cuit) {
    return res.status(400).json({ success: false, message: 'El CUIT es obligatorio.' });
  }

  const cleanCuit = cuit.replace(/\D/g, '');
  if (cleanCuit.length !== 11) {
    return res.status(400).json({ success: false, message: 'El CUIT debe tener 11 dígitos numéricos.' });
  }

  db.setCredentials(cleanCuit, claveFiscal, Number(puntoVentaDefault) || 1, razonSocial);

  // Sincronizar en Supabase cuentas_arca
  const supa = supabase.getClient();
  if (supa) {
    try {
      const encrypted = db.data.credentials.encryptedClaveFiscal;
      await supa.from('cuentas_arca').upsert({
        cuit: cleanCuit,
        razon_social: razonSocial || `Cuenta ${cleanCuit}`,
        encrypted_clave_fiscal: encrypted,
        punto_venta_default: Number(puntoVentaDefault) || 1,
        activa: true,
      }, { onConflict: 'cuit' });
    } catch (e) {}
  }

  res.json({
    success: true,
    message: 'Cuenta fiscal guardada y activada correctamente.',
    cuit: cleanCuit,
    accounts: db.getAccounts(),
  });
});

// Cambiar cuenta CUIT activa
router.post('/switch', (req: Request, res: Response) => {
  const { cuit } = req.body;
  if (!cuit) return res.status(400).json({ success: false, message: 'Falta especificar el CUIT.' });

  const switched = db.switchActiveAccount(cuit.replace(/\D/g, ''));
  if (switched) {
    res.json({ success: true, message: `Cuenta activa cambiada a CUIT ${cuit}.`, activeCuit: cuit });
  } else {
    res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  }
});

// Eliminar cuenta CUIT
router.delete('/:cuit', (req: Request, res: Response) => {
  const { cuit } = req.params;
  if (!cuit) return res.status(400).json({ success: false, message: 'Falta especificar el CUIT.' });

  const deleted = db.deleteAccount(String(cuit));
  if (deleted) {
    res.json({ success: true, message: `Cuenta CUIT ${cuit} eliminada.`, accounts: db.getAccounts() });
  } else {
    res.status(404).json({ success: false, message: 'Cuenta CUIT no encontrada.' });
  }
});

export default router;
