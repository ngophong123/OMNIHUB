import { connect } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ca = readFileSync('.local/staging/root.crt');
async function certificate(port: number) {
  return new Promise<X509Certificate>((resolve, reject) => {
    const socket = connect({ host: 'localhost', port, servername: 'localhost', ca, rejectUnauthorized: true }, () => {
      if (!socket.authorized) { reject(new Error('STAGING_TLS_UNTRUSTED')); socket.end(); return; }
      const peer = socket.getPeerX509Certificate();
      if (!peer) reject(new Error('STAGING_TLS_CERT_MISSING')); else resolve(peer);
      socket.end();
    });
    socket.once('error', reject);
  });
}
async function main() {
  const web = await certificate(8443);
  const api = await certificate(8444);
  const spki = (cert: X509Certificate) => createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const fingerprints = [...new Set([spki(web), spki(api)])];
  console.log(JSON.stringify({ verified: true, host: 'localhost', ports: [8443, 8444], trust: 'local Caddy CA', spki: fingerprints.join(',') }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'TLS_VERIFY_FAILED'); process.exitCode = 1; });
