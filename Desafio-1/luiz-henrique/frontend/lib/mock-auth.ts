/**
 * Mock auth utilities — Desafio 1 (luiz-henrique).
 *
 * Usado apenas em desenvolvimento LOCAL (sem AWS Cognito).
 * Gera um JWT manual (assinatura não verificada pela API — apenas lê o `sub` do payload),
 * compatível com a validação da api/index.ts e api/local/index.ts.
 *
 * Usuários mock disponíveis:
 *   - <test-email> / Temp1234!
 *   - maria@test.com / Temp1234!
 */

interface MockUser {
  email: string;
  password: string;
  name: string;
  sub: string;
}

const MOCK_USERS: MockUser[] = [
  {
    email: 'luiz.fsilva@desafio1.local',
    password: 'Temp1234!',
    name: 'Luiz F. Silva',
    sub: 'usr-luiz-001',
  },
  {
    email: 'maria.silva@desafio1.local',
    password: 'Temp1234!',
    name: 'Maria Silva',
    sub: 'usr-maria-002',
  },
];

function base64Url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function makeMockJwt(sub: string, email: string): string {
  const header = base64Url({ alg: 'none', typ: 'JWT' });
  const payload = base64Url({ sub, email });
  return `${header}.${payload}.`;
}

export function decodeMockJwt(token: string): { sub?: string; email?: string } | null {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const decoded = Buffer.from(
      payloadPart.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    return JSON.parse(decoded.toString('utf-8'));
  } catch (_) {
    return null;
  }
}

export function authenticateMock(email: string, password: string): MockUser | null {
  const user = MOCK_USERS.find((u) => u.email === email && u.password === password);
  return user || null;
}

export function getMockUsers(): MockUser[] {
  return MOCK_USERS;
}

export function isLocalDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      process.env.NEXT_PUBLIC_LOCAL_DEV === 'true')
  );
}
