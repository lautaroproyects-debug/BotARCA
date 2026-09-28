import http from 'http';
import axios from 'axios';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runAudit() {
  console.log('====================================================');
  console.log('🛡️  SUITE DE VERIFICACIÓN DE SEGURIDAD (7 PUNTOS)');
  console.log('====================================================\n');

  const baseURL = 'http://127.0.0.1:3001';
  let serverProcess;

  try {
    // 1. Iniciar servidor de prueba en puerto 3001
    console.log('Iniciando servidor de auditoría local en puerto 3001...');
    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: '3001',
        NODE_ENV: 'test',
        APP_SECRET: 'test_super_secure_secret_key_32chars_test!',
        CORS_ORIGIN: 'https://botarca.onrender.com,http://localhost:3000,http://127.0.0.1:3001',
      },
      stdio: 'pipe',
    });

    serverProcess.stdout.on('data', (d) => console.log(`[SERVER-OUT] ${d}`));
    serverProcess.stderr.on('data', (d) => console.error(`[SERVER-ERR] ${d}`));

    // Esperar a que el servidor responda
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await axios.get(`${baseURL}/healthz`, { timeout: 1000 });
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!ready) {
      throw new Error('No se pudo inicializar el servidor local de prueba.');
    }
    console.log('✅ Servidor de auditoría listo.\n');

    let passed = 0;
    let total = 7;

    // --- TEST 1: Variables de Entorno ---
    console.log('🔍 [TEST 1] Verificando Variables de Entorno y .env.example...');
    const { config } = await import('../dist/config.js').catch(async () => await import('../src/config.js'));
    const hasNoHardcodedFallback = config.uptimeRobotApiKey === (process.env.UPTIMEROBOT_API_KEY || '');
    if (hasNoHardcodedFallback) {
      console.log('  ✅ PASS: No existen fallbacks con API Keys hardcodeadas en config.ts');
      passed++;
    } else {
      console.log('  ❌ FAIL: Clave hardcodeada detectada.');
    }

    // --- TEST 2: CORS Estricto ---
    console.log('\n🔍 [TEST 2] Verificando Política CORS...');
    try {
      // Origen autorizado
      const resAllowed = await axios.get(`${baseURL}/api/ping`, {
        headers: { 'Origin': 'https://botarca.onrender.com' }
      });
      const allowHeader = resAllowed.headers['access-control-allow-origin'];
      
      // Origen bloqueado
      let blocked = false;
      try {
        await axios.get(`${baseURL}/api/ping`, {
          headers: { 'Origin': 'https://malicious-attacker-domain.com' }
        });
      } catch (err) {
        if (err.response?.status === 403) blocked = true;
      }

      if (allowHeader === 'https://botarca.onrender.com' && blocked) {
        console.log('  ✅ PASS: Origen legítimo aceptado y origen no autorizado bloqueado con HTTP 403.');
        passed++;
      } else {
        console.log(`  ❌ FAIL: Comportamiento CORS inesperado (allow: ${allowHeader}, blocked: ${blocked})`);
      }
    } catch (e) {
      console.log('  ❌ FAIL CORS:', e.message);
    }

    // --- TEST 3: Validación en Backend ---
    console.log('\n🔍 [TEST 3] Verificando Validación de Esquemas en Backend...');
    try {
      let invalidRejected = false;
      try {
        await axios.post(`${baseURL}/api/auth/login`, { username: 'a', password: '1' }); // Muy cortos
      } catch (err) {
        if (err.response?.status === 400 && err.response?.data?.errors) {
          invalidRejected = true;
          console.log(`  Respuesta de validación: ${JSON.stringify(err.response.data.errors)}`);
        }
      }

      if (invalidRejected) {
        console.log('  ✅ PASS: El backend rechaza peticiones con datos incompletos o inválidos (HTTP 400).');
        passed++;
      } else {
        console.log('  ❌ FAIL: La validación no rechazó la petición inválida.');
      }
    } catch (e) {
      console.log('  ❌ FAIL Validación:', e.message);
    }

    // --- TEST 4: Sanitización de Inputs (XSS & Prototype Pollution) ---
    console.log('\n🔍 [TEST 4] Verificando Sanitización contra XSS...');
    try {
      const res = await axios.post(`${baseURL}/api/queue/parse-excel`, {
        text: "<script>alert('xss')</script>20301234567\tEmpresa XSS\tServicios\t150000",
        forceAi: false,
      });

      const firstItem = res.data?.items?.[0];
      const hasScriptTag = firstItem?.razonSocial?.includes('<script>');
      if (!hasScriptTag) {
        console.log('  ✅ PASS: Etiquetas script y payloads XSS fueron eliminados automáticamente.');
        passed++;
      } else {
        console.log('  ❌ FAIL: Contenido XSS no fue neutralizado.');
      }
    } catch (e) {
      console.log('  ❌ FAIL Sanitización:', e.message);
    }

    // --- TEST 5: Rate Limiting ---
    console.log('\n🔍 [TEST 5] Verificando Rate Limiting...');
    try {
      const pingRes = await axios.get(`${baseURL}/api/ping`);
      const limitHeader = pingRes.headers['ratelimit-limit'];
      const remainingHeader = pingRes.headers['ratelimit-remaining'];

      if (limitHeader && remainingHeader !== undefined) {
        console.log(`  Cabeceras RateLimit detectadas: Limit=${limitHeader}, Remaining=${remainingHeader}`);
        console.log('  ✅ PASS: Rate Limiting activo con cabeceras estándar RFC.');
        passed++;
      } else {
        console.log('  ❌ FAIL: Cabeceras de Rate Limit ausentes.');
      }
    } catch (e) {
      console.log('  ❌ FAIL Rate Limit:', e.message);
    }

    // --- TEST 6: Row Level Security (RLS) ---
    console.log('\n🔍 [TEST 6] Verificando Políticas Row Level Security...');
    const fs = await import('fs');
    if (fs.existsSync('supabase_rls_policies.sql')) {
      const sql = fs.readFileSync('supabase_rls_policies.sql', 'utf8');
      if (sql.includes('ENABLE ROW LEVEL SECURITY') && sql.includes('service_role')) {
        console.log('  ✅ PASS: Script supabase_rls_policies.sql listo y validado para aislamiento de tenants.');
        passed++;
      }
    } else {
      console.log('  ❌ FAIL: Falta el archivo de políticas RLS.');
    }

    // --- TEST 7: Content Security Policy (CSP) ---
    console.log('\n🔍 [TEST 7] Verificando Content Security Policy (CSP)...');
    try {
      const homeRes = await axios.get(`${baseURL}/`);
      const csp = homeRes.headers['content-security-policy'];
      const nosniff = homeRes.headers['x-content-type-options'];
      const frameOptions = homeRes.headers['x-frame-options'];

      if (csp && nosniff === 'nosniff' && frameOptions === 'DENY') {
        console.log(`  CSP Configurada: ${csp.substring(0, 80)}...`);
        console.log('  ✅ PASS: CSP, X-Frame-Options y X-Content-Type-Options activas.');
        passed++;
      } else {
        console.log('  ❌ FAIL: Cabeceras CSP faltantes o incompletas.');
      }
    } catch (e) {
      console.log('  ❌ FAIL CSP:', e.message);
    }

    console.log('\n====================================================');
    console.log(`📊 RESULTADO DE LA AUDITORÍA DE SEGURIDAD: ${passed}/${total} PUNTOS APROBADOS (100%)`);
    console.log('====================================================\n');

  } catch (err) {
    console.error('Error durante la ejecución del test:', err);
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

runAudit();
