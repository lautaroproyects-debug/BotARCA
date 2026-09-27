import { db } from '../../database.js';
import { supabase } from '../supabase.js';
import { logger } from '../logger.js';

export interface ClienteRecord {
  id: string;
  cuit: string;
  tipoDoc: 'CUIT' | 'DNI' | 'Consumidor Final' | 'Pasaporte';
  razonSocial: string;
  condicionIva: 'Responsable Inscripto' | 'Monotributo' | 'Consumidor Final' | 'Exento';
  domicilio?: string;
  email?: string;
  telefono?: string;
  saldoCuenta: number;
  notas?: string;
  createdAt: string;
}

class ClientesService {
  private localClientes: ClienteRecord[] = [
    {
      id: 'cli_1',
      cuit: '30711223344',
      tipoDoc: 'CUIT',
      razonSocial: 'EMPRESA SERVICIOS SRL',
      condicionIva: 'Responsable Inscripto',
      domicilio: 'Av. Corrientes 1234, CABA',
      email: 'facturacion@servicios.com.ar',
      telefono: '+54 11 4321-8899',
      saldoCuenta: 0.00,
      notas: 'Cliente habitual de servicios de consultoría',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'cli_2',
      cuit: '20358901234',
      tipoDoc: 'DNI',
      razonSocial: 'JUAN MANUEL PEREZ',
      condicionIva: 'Consumidor Final',
      domicilio: 'Calle Florida 550, CABA',
      email: 'juan.perez@gmail.com',
      telefono: '+54 11 6543-2100',
      saldoCuenta: 0.00,
      notas: 'Cliente particular',
      createdAt: new Date().toISOString(),
    }
  ];

  constructor() {
    this.syncFromSupabase().catch(() => {});
  }

  private async syncFromSupabase() {
    const supaData = await supabase.getClientes();
    if (supaData && supaData.length > 0) {
      this.localClientes = supaData.map(c => ({
        id: c.id,
        cuit: c.cuit,
        tipoDoc: c.tipo_doc || 'CUIT',
        razonSocial: c.razon_social,
        condicionIva: c.condicion_iva || 'Consumidor Final',
        domicilio: c.domicilio,
        email: c.email,
        telefono: c.telefono,
        saldoCuenta: parseFloat(c.saldo_cuenta || '0'),
        notas: c.notas,
        createdAt: c.created_at,
      }));
    }
  }

  public async getAll(): Promise<ClienteRecord[]> {
    return this.localClientes;
  }

  public async getByCuit(cuit: string): Promise<ClienteRecord | null> {
    const clean = cuit.replace(/\D/g, '');
    return this.localClientes.find(c => c.cuit.replace(/\D/g, '') === clean) || null;
  }

  public async save(cliente: Omit<ClienteRecord, 'id' | 'createdAt' | 'saldoCuenta'> & { id?: string }): Promise<ClienteRecord> {
    const cleanCuit = cliente.cuit.replace(/\D/g, '');
    let existing = this.localClientes.find(c => c.cuit.replace(/\D/g, '') === cleanCuit);

    if (existing) {
      existing = {
        ...existing,
        ...cliente,
        cuit: cleanCuit,
      };
      const idx = this.localClientes.findIndex(c => c.id === existing!.id);
      this.localClientes[idx] = existing;
    } else {
      existing = {
        id: 'cli_' + Date.now(),
        ...cliente,
        cuit: cleanCuit,
        saldoCuenta: 0,
        createdAt: new Date().toISOString(),
      };
      this.localClientes.unshift(existing);
    }

    // Sincronizar en segundo plano con Supabase si está disponible
    supabase.saveCliente({
      cuit: existing.cuit,
      tipo_doc: existing.tipoDoc,
      razon_social: existing.razonSocial,
      condicion_iva: existing.condicionIva,
      domicilio: existing.domicilio,
      email: existing.email,
      telefono: existing.telefono,
      notas: existing.notas,
    }).catch(() => {});

    logger.info('CRM', `Cliente guardado: ${existing.razonSocial} (${existing.cuit})`);
    return existing;
  }

  public async delete(id: string): Promise<boolean> {
    const idx = this.localClientes.findIndex(c => c.id === id);
    if (idx !== -1) {
      this.localClientes.splice(idx, 1);
      return true;
    }
    return false;
  }
}

export const clientesService = new ClientesService();
