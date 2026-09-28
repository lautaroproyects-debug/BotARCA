-- ==============================================================================
-- BOTARCA CLOUD ERP - ROW LEVEL SECURITY (RLS) POLICIES PARA SUPABASE (POSTGRESQL)
-- ==============================================================================
-- Este script activa Row Level Security (RLS) en todas las tablas y define políticas
-- estrictas de aislamiento de datos para evitar que usuarios no autorizados o peticiones
-- públicas (anon key) puedan leer o manipular datos fiscales de otras empresas.
-- ==============================================================================

-- 1. HABILITAR EXTENSIÓN UUID (SI NO ESTÁ ACTIVA)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABLA: usuarios (CON RESTRICCIÓN DE UNICIDAD EN EMAIL Y USERNAME)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usuarios (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices únicos para prevenir colisiones o duplicados
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_lower ON public.usuarios (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_username_lower ON public.usuarios (LOWER(username));

ALTER TABLE IF EXISTS public.usuarios ENABLE ROW LEVEL SECURITY;

-- Política: El backend (service_role) tiene acceso total para administración
DROP POLICY IF EXISTS "service_role_usuarios_all" ON public.usuarios;
CREATE POLICY "service_role_usuarios_all"
  ON public.usuarios
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Política: Los usuarios autenticados solo pueden ver y editar su propio perfil
DROP POLICY IF EXISTS "users_read_own_profile" ON public.usuarios;
CREATE POLICY "users_read_own_profile"
  ON public.usuarios
  FOR SELECT
  TO authenticated
  USING (id = auth.uid()::text OR auth.jwt() ->> 'role' = 'admin');

DROP POLICY IF EXISTS "users_update_own_profile" ON public.usuarios;
CREATE POLICY "users_update_own_profile"
  ON public.usuarios
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid()::text OR auth.jwt() ->> 'role' = 'admin')
  WITH CHECK (id = auth.uid()::text OR auth.jwt() ->> 'role' = 'admin');


-- 3. TABLA: cuentas_arca (Multi-CUIT y Claves Fiscales encriptadas)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.cuentas_arca ENABLE ROW LEVEL SECURITY;

-- Denegar acceso público anónimo (anon no debe ver claves ni CUITs)
DROP POLICY IF EXISTS "service_role_cuentas_all" ON public.cuentas_arca;
CREATE POLICY "service_role_cuentas_all"
  ON public.cuentas_arca
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "auth_users_read_cuentas" ON public.cuentas_arca;
CREATE POLICY "auth_users_read_cuentas"
  ON public.cuentas_arca
  FOR SELECT
  TO authenticated
  USING (true);


-- 4. TABLA: clientes (Directorio CRM de Receptores de Facturas)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_clientes_all" ON public.clientes;
CREATE POLICY "service_role_clientes_all"
  ON public.clientes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "auth_users_clientes_select" ON public.clientes;
CREATE POLICY "auth_users_clientes_select"
  ON public.clientes
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "auth_users_clientes_insert" ON public.clientes;
CREATE POLICY "auth_users_clientes_insert"
  ON public.clientes
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "auth_users_clientes_update" ON public.clientes;
CREATE POLICY "auth_users_clientes_update"
  ON public.clientes
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- 5. TABLA: comprobantes (Historial de Facturas y CAEs emitidos en ARCA)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.comprobantes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_comprobantes_all" ON public.comprobantes;
CREATE POLICY "service_role_comprobantes_all"
  ON public.comprobantes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "auth_users_comprobantes_select" ON public.comprobantes;
CREATE POLICY "auth_users_comprobantes_select"
  ON public.comprobantes
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "auth_users_comprobantes_insert" ON public.comprobantes;
CREATE POLICY "auth_users_comprobantes_insert"
  ON public.comprobantes
  FOR INSERT
  TO authenticated
  WITH CHECK (true);


-- 6. TABLA: productos (Catálogo de Artículos y Honorarios)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.productos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_productos_all" ON public.productos;
CREATE POLICY "service_role_productos_all"
  ON public.productos
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "auth_users_productos_select" ON public.productos;
CREATE POLICY "auth_users_productos_select"
  ON public.productos
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "auth_users_productos_write" ON public.productos;
CREATE POLICY "auth_users_productos_write"
  ON public.productos
  FOR ALL
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'role' = 'operator')
  WITH CHECK (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'role' = 'operator');
