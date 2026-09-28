import { Request, Response, NextFunction } from 'express';

export interface ValidationRule {
  field: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'email' | 'cuit';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: (string | number)[];
  pattern?: RegExp;
}

/**
 * Validador de algoritmo Modulo 11 para CUIT/CUIL argentino
 */
export function isValidCuit(cuit: string): boolean {
  const clean = String(cuit || '').replace(/\D/g, '');
  if (clean.length !== 11) return false;

  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(clean[i], 10) * multipliers[i];
  }

  const mod = sum % 11;
  let verifier = 11 - mod;
  if (verifier === 11) verifier = 0;
  if (verifier === 10) verifier = 9;

  return verifier === parseInt(clean[10], 10);
}

/**
 * Validador de formato de correo electrónico
 */
export function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(String(email).trim());
}

/**
 * Middleware generador de validación de esquemas en backend
 */
export function validateBody(rules: ValidationRule[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: string[] = [];
    const body = req.body || {};

    for (const rule of rules) {
      const val = body[rule.field];

      // Campo requerido
      if (rule.required && (val === undefined || val === null || val === '')) {
        errors.push(`El campo "${rule.field}" es obligatorio.`);
        continue;
      }

      // Si no es requerido y viene vacío, continuar
      if (val === undefined || val === null || val === '') {
        continue;
      }

      // Validar tipo
      if (rule.type === 'cuit') {
        const clean = String(val).replace(/\D/g, '');
        if (clean.length !== 11) {
          errors.push(`El campo "${rule.field}" debe ser un CUIT/CUIL de 11 dígitos numéricos.`);
        }
      } else if (rule.type === 'email') {
        if (!isValidEmail(val)) {
          errors.push(`El campo "${rule.field}" no tiene un formato de correo electrónico válido.`);
        }
      } else if (rule.type === 'string') {
        if (typeof val !== 'string') {
          errors.push(`El campo "${rule.field}" debe ser una cadena de texto.`);
        } else {
          if (rule.minLength && val.length < rule.minLength) {
            errors.push(`El campo "${rule.field}" debe tener al menos ${rule.minLength} caracteres.`);
          }
          if (rule.maxLength && val.length > rule.maxLength) {
            errors.push(`El campo "${rule.field}" no puede exceder ${rule.maxLength} caracteres.`);
          }
          if (rule.pattern && !rule.pattern.test(val)) {
            errors.push(`El campo "${rule.field}" tiene un formato inválido.`);
          }
        }
      } else if (rule.type === 'number') {
        const num = Number(val);
        if (isNaN(num)) {
          errors.push(`El campo "${rule.field}" debe ser un valor numérico.`);
        } else {
          if (rule.min !== undefined && num < rule.min) {
            errors.push(`El campo "${rule.field}" debe ser mayor o igual a ${rule.min}.`);
          }
          if (rule.max !== undefined && num > rule.max) {
            errors.push(`El campo "${rule.field}" debe ser menor o igual a ${rule.max}.`);
          }
        }
      } else if (rule.type === 'array') {
        if (!Array.isArray(val)) {
          errors.push(`El campo "${rule.field}" debe ser una lista/array.`);
        } else if (rule.minLength && val.length < rule.minLength) {
          errors.push(`El campo "${rule.field}" debe contener al menos ${rule.minLength} elementos.`);
        }
      } else if (rule.type === 'boolean') {
        if (typeof val !== 'boolean' && val !== 'true' && val !== 'false') {
          errors.push(`El campo "${rule.field}" debe ser un booleano (true/false).`);
        }
      }

      // Validar enum
      if (rule.enum && !rule.enum.includes(val)) {
        errors.push(`El campo "${rule.field}" tiene un valor no permitido. Opciones válidas: ${rule.enum.join(', ')}`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Error de validación en los datos enviados.',
        errors,
      });
    }

    next();
  };
}

// Validadores específicos para rutas críticas
export const validateLogin = validateBody([
  { field: 'username', type: 'string', required: true, minLength: 3, maxLength: 50 },
  { field: 'password', type: 'string', required: true, minLength: 4, maxLength: 100 },
]);

export const validateRegister = validateBody([
  { field: 'name', type: 'string', required: true, minLength: 2, maxLength: 100 },
  { field: 'username', type: 'string', required: true, minLength: 3, maxLength: 30, pattern: /^[a-zA-Z0-9._-]+$/ },
  { field: 'email', type: 'email', required: true, maxLength: 100 },
  { field: 'password', type: 'string', required: true, minLength: 4, maxLength: 100 },
]);

export const validateCredentials = validateBody([
  { field: 'cuit', type: 'cuit', required: true },
  { field: 'claveFiscal', type: 'string', required: false, minLength: 4, maxLength: 50 },
  { field: 'puntoVentaDefault', type: 'number', required: false, min: 1, max: 9999 },
  { field: 'razonSocial', type: 'string', required: false, maxLength: 150 },
]);

export const validateCliente = validateBody([
  { field: 'cuit', type: 'string', required: true, minLength: 6, maxLength: 20 },
  { field: 'razonSocial', type: 'string', required: true, minLength: 2, maxLength: 150 },
  { field: 'email', type: 'email', required: false },
  { field: 'condicionIva', type: 'string', required: false, enum: ['Responsable Inscripto', 'Monotributo', 'Consumidor Final', 'Exento'] },
]);

export const validateFactura = validateBody([
  { field: 'puntoVenta', type: 'number', required: true, min: 1, max: 9999 },
  { field: 'tipoComprobante', type: 'string', required: true, enum: ['Factura A', 'Factura B', 'Factura C', 'Recibo C', 'Nota de Débito C', 'Nota de Crédito C'] },
  { field: 'concepto', type: 'number', required: true, enum: [1, 2, 3] },
  { field: 'docNro', type: 'string', required: true, minLength: 6, maxLength: 15 },
  { field: 'items', type: 'array', required: true, minLength: 1 },
]);
