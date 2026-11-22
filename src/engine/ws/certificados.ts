import forge from 'node-forge';
import crypto from 'crypto';

/**
 * Utilidades de certificados para WSAA.
 * ARCA identifica al dueño del certificado por el campo serialNumber del subject: "CUIT 20123456789".
 */

export interface InfoCertificado {
  cuit: string;
  alias: string;
  organizacion: string;
  validoDesde: string;
  validoHasta: string;
  vencido: boolean;
  huella: string; // SHA-256 del certificado (identifica el ticket de acceso en caché)
  emisor: string; // AC que lo firmó (homologación o producción)
}

/**
 * Acepta un PEM normal, un PEM con "\n" escapados (como suele quedar en variables de entorno)
 * o el PEM entero codificado en base64 en una sola línea.
 */
export function normalizarPem(entrada: string | undefined | null): string {
  let texto = String(entrada || '').trim();
  if (!texto) return '';
  if (!texto.includes('-----BEGIN')) {
    try {
      const decodificado = Buffer.from(texto, 'base64').toString('utf8');
      if (decodificado.includes('-----BEGIN')) texto = decodificado.trim();
    } catch { /* no era base64 */ }
  }
  texto = texto.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  return texto.endsWith('\n') ? texto : texto + '\n';
}

function campo(attrs: forge.pki.CertificateField[], nombre: string): string {
  const a = attrs.find(x => x.name === nombre || x.shortName === nombre);
  return a ? String(a.value) : '';
}

export function leerCertificado(certPem: string): InfoCertificado {
  const pem = normalizarPem(certPem);
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(pem);
  } catch {
    throw new Error('El certificado no es un PEM válido (debe empezar con -----BEGIN CERTIFICATE-----).');
  }
  const serial = campo(cert.subject.attributes, 'serialNumber');
  const cuit = (serial.match(/(\d{11})/) || [])[1] || '';
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    cuit,
    alias: campo(cert.subject.attributes, 'CN'),
    organizacion: campo(cert.subject.attributes, 'O'),
    validoDesde: cert.validity.notBefore.toISOString(),
    validoHasta: cert.validity.notAfter.toISOString(),
    vencido: cert.validity.notAfter.getTime() < Date.now(),
    huella: crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex'),
    emisor: campo(cert.issuer.attributes, 'CN') || campo(cert.issuer.attributes, 'O'),
  };
}

/** Verifica que la clave privada corresponda al certificado (mismo módulo RSA). */
export function verificarParClave(certPem: string, keyPem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(normalizarPem(certPem));
    const key = forge.pki.privateKeyFromPem(normalizarPem(keyPem)) as forge.pki.rsa.PrivateKey;
    const pub = cert.publicKey as forge.pki.rsa.PublicKey;
    return pub.n.equals(key.n) && pub.e.equals(key.e);
  } catch {
    return false;
  }
}

/** Genera una clave privada RSA 2048 y el pedido de certificado (CSR) en el formato que pide ARCA. */
export function generarCsr(params: { cuit: string; organizacion: string; alias: string }): { keyPem: string; csrPem: string } {
  const cuit = params.cuit.replace(/\D/g, '');
  if (cuit.length !== 11) throw new Error('El CUIT debe tener 11 dígitos.');
  const alias = params.alias.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || 'botarca';
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { shortName: 'C', value: 'AR' },
    { shortName: 'O', value: params.organizacion.slice(0, 60) || alias },
    { shortName: 'CN', value: alias },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr),
  };
}

/** Firma el TRA en formato CMS (PKCS#7 SignedData con el contenido adentro), como pide WSAA. */
export function firmarCms(contenido: string, certPem: string, keyPem: string): string {
  const cert = forge.pki.certificateFromPem(normalizarPem(certPem));
  const key = forge.pki.privateKeyFromPem(normalizarPem(keyPem));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(contenido, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: key as any,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as any },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}
