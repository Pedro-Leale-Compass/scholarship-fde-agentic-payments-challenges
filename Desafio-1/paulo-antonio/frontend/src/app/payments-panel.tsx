'use client';
import { useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

type Product = { sku: string; name: string; price: number };
type Account = { limite: number; gasto_total: number; limite_restante: number };
type Intent = { intencao_id: string; produto_id: string; quantidade: number; valor_total: number; status: string; expira_em: string; expirada?: boolean };
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function PaymentsPanel({ apiUrl }: { apiUrl: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [method, setMethod] = useState('pix');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('Carregando catálogo e limite…');
  const [uncertain, setUncertain] = useState(false);

  async function request(path: string, body?: unknown) {
    const token = (await fetchAuthSession()).tokens?.idToken;
    if (!token) throw new Error('Entre novamente para continuar.');
    const response = await fetch(new URL(path, apiUrl), {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token.toString()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? 'Sua sessão expirou. Saia e entre novamente.' : value.message || 'Não foi possível concluir a solicitação.');
    return value;
  }

  async function load() {
    setBusy(true);
    try {
      const [catalog, balance] = await Promise.all([request('catalogo'), request('conta')]);
      setProducts(catalog.items); setAccount(balance); setSku(current => current || catalog.items[0]?.sku || '');
      setMessage('Escolha um produto para preparar sua compra simulada.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível carregar os dados.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [apiUrl]);

  async function prepare() {
    setBusy(true); setIntent(null); setUncertain(false);
    try {
      setIntent(await request('intencoes', { sku, quantidade: quantity }));
      setMessage('Confira o total e confirme o pagamento. A intenção vale por três minutos.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível preparar a compra.'); }
    finally { setBusy(false); }
  }
  async function refreshIntent() {
    if (!intent) return;
    setBusy(true);
    try {
      const latest = await request(`intencoes/${encodeURIComponent(intent.intencao_id)}`);
      setIntent(latest); setUncertain(false);
      setMessage(latest.status === 'paga' ? 'Compra simulada confirmada e salva.' : latest.expirada ? 'Esta intenção expirou. Prepare uma nova compra.' : 'Intenção pendente. Nenhum pagamento confirmado.');
      setAccount(await request('conta'));
    } catch { setMessage('Não foi possível consultar. Aguarde e consulte novamente antes de pagar.'); }
    finally { setBusy(false); }
  }
  async function buy() {
    if (!intent) return;
    setBusy(true); setUncertain(true);
    try {
      const result = await request('compras', { intencao_id: intent.intencao_id, metodo_pagamento: method });
      setUncertain(false);
      if (result.status === 'aprovado') {
        setIntent({ ...intent, status: 'paga' });
        setMessage(`Compra simulada aprovada: ${money(result.valor)}. Limite restante: ${money(result.limite_restante)}.`);
        setAccount(current => current ? { ...current, limite_restante: result.limite_restante, gasto_total: current.limite - result.limite_restante } : null);
      } else {
        setMessage(`${result.erro}: ${result.mensagem}`);
        if (result.erro === 'INTENCAO_JA_PAGA') setIntent({ ...intent, status: 'paga' });
        if (result.erro === 'INTENCAO_EXPIRADA') setIntent({ ...intent, expirada: true });
      }
    } catch { setMessage('Não recebemos a confirmação. Use “Consultar pagamento” antes de tentar novamente.'); }
    finally { setBusy(false); }
  }

  return <div className="coming-soon">
    <h3>Compras pelo formulário</h3><p>Escolha produtos e consulte o estado da compra. Nenhum dinheiro real será movimentado.</p>
    {account && <p><strong>Limite disponível: {money(account.limite_restante)}</strong> de {money(account.limite)}</p>}
    <p role="status" aria-live="polite">{message}</p>
    {!products.length ? <button disabled={busy} onClick={load}>Carregar produtos</button> : <>
      <fieldset disabled={busy || uncertain} className="purchase-fields">
        <label>Produto<select value={sku} onChange={e => setSku(e.target.value)}>{products.map(p => <option key={p.sku} value={p.sku}>{p.name} — {money(p.price)}</option>)}</select></label>
        <label>Quantidade<input type="number" min="1" step="1" value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
        <button onClick={prepare} disabled={!Number.isSafeInteger(quantity) || quantity < 1}>Preparar compra</button>
      </fieldset>
      {intent && <div className="intent-summary">
        <p><strong>{intent.quantidade} × {intent.produto_id}: {money(intent.valor_total)}</strong></p>
        <p>Estado: {intent.status === 'paga' ? 'Paga' : intent.expirada ? 'Expirada' : 'Pendente'} · Validade: {new Date(intent.expira_em).toLocaleTimeString('pt-BR')}</p>
        <label>Método<select value={method} disabled={busy || uncertain || intent.status === 'paga'} onChange={e => setMethod(e.target.value)}><option value="pix">Pix simulado</option><option value="cartao">Cartão simulado</option></select></label>
        <div className="purchase-actions"><button onClick={buy} disabled={busy || uncertain || intent.status === 'paga' || intent.expirada}>Confirmar compra simulada</button>
        <button className="secondary" onClick={refreshIntent} disabled={busy}>Consultar pagamento</button></div>
      </div>}
    </>}
  </div>;
}
