// Lê as saídas do `cdk deploy` e gera a configuração do front (nada fica fixo no código).
import { readFileSync, writeFileSync } from 'node:fs';

const saidas = Object.values(JSON.parse(readFileSync('cdk-outputs.json', 'utf8')))[0];
const env = [
  `VITE_API_URL=${saidas.ApiUrl.replace(/\/$/, '')}`,
  `VITE_USER_POOL_ID=${saidas.UserPoolId}`,
  `VITE_USER_POOL_CLIENT_ID=${saidas.UserPoolClientId}`,
  `VITE_REGION=${saidas.Regiao}`,
].join('\n');
writeFileSync('../frontend/.env.local', env + '\n');
console.log('Config do front gerada em frontend/.env.local:\n' + env);
