-- =====================================================================
-- BotArca · Seguridad de la base de datos (Row Level Security)
-- =====================================================================
-- Cómo funciona el acceso en BotArca:
--   * El navegador NUNCA habla con Supabase. Solo el servidor de BotArca (Render) lo hace,
--     con la clave secreta (SUPABASE_KEY = sb_secret_… / service_role), que no está sujeta a RLS.
--   * Qué ve cada usuario (sus CUITs, comprobantes, cola y clientes) lo controla el servidor.
--
-- Por eso la regla correcta en Supabase es: RLS activado en TODAS las tablas y NINGUNA
-- política para los roles públicos (anon, authenticated). Así, aunque alguien consiga la
-- clave pública (publishable/anon) del proyecto, no puede leer ni escribir nada.
--
-- Reemplaza al archivo viejo supabase_rls_policies.sql, que daba lectura/escritura a
-- cualquier usuario autenticado en Supabase (incluida la tabla con Claves Fiscales cifradas).
--
-- Se puede correr más de una vez sin problema.
-- =====================================================================

-- 1. Activar RLS (y forzarlo también para el dueño de la tabla) en todas las tablas
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios','cuentas_arca','cola_facturacion','clientes','comprobantes','configuraciones','productos']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- 2. Borrar TODAS las políticas existentes en esas tablas (incluidas las del archivo viejo)
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('usuarios','cuentas_arca','cola_facturacion','clientes','comprobantes','configuraciones','productos')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

-- 3. Quitar permisos directos a los roles públicos (doble seguro, además de RLS)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios','cuentas_arca','cola_facturacion','clientes','comprobantes','configuraciones','productos']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;

-- 4. El bucket de archivos (PDF, adjuntos) pasa a privado: los PDF se sirven desde BotArca
UPDATE storage.buckets SET public = false WHERE id = 'facturas-adjuntos';

-- Verificación: debe listar las tablas con rls_activo = true y politicas = 0
SELECT c.relname AS tabla,
       c.relrowsecurity AS rls_activo,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS politicas
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('usuarios','cuentas_arca','cola_facturacion','clientes','comprobantes','configuraciones','productos')
ORDER BY 1;
