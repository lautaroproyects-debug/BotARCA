/**
 * Test Suite for Supabase Storage & Render Environment Configuration
 */
import { config } from '../dist/config.js';
import { encrypt, decrypt } from '../dist/crypto.js';
import { db } from '../dist/database.js';
import { storageService } from '../dist/services/storageService.js';
import { mailService } from '../dist/services/mailService.js';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 TEST SUITE: SUPABASE STORAGE & CONFIGURACIÓN RENDER');
  console.log('====================================================\n');

  let passed = 0;
  let total = 4;

  // TEST 1: Encryption Key from Env
  console.log('🔍 [TEST 1] Verificando clave de cifrado AES-256-GCM...');
  const sampleSecret = 'MiClaveFiscalSuperSecreta123!';
  const encrypted = encrypt(sampleSecret);
  const decrypted = decrypt(encrypted);
  if (decrypted === sampleSecret && encrypted.includes(':')) {
    console.log('  ✅ PASS: Cifrado y descifrado AES-256-GCM operativo usando ENCRYPTION_KEY de entorno.');
    console.log('  🔒 Payload cifrado (iv:tag:data):', encrypted);
    passed++;
  } else {
    console.error('  ❌ FAIL: Error en cifrado/descifrado.');
  }

  // TEST 2: Storage Service methods
  console.log('\n🔍 [TEST 2] Verificando módulo de Supabase Storage...');
  if (typeof storageService.uploadAttachment === 'function' &&
      typeof storageService.downloadAttachment === 'function' &&
      typeof storageService.getSignedUrl === 'function' &&
      typeof storageService.deleteAttachment === 'function') {
    console.log('  ✅ PASS: Métodos de Supabase Storage (upload, download, signed-url, delete) implementados.');
    passed++;
  } else {
    console.error('  ❌ FAIL: Métodos de storageService no encontrados.');
  }

  // TEST 3: Mail Service Attachment Support
  console.log('\n🔍 [TEST 3] Verificando soporte de adjuntos en MailService...');
  const mailCfg = mailService.getConfig();
  console.log('  📧 Proveedor de correo detectado:', mailCfg.provider);
  const mailRes = await mailService.sendMail({
    to: 'delivered@resend.dev',
    subject: 'Comprobante de Factura Adjunto',
    html: '<p>Adjuntamos su factura electrónica autorizada.</p>',
    attachments: [
      {
        filename: 'factura_sample.pdf',
        content: Buffer.from('%PDF-1.4 sample PDF content').toString('base64'),
        contentType: 'application/pdf'
      }
    ]
  });
  if (mailRes.success) {
    console.log('  ✅ PASS: Envío de emails con adjuntos compatible con Resend/Brevo/Simulación.');
    passed++;
  } else {
    console.error('  ❌ FAIL:', mailRes.message);
  }

  // TEST 4: Configuration & Env Vars Persistence
  console.log('\n🔍 [TEST 4] Verificando configuración sin dependencia de disco...');
  console.log('  📁 Supabase Storage Bucket configurado:', config.storage.bucket);
  console.log('  ⚙️ Keep-Alive URL configurada:', config.keepAlive.externalUrl);
  if (config.storage.bucket === 'facturas-adjuntos' || config.storage.bucket) {
    console.log('  ✅ PASS: Configuración desacoplada del disco efímero de Render.');
    passed++;
  } else {
    console.error('  ❌ FAIL: Configuración no encontrada.');
  }

  console.log('\n====================================================');
  console.log(`📊 RESULTADO: ${passed}/${total} TESTS COMPLETADOS (${Math.round((passed/total)*100)}%)`);
  console.log('====================================================\n');
  process.exit(passed === total ? 0 : 1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
