import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPaymentTools } from './payments.ts';
import { MemoryPaymentStore } from './memory-store.ts';

const context = { usuario_id: 'participante-local' };
const tools = createPaymentTools(new MemoryPaymentStore([{ usuario_id: context.usuario_id, limite_centavos: 500000 }]));
const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));
console.log('TESTE LOCAL — compras fictícias, limite R$ 5.000. Sem AWS, sem login real. Dados apagados ao encerrar.');

if (!process.argv.includes('--interativo')) {
  show(tools.listar_catalogo({ categoria: 'game' }));
  const intent = await tools.registrar_intencao({ sku: 'PS5', quantidade: 1 }, context);
  show(intent);
  show(await tools.realizar_compra({ intencao_id: intent.intencao_id, metodo_pagamento: 'pix' }, context));
  console.log('Tentativa de pagar novamente (deve recusar):');
  show(await tools.realizar_compra({ intencao_id: intent.intencao_id, metodo_pagamento: 'pix' }, context));
} else {
  console.log('Comandos: catalogo [categoria] | intencao SKU quantidade | comprar cartao/pix | sair');
  console.log('comprar usa a última intenção criada com sucesso. Ela expira em 3 minutos.');
  const terminal = createInterface({ input: stdin, output: stdout });
  let lastIntent: string | undefined;
  try {
    while (true) {
      const [command, first, second] = (await terminal.question('> ')).trim().split(/\s+/);
      if (command === 'sair') break;
      try {
        if (command === 'catalogo') show(tools.listar_catalogo({ categoria: first }));
        else if (command === 'intencao') {
          lastIntent = undefined;
          const intent = await tools.registrar_intencao({ sku: first, quantidade: Number(second) }, context);
          lastIntent = intent.intencao_id;
          show(intent);
        } else if (command === 'comprar') show(await tools.realizar_compra({ intencao_id: lastIntent, metodo_pagamento: first }, context));
        else console.log('Use catalogo, intencao, comprar ou sair.');
      } catch (error) { console.log(error instanceof Error ? error.message : 'Falha no teste.'); }
    }
  } finally { terminal.close(); }
}
