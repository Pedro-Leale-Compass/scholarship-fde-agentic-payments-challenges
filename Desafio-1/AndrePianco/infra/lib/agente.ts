import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";

const PASTA_AGENTE = path.join(__dirname, "../../agent");
const PYTHON_RUNTIME = "PYTHON_3_13";
const PYTHON_VERSAO = "3.13";

export interface AgenteProps {
  /** Inference profile cross-region, ex.: us.anthropic.claude-haiku-4-5-20251001-v1:0 */
  modeloId: string;
  tools: { listarCatalogo: lambda.IFunction; registrarIntencao: lambda.IFunction; realizarCompra: lambda.IFunction };
}

/**
 * Agente Strands no Bedrock AgentCore Runtime, por "direct code deployment":
 * o codigo + dependencias Linux arm64 viram um .zip no S3 -- sem Docker.
 */
export class Agente extends Construct {
  readonly runtime: agentcore.CfnRuntime;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AgenteProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const pacote = new s3assets.Asset(this, "Codigo", {
      path: PASTA_AGENTE,
      // Muda o hash (e o deploy) so quando o codigo ou as dependencias mudam.
      exclude: [".venv", "__pycache__", "build", "*.zip", ".bedrock_agentcore*"],
      bundling: {
        image: cdk.DockerImage.fromRegistry("sem-docker"),
        local: { tryBundle: (saida) => empacotarAgente(saida) },
      },
    });

    this.role = new iam.Role(this, "Role", {
      description: "Role do AgentCore Runtime: invoca o modelo, chama as Lambdas das tools e grava logs",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*` },
        },
      }),
    });

    // 1) Modelo: so o inference profile escolhido e o modelo base por tras
    //    dele (o profile "us." roteia entre us-east-1, us-east-2 e us-west-2).
    const modeloBase = props.modeloId.replace(/^us\./, "");
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvocarModelo",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${props.modeloId}`,
          ...["us-east-1", "us-east-2", "us-west-2"].map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/${modeloBase}`,
          ),
        ],
      }),
    );

    // 2) Tools: so as 3 Lambdas. Nenhum acesso direto as tabelas.
    const { listarCatalogo, registrarIntencao, realizarCompra } = props.tools;
    for (const fn of [listarCatalogo, registrarIntencao, realizarCompra]) fn.grantInvoke(this.role);

    // 3) Logs do runtime.
    const logs = `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Logs",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        resources: [logs, `${logs}:log-stream:*`],
      }),
    );

    // 4) Identidade de workload que o runtime usa internamente.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "IdentidadeWorkload",
        actions: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );

    // 5) Ler SO o proprio pacote de codigo no S3 (nao o bucket inteiro).
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "LerPacoteDoAgente",
        actions: ["s3:GetObject"],
        resources: [pacote.bucket.arnForObjects(pacote.s3ObjectKey)],
      }),
    );

    this.runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: "agente_pagamentos",
      description: "Agente Strands de compras simuladas (Desafio 1)",
      roleArn: this.role.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: pacote.s3BucketName, prefix: pacote.s3ObjectKey } },
          runtime: PYTHON_RUNTIME,
          entryPoint: ["agent.py"],
        },
      },
      environmentVariables: {
        BEDROCK_MODEL_ID: props.modeloId,
        FN_LISTAR_CATALOGO: listarCatalogo.functionName,
        FN_REGISTRAR_INTENCAO: registrarIntencao.functionName,
        FN_REALIZAR_COMPRA: realizarCompra.functionName,
      },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 1800 },
    });
    // A role precisa existir (com as politicas) antes do runtime validar o acesso.
    this.runtime.node.addDependency(this.role);
  }
}

/**
 * Instala as dependencias para Linux arm64 / Python 3.13 (o que o AgentCore
 * executa) e copia o agent.py. Roda na maquina local com `uv`, sem Docker.
 */
function empacotarAgente(saida: string): boolean {
  // `uv` direto no PATH, ou via `py -m uv` no Windows (instalado com pip --user).
  const [cmd, ...prefixo] = process.env.UV_BIN
    ? [process.env.UV_BIN]
    : process.platform === "win32"
      ? ["py", "-m", "uv"]
      : ["uv"];
  const uv = (args: string[]) => execFileSync(cmd, [...prefixo, ...args], { cwd: PASTA_AGENTE, stdio: "inherit" });

  // Versoes exatas do uv.lock (build reproduzivel), sem as dependencias de dev.
  const requisitos = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agente-")), "requirements.txt");
  uv(["export", "--frozen", "--no-dev", "--no-hashes", "--no-emit-project", "--quiet", "-o", requisitos]);
  uv([
    "pip", "install",
    "--python-platform", "aarch64-manylinux2014",
    "--python-version", PYTHON_VERSAO,
    "--target", saida,
    "--only-binary=:all:",
    "--quiet",
    "-r", requisitos,
  ]);
  fs.copyFileSync(path.join(PASTA_AGENTE, "agent.py"), path.join(saida, "agent.py"));
  // Bytecode compilado no Windows nao serve no runtime (recomendacao da AWS).
  for (const entrada of fs.readdirSync(saida, { recursive: true }) as string[]) {
    if (path.basename(entrada) === "__pycache__") {
      fs.rmSync(path.join(saida, entrada), { recursive: true, force: true });
    }
  }
  return true;
}
