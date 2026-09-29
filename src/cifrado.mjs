// Cifrado del reporte para publicarlo en GitHub Pages (que es público):
// JSON → gzip → AES-256-GCM con llave derivada de la contraseña (PBKDF2-SHA256).
// El navegador lo descifra con WebCrypto; sin la contraseña el archivo no se puede leer.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ITERACIONES = 310000;

// La sal es fija por instalación (pública, no sale de la contraseña) para que la llave derivada
// siga sirviendo entre actualizaciones y nadie tenga que volver a escribir la contraseña cada hora.
// El IV sí es nuevo en cada corrida, como exige AES-GCM.
export function cifrar(objeto, contrasena, salTexto = 'reporte-pauta-v1') {
  if (!contrasena || contrasena.length < 12) throw new Error('REPORT_PASSWORD debe tener al menos 12 caracteres.');
  const sal = crypto.createHash('sha256').update(`sal|${salTexto}`).digest().subarray(0, 16);
  const iv = crypto.randomBytes(12);
  const llave = crypto.pbkdf2Sync(contrasena, sal, ITERACIONES, 32, 'sha256');
  const plano = zlib.gzipSync(Buffer.from(JSON.stringify(objeto), 'utf8'), { level: 9 });
  const c = crypto.createCipheriv('aes-256-gcm', llave, iv);
  const cuerpo = Buffer.concat([c.update(plano), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ITERACIONES, sal: sal.toString('base64'), iv: iv.toString('base64'), datos: cuerpo.toString('base64') };
}

export function descifrar(sobre, contrasena) {
  const llave = crypto.pbkdf2Sync(contrasena, Buffer.from(sobre.sal, 'base64'), sobre.iter, 32, 'sha256');
  const b = Buffer.from(sobre.datos, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', llave, Buffer.from(sobre.iv, 'base64'));
  d.setAuthTag(b.subarray(b.length - 16));
  const plano = Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]);
  return JSON.parse(zlib.gunzipSync(plano).toString('utf8'));
}
