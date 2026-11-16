/**
 * Configuração dinâmica da aplicação frontend.
 *
 * Em produção no S3/CloudFront, lê o /config.json gerado pelo CDK durante o deploy.
 * Em desenvolvimento local, utiliza variáveis de ambiente do Vite (.env.local).
 */

export interface AppConfig {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
}

export async function carregarConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('/config.json', { cache: 'no-store' });
    if (r.ok) {
      const cfg: AppConfig = await r.json();
      return {
        ...cfg,
        apiUrl: cfg.apiUrl.replace(/\/$/, ''),
      };
    }
  } catch {
    // Fallback para desenvolvimento local
  }

  if (import.meta.env.DEV) {
    const apiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
    const userPoolId = import.meta.env.VITE_USER_POOL_ID || '';
    const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID || '';
    const region = import.meta.env.VITE_AWS_REGION || 'us-east-1';

    return { apiUrl, userPoolId, userPoolClientId, region };
  }

  throw new Error('Arquivo de configuração /config.json ausente.');
}
