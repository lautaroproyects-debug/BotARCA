import axios from 'axios';

const BASE_URL = 'https://botarca.onrender.com';

async function runFullAudit() {
  console.log('====================================================');
  console.log('🔍 INICIANDO AUDITORÍA Y TEST DE INTEGRACIÓN 100% EN VIVO');
  console.log(`🌐 Servidor Producción: ${BASE_URL}`);
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, testName, details = '') {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`✅ [TEST ${totalTests}] PASS: ${testName} ${details ? `(${details})` : ''}`);
      return true;
    } else {
      console.error(`❌ [TEST ${totalTests}] FAIL: ${testName} ${details ? `(${details})` : ''}`);
      return false;
    }
  }

  // --- 1. HEALTH CHECK & PING ---
  try {
    const pingRes = await axios.get(`${BASE_URL}/api/ping`, { timeout: 10000 });
    assert(pingRes.data?.status === 'pong' && pingRes.data?.service === 'BotArca', '1. Ping & Keep-Alive Endpoint');
  } catch (e) {
    assert(false, '1. Ping & Keep-Alive Endpoint', e.message);
  }

  // --- 2. ADMIN LOGIN ---
  let adminToken = '';
  try {
    const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, {
      username: 'admin',
      password: process.env.ADMIN_INITIAL_PASSWORD || 'admin123'
    });
    adminToken = loginRes.data?.token || '';
    assert(loginRes.data?.success && !!adminToken, '2. Login de Super Administrador', `Usuario: @${loginRes.data?.user?.username}`);
  } catch (e) {
    assert(false, '2. Login de Super Administrador', e.response?.data?.message || e.message);
  }

  // --- 3. PUBLIC SELF-REGISTRATION ---
  const testUser = `test_op_${Date.now()}`;
  const testEmail = `${testUser}@gmail.com`;
  let registeredToken = '';
  try {
    const regRes = await axios.post(`${BASE_URL}/api/auth/register`, {
      name: 'Operador Test Automatizado',
      username: testUser,
      email: testEmail,
      password: 'passwordSegura123'
    });
    registeredToken = regRes.data?.token || '';
    assert(regRes.data?.success && !!registeredToken, '3. Auto-Registro de Usuario con Notificación', `User: @${testUser}`);
  } catch (e) {
    assert(false, '3. Auto-Registro de Usuario con Notificación', e.response?.data?.message || e.message);
  }

  // --- 4. VERIFY USER PROFILE (JWT) ---
  try {
    const meRes = await axios.get(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${registeredToken}` }
    });
    assert(meRes.data?.success && meRes.data?.user?.username === testUser, '4. Verificación de Perfil JWT y Permisos', `Rol: ${meRes.data?.user?.role}`);
  } catch (e) {
    assert(false, '4. Verificación de Perfil JWT y Permisos', e.message);
  }

  // --- 5. GROQ AI SMART PARSER (WHATSAPP CHATS) ---
  const sampleWhatsApp = `[28/9, 14:30] Cliente: Hola! Facturarle a Tech Solutions SRL CUIT 30-71234567-8 por $185.000 por desarrollo web y APIs.
[28/9, 15:10] Contador: Emitile Factura C a Gómez Distribuidora CUIT 27-33889900-4 monto 75.000 pesos de honorarios mensuales.`;

  try {
    const parseAiRes = await axios.post(`${BASE_URL}/api/queue/parse-smart`, {
      text: sampleWhatsApp,
      forceAi: true
    }, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 20000
    });

    const items = parseAiRes.data?.items || [];
    const validCuit1 = items.some(x => x.docNro.includes('30712345678') && (x.importeTotal === 185000 || x.precioUnitario === 185000));
    const validCuit2 = items.some(x => x.docNro.includes('27338899004') && (x.importeTotal === 75000 || x.precioUnitario === 75000));

    assert(parseAiRes.data?.success && items.length === 2 && validCuit1 && validCuit2, 
      '5. Extracción de WhatsApp con Groq IA / NLP', 
      `Parser: ${parseAiRes.data?.parserUsed}, Items: ${items.length}`
    );
  } catch (e) {
    assert(false, '5. Extracción de WhatsApp con Groq IA / NLP', e.response?.data?.message || e.message);
  }

  // --- 6. EXCEL / TSV TABULAR PARSER ---
  const sampleExcel = `30712345678\tEmpresa Alpha SRL\tServicios de Desarrollo Cloud\t250000
20309998887\tMartín Rodríguez\tHonorarios Profesionales IT\t120000`;

  try {
    const parseExcelRes = await axios.post(`${BASE_URL}/api/queue/parse-excel`, {
      text: sampleExcel
    }, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const items = parseExcelRes.data?.items || [];
    assert(parseExcelRes.data?.success && items.length === 2 && items[0].docNro === '30712345678',
      '6. Parseo de Planilla Excel / CSV',
      `Filas detectadas: ${items.length}`
    );
  } catch (e) {
    assert(false, '6. Parseo de Planilla Excel / CSV', e.message);
  }

  // --- 7. QUEUE INVOICE BATCH & STATUS ---
  try {
    const addQueueRes = await axios.post(`${BASE_URL}/api/queue/add`, {
      items: [
        {
          puntoVenta: 1,
          tipoComprobante: 'Factura C',
          concepto: 2,
          docTipo: 'CUIT',
          docNro: '30712345678',
          razonSocial: 'Empresa Test SA',
          condicionIva: 'Responsable Inscripto',
          condicionVenta: 'Contado',
          descripcion: 'Honorarios test auditoria',
          cantidad: 1,
          precioUnitario: 50000,
          importeTotal: 50000
        }
      ]
    }, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const queueListRes = await axios.get(`${BASE_URL}/api/queue`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert(addQueueRes.data?.success && queueListRes.data?.total >= 1, 
      '7. Encolado de Comprobantes y Monitoreo de Lote',
      `Encolados: ${addQueueRes.data?.count}, Total en Cola: ${queueListRes.data?.total}`
    );
  } catch (e) {
    assert(false, '7. Encolado de Comprobantes y Monitoreo de Lote', e.message);
  }

  // --- 8. ARGENTINADATOS FINANCIAL QUOTES ---
  try {
    const finRes = await axios.get(`${BASE_URL}/api/finanzas/resumen`);
    const d = finRes.data?.dolares;
    const hasDolarBlue = d?.blue?.venta > 0;
    const hasDolarOficial = d?.oficial?.venta > 0;

    assert(finRes.data?.success && hasDolarBlue && hasDolarOficial, 
      '8. Ticker Financiero en Vivo (ArgentinaDatos API)',
      `Dólar Blue: $${d?.blue?.venta}, Oficial: $${d?.oficial?.venta}`
    );
  } catch (e) {
    assert(false, '8. Ticker Financiero en Vivo (ArgentinaDatos API)', e.message);
  }

  // --- 9. MULTI-CUIT & ARCA ACCOUNTS ---
  try {
    const accRes = await axios.get(`${BASE_URL}/api/accounts`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(accRes.data?.success && Array.isArray(accRes.data?.accounts), 
      '9. Gestión Multi-Empresa / Cuentas Fiscales ARCA',
      `Cuentas registradas: ${accRes.data?.accounts?.length}`
    );
  } catch (e) {
    assert(false, '9. Gestión Multi-Empresa / Cuentas Fiscales ARCA', e.message);
  }

  // --- 10. MAIL & GROQ SETTINGS CHECK ---
  try {
    const settingsRes = await axios.get(`${BASE_URL}/api/settings/mail`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(settingsRes.data?.success && !!settingsRes.data?.mail, 
      '10. Panel de Configuración Cloud (Email & Groq IA)',
      `Proveedor: ${settingsRes.data?.mail?.provider}, Groq vinculada: ${settingsRes.data?.mail?.hasGroqKey}`
    );
  } catch (e) {
    assert(false, '10. Panel de Configuración Cloud (Email & Groq IA)', e.message);
  }

  console.log('\n====================================================');
  console.log(`📊 RESULTADO AUDITORÍA: ${passedTests}/${totalTests} TESTS COMPLETADOS CON ÉXITO (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log('====================================================');
}

runFullAudit().catch(console.error);
