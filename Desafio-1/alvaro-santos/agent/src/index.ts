import { createServer } from './server.js';

const rawPort = process.env.PORT ?? '8080';
const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Porta inválida configurada em PORT: "${rawPort}".`);
}

const host = '0.0.0.0';
const app = createServer();

const server = app.listen(port, host, () => {
  console.info(`AgentCore Strands HTTP runtime ativo em http://${host}:${port}`);
});

function shutdown(signal: string): void {
  console.info(`Recebido sinal ${signal}; encerrando servidor HTTP do agente.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
