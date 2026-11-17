export const CATALOG = Object.freeze([
  { sku: 'PS5', name: 'PlayStation 5', cents: 479900, category: 'game' },
  { sku: 'PCGAMER', name: 'PC Gamer', cents: 1249900, category: 'PC' },
  { sku: 'NOTEWORK', name: 'Notebook de trabalho', cents: 629900, category: 'PC' },
  { sku: 'MONITOR', name: 'Monitor 27" 144Hz', cents: 189990, category: 'PC' },
  { sku: 'CADEIRA', name: 'Cadeira gamer', cents: 129900, category: 'moveis' },
  { sku: 'LHC', name: 'Acelerador de partículas de bancada (seminovo, poucos prótons rodados)', cents: 420000000000, category: 'lab' },
].map(item => Object.freeze(item)));

export class BadArgs extends Error {}

export function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadArgs('Argumentos inválidos.');
  return value as Record<string, unknown>;
}

export function listarCatalogo(input: unknown = {}) {
  const args = objectArgs(input);
  if (args.categoria !== undefined && typeof args.categoria !== 'string') throw new BadArgs('Categoria inválida.');
  const category = (args.categoria as string | undefined)?.trim().toLowerCase();
  const items = CATALOG.filter(item => !category || item.category.toLowerCase() === category)
    .map(({ cents, ...item }) => ({ ...item, price: cents / 100, currency: 'BRL' }));
  if (!items.length) throw new BadArgs('Categoria não encontrada. Consulte o catálogo sem filtro.');
  return { count: items.length, items };
}
