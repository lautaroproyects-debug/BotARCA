-- ==============================================================================
-- BOTARCA - Esquema de Base de Datos para Supabase (PostgreSQL)
-- ==============================================================================

-- 1. Tabla de Clientes (CRM)
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

-- 2. Tabla de Catálogo de Productos y Servicios
CREATE TABLE IF NOT EXISTS productos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo VARCHAR(50) UNIQUE NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  descripcion TEXT,
  categoria VARCHAR(100) DEFAULT 'General',
  unidad_medida VARCHAR(20) DEFAULT 'unidades',
  precio_ars NUMERIC(15,2) DEFAULT 0.00,
  precio_usd NUMERIC(15,2) DEFAULT 0.00,
  auto_ajuste_dolar BOOLEAN DEFAULT TRUE,
  alicuota_iva NUMERIC(5,2) DEFAULT 21.00,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabla de Comprobantes Emitidos y Recibidos
CREATE TABLE IF NOT EXISTS comprobantes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo_operacion VARCHAR(20) NOT NULL, -- 'Emitido' o 'Recibido'
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
  concepto INT DEFAULT 2, -- 1: Productos, 2: Servicios, 3: Ambos
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

-- 4. Tabla de Cuentas Corrientes y Cobranzas
CREATE TABLE IF NOT EXISTS cobranzas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
  comprobante_id UUID REFERENCES comprobantes(id) ON DELETE SET NULL,
  fecha DATE DEFAULT CURRENT_DATE,
  monto NUMERIC(15,2) NOT NULL,
  metodo_pago VARCHAR(50) DEFAULT 'Transferencia',
  referencia_pago VARCHAR(100),
  observaciones TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Tabla de Configuraciones y Parámetros del Sistema
CREATE TABLE IF NOT EXISTS configuraciones (
  id VARCHAR(50) PRIMARY KEY,
  valor JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tabla de Usuarios y Roles (RBAC)
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

-- Índices de búsqueda y optimización
CREATE INDEX IF NOT EXISTS idx_clientes_cuit ON clientes(cuit);
CREATE INDEX IF NOT EXISTS idx_clientes_razon_social ON clientes(razon_social);
CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha ON comprobantes(fecha_emision);
CREATE INDEX IF NOT EXISTS idx_comprobantes_cae ON comprobantes(cae);
CREATE INDEX IF NOT EXISTS idx_comprobantes_receptor ON comprobantes(cuit_receptor);
CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos(codigo);
CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username);
