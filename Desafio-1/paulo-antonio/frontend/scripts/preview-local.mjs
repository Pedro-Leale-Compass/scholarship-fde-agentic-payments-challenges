import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone preview only: never imported by the application or the deploy.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../out');
await stat(resolve(root, 'index.html')).catch(() => {
  throw new Error('Compile a interface primeiro: pnpm run build');
});
const connected = process.argv.includes('--aws');
const config = connected ? JSON.parse(await readFile(resolve(root, '../../.deploy/config.json'), 'utf8')) : {
  region: 'us-east-1', userPoolId: 'us-east-1_LocalPreview',
  userPoolClientId: 'localpreviewclient', apiUrl: 'https://preview.invalid/v1/',
};
if (connected && (!/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com\/v1\/$/.test(config.apiUrl)
  || config.region !== 'us-east-1' || !config.userPoolId?.startsWith('us-east-1_') || !config.userPoolClientId)) {
  throw new Error('Configuração AWS inválida. Execute o deploy do backend primeiro.');
}
const shell = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste local — Agente de pagamentos</title>
<style>body{margin:0;font:16px Arial;background:#f4f7fb;color:#17243b;display:flex;flex-direction:column;height:100dvh}aside{padding:16px 20px;background:#fff3cd;border-bottom:1px solid #d6b55b}p{margin:8px 0;line-height:1.4}iframe{flex:1;width:100%;border:0;min-height:0}a{color:#1745a0}</style>
<aside><strong>${connected ? 'Interface local · login real via Cognito' : 'Prévia local · sem conexão com a AWS'}</strong>
<p>${connected ? 'Use seu usuário convidado. Login e compras simuladas usam a API na AWS. Nenhum pagamento real é realizado.' : 'Teste o visual e os campos com dados fictícios. Entrar e recuperar senha não funcionam nesta prévia. Nenhuma compra é realizada.'}</p>
<a href="/" onclick="document.querySelector('iframe').src='/app/';return false">Reiniciar tela</a>
 · <a href="/" onclick="document.querySelector('iframe').src='/app/?missing=1';return false">Testar configuração ausente</a></aside>
<iframe title="Interface do agente de pagamentos" src="/app/"></iframe></html>`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Offline mode blocks external calls; connected mode only permits this API and Cognito.
  const connections = connected ? ` https://cognito-idp.us-east-1.amazonaws.com ${new URL(config.apiUrl).origin}` : '';
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'${connections}; img-src 'self' data:; font-src 'self'; frame-src 'self'; form-action 'none'; object-src 'none'; base-uri 'none'`);
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4173');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (url.pathname === '/') { res.setHeader('Content-Type', types['.html']); res.end(shell); return; }
    if (url.pathname === '/config.json') {
      if (new URL(req.headers.referer || 'http://localhost').searchParams.has('missing')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types['.json']); res.end(JSON.stringify(config)); return;
    }
    const pathname = url.pathname === '/app/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end('Arquivo não encontrado'); }
}).listen(4173, '127.0.0.1', () => console.log('Prévia local: http://127.0.0.1:4173 — Ctrl+C para parar.'));
