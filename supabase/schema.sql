-- ==============================================================================
-- BOTARCA - Esquema de Base de Datos para Supabase (PostgreSQL)
-- ==============================================================================

-- 1. Tabla de Usuarios y Roles (RBAC)
CREATE TABLE IF NOT EXISTS usuarios (
  id VARCHAR(100) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'operator', -- 'admin', 'operator', 'viewer'
  active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabla de Cuentas Fiscales ARCA (Multi-Empresa / Multi-CUIT)
CREATE TABLE IF NOT EXISTS cuentas_arca (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cuit VARCHAR(20) UNIQUE NOT NULL,
  razon_social VARCHAR(255),
  encrypted_clave_fiscal TEXT NOT NULL,
  punto_venta_default INT DEFAULT 1,
  activa BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabla de Cola de Facturación Masiva (Batch Invoicing Queue)
CREATE TABLE IF NOT EXISTS cola_facturacion (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cuit_emisor VARCHAR(20),
  punto_venta INT DEFAULT 1,
  tipo_comprobante VARCHAR(50) DEFAULT 'Factura C',
  concepto INT DEFAULT 2, -- 1: Productos, 2: Servicios, 3: Ambos
  doc_tipo VARCHAR(20) DEFAULT 'CUIT',
  doc_nro VARCHAR(20) NOT NULL,
  razon_social VARCHAR(255) NOT NULL,
  condicion_iva VARCHAR(50) DEFAULT 'Consumidor Final',
  condicion_venta VARCHAR(50) DEFAULT 'Contado',
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(10,2) DEFAULT 1,
  precio_unitario NUMERIC(15,2) NOT NULL,
  importe_total NUMERIC(15,2) NOT NULL,
  email VARCHAR(255),
  estado VARCHAR(30) DEFAULT 'pendiente', -- 'pendiente', 'procesando', 'emitida', 'error'
  cae VARCHAR(30),
  cae_vencimiento DATE,
  comprobante_nro VARCHAR(30),
  error_mensaje TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  procesada_at TIMESTAMPTZ
);

-- 4. Tabla de Clientes (CRM Ligero)
CREATE TABLE IF NOT EXISTS clientes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cuit VARCHAR(20) UNIQUE NOT NULL,
  tipo_doc VARCHAR(20) DEFAULT 'CUIT',
  razon_social VARCHAR(255) NOT NULL,
  condicion_iva VARCHAR(50) DEFAULT 'Consumidor Final',
  domicilio TEXT,
  email VARCHAR(255),
  telefono VARCHAR(50),
  saldo_cuenta NUMERIC(15,2) DEFAULT 0.00,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Tabla de Comprobantes Emitidos y Recibidos
CREATE TABLE IF NOT EXISTS comprobantes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo_operacion VARCHAR(20) NOT NULL DEFAULT 'Emitido', -- 'Emitido' o 'Recibido'
  tipo_comprobante VARCHAR(50) NOT NULL, -- 'Factura C', 'Factura B', 'Factura A', etc.
  punto_venta INT NOT NULL,
  numero INT NOT NULL,
  comprobante_formato VARCHAR(30), -- '0001-00001024'
  fecha_emision DATE NOT NULL,
  fecha_vencimiento_pago DATE,
  cuit_emisor VARCHAR(20),
  razon_social_emisor VARCHAR(255),
  cuit_receptor VARCHAR(20),
  razon_social_receptor VARCHAR(255),
  condicion_iva_receptor VARCHAR(50),
  concepto INT DEFAULT 2,
  moneda VARCHAR(10) DEFAULT 'ARS',
  tipo_cambio NUMERIC(10,2) DEFAULT 1.00,
  importe_neto NUMERIC(15,2) DEFAULT 0.00,
  importe_iva NUMERIC(15,2) DEFAULT 0.00,
  importe_total NUMERIC(15,2) NOT NULL,
  cae VARCHAR(30),
  cae_vencimiento DATE,
  estado VARCHAR(30) DEFAULT 'Autorizado',
  items_json JSONB,
  pdf_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tabla de Configuraciones y Parámetros del Sistema
CREATE TABLE IF NOT EXISTS configuraciones (
  id VARCHAR(50) PRIMARY KEY,
  valor JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices de búsqueda y optimización
CREATE INDEX IF NOT EXISTS idx_cola_estado ON cola_facturacion(estado);
CREATE INDEX IF NOT EXISTS idx_clientes_cuit ON clientes(cuit);
CREATE INDEX IF NOT EXISTS idx_clientes_razon_social ON clientes(razon_social);
CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha ON comprobantes(fecha_emision);
CREATE INDEX IF NOT EXISTS idx_comprobantes_cae ON comprobantes(cae);
CREATE INDEX IF NOT EXISTS idx_comprobantes_receptor ON comprobantes(cuit_receptor);
CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username);
