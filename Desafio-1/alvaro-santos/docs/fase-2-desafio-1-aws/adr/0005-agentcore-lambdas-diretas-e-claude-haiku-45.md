---
title: "ADR-0005: Invocação Direta de Tool Lambdas no AgentCore Runtime, Bundling Isolado e Claude Haiku 4.5"
status: aceito
type: adr
projeto: nexus-store-desafio-1
decisor: Álvaro Kayc
data_decisao: 2026-11-16
---

# ADR-0005: Invocação Direta de Tool Lambdas no AgentCore Runtime, Bundling Isolado e Claude Haiku 4.5

## 1. Contexto

Na camada do agente (`infra/lib/agent.ts`, `agent/src/` e `infra/lib/lambda-bundler.ts`), o projeto precisou consolidar três decisões práticas entre a especificação inicial e a execução real na AWS (`us-east-1`):

1. **Despacho das ferramentas do Strands Agent:** o enunciado sugere como possibilidade expor as Lambdas por meio de um AgentCore Gateway MCP, mas também aceita variações justificadas na documentação.
2. **Versão do modelo Bedrock:** a referência inicial utilizava `us.anthropic.claude-3-haiku-20240307-v1:0`. Durante os primeiros testes reais no AgentCore Runtime, o Bedrock retornou `ResourceNotFoundException: This model version has reached the end of its life`.
3. **Empacotamento de múltiplas Lambdas no mesmo diretório raiz (`tools/`):** `consultar-saldo`, `criar-intencao` e `confirmar-pagamento` compartilham `tools/shared/catalog.ts`, usando `tools/` como `assetRootDir` em `lambda.Code.fromAsset`. No modo padrão (`AssetHashType.SOURCE`), o `AssetStaging` do CDK gerou o mesmo `S3Key` para as três funções, implantando o código de `consultar-saldo` dentro de `criar-intencao` e `confirmar-pagamento`.

## 2. Decisões

1. **Invocação direta das Tool Lambdas via AWS SDK dentro do AgentCore Runtime (`agent/src/tools.ts`):**
   - O container Strands (`alvaro_payment_agent`, `linux/arm64`) registra `listar_catalogo`, `registrar_intencao` e `realizar_compra` com validação Zod e invoca diretamente cada Lambda (`alvaro-tool-consultar-saldo`, `alvaro-tool-criar-intencao`, `alvaro-tool-confirmar-pagamento`) via `@aws-sdk/client-lambda`.
   - O `usuario_id` proveniente da claim `sub` do JWT é trafegado via `invocationState.usuarioId` em memória do runtime, sem fazer parte dos parâmetros visíveis ao modelo (anti-spoofing).

2. **Atualização do modelo para Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`):**
   - Substituímos `claude-3-haiku-20240307-v1:0` (EOL) pelo inference profile ativo `us.anthropic.claude-haiku-4-5-20251001-v1:0` (roteamento `us-east-1`, `us-east-2` e `us-west-2`), atualizando tanto `DEFAULT_BEDROCK_MODEL_ID` em `agent/src/prompt.ts` quanto as permissões IAM escopadas em `infra/lib/agent.ts`.

3. **Hash customizado por entrypoint em `infra/lib/lambda-bundler.ts`:**
   - Configuramos `assetHashType: cdk.AssetHashType.CUSTOM` com `assetHash: \`${cdk.FileSystem.fingerprint(assetRootDir)}:${path.relative(assetRootDir, entryFile)}\`` no `bundleNode22Lambda`.
   - Evitamos `AssetHashType.OUTPUT` devido a falhas de permissão (`EPERM` em `rename` de pastas `bundling-temp-*`) no sistema de arquivos do Windows.

## 3. Alternativas Consideradas e Trade-offs

- **Adicionar AgentCore Gateway separado para as 3 Lambdas:** introduziria mais um recurso gerenciado, tradução extra de schemas MCP e salto adicional de rede/latência dentro do limite de integração do API Gateway, sem trazer ganho adicional de segurança além do que já é aplicado pela role dedicada (`lambda:InvokeFunction` estrito nas 3 Lambdas e zero acesso ao DynamoDB) + `invocationState`.
- **Manter `node_modules` e `package.json` independentes por pasta de tool:** eliminaria a necessidade de `assetRootDir` compartilhado, porém duplicaria `tools/shared/catalog.ts` em três diretórios diferentes, criando risco de divergência de preços e produtos entre `consultar-saldo` e `criar-intencao`.

## 4. Consequências

- **Positivas:** cada Lambda em `tools/` recebe um artefato `.zip` isolado com seu `S3Key` exclusivo no CloudFormation, o catálogo em `tools/shared/catalog.ts` permanece como fonte única da verdade, o runtime responde com baixa latência usando Claude Haiku 4.5 e a separação estrita de permissões IAM (menor privilégio) permanece preservada.
- **Negativas / Mitigações:** se outra tool passar a ser compartilhada com sistemas externos via protocolo MCP no futuro, o contrato Zod existente em `agent/src/tools.ts` pode ser migrado para um AgentCore Gateway sem alterar as Lambdas de negócio em `tools/`.
