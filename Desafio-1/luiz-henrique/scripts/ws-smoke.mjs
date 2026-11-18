import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

const outputs = JSON.parse(
  readFileSync(new URL('../infra/cdk-outputs.json', import.meta.url), 'utf8'),
).Desafio1Stack;

const wsUrl = outputs.WebSocketUrl;
const clientId = outputs.CognitoUserPoolClientId;
const region = process.env.AWS_REGION || 'us-east-1';
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;

if (!wsUrl) throw new Error('WebSocketUrl ausente em infra/cdk-outputs.json; rode o deploy.');
if (!email || !password) {
  throw new Error('TEST_EMAIL/TEST_PASSWORD ausentes; rode npm run dev:create-test-user.');
}

const auth = JSON.parse(
  execFileSync(
    'aws',
    [
      'cognito-idp',
      'initiate-auth',
      '--auth-flow',
      'USER_PASSWORD_AUTH',
      '--client-id',
      clientId,
      '--auth-parameters',
      `USERNAME=${email},PASSWORD=${password}`,
      '--region',
      region,
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  ),
);
const token = auth.AuthenticationResult?.IdToken;
if (!token) throw new Error('login não retornou IdToken');

const conversaId = randomUUID();
const url = `${wsUrl}?token=${encodeURIComponent(token)}&conversa_id=${conversaId}`;
console.log('Conectando em', wsUrl, 'conversa', conversaId);

const ws = new WebSocket(url);
let opened = false;
let sent = false;
const timeout = setTimeout(() => {
  console.error('timeout aguardando resposta do WebSocket');
  ws.close();
  process.exit(1);
}, 90000);

function sendChat() {
  if (sent) return;
  sent = true;
  ws.send(
    JSON.stringify({
      messages: [{ role: 'user', content: [{ text: 'catalogo' }] }],
    }),
  );
}

ws.onopen = () => {
  opened = true;
  console.log('WebSocket aberto; enviando catálogo...');
  setTimeout(sendChat, 250);
};

ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  console.log('WS <-', JSON.stringify(message));

  if (message.type === 'connected') {
    sendChat();
    return;
  }

  if (message.type === 'chat') {
    clearTimeout(timeout);
    console.log('OK: reply =', message.reply);
    ws.close();
    process.exit(0);
  }

  if (message.type === 'error') {
    clearTimeout(timeout);
    console.error('ERRO:', message.message);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = (event) => {
  clearTimeout(timeout);
  console.error('erro WebSocket:', event.message || event);
  process.exit(1);
};

ws.onclose = () => {
  if (!opened) {
    clearTimeout(timeout);
    console.error('conexão fechada antes do handshake');
    process.exit(1);
  }
};
