import json
from aws_cdk import CfnOutput
from aws_cdk import aws_bedrockagentcore as agentcore
from aws_cdk import aws_iam as iam
from pathlib import Path
from aws_cdk import Duration, RemovalPolicy, Stack
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import custom_resources as cr
from constructs import Construct


class InfraStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # ---------------- Tabelas ----------------

        self.tabela_usuarios = dynamodb.TableV2(
            self,
            "TabelaUsuarios",
            table_name="henrick-usuarios",
            partition_key=dynamodb.Attribute(name="usuario_id", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tabela_produtos = dynamodb.TableV2(
            self,
            "TabelaProdutos",
            table_name="henrick-produtos",
            partition_key=dynamodb.Attribute(name="produto_id", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tabela_intencoes = dynamodb.TableV2(
            self,
            "TabelaIntencoes",
            table_name="henrick-intencoes",
            partition_key=dynamodb.Attribute(name="intencao_id", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tabela_conversas = dynamodb.TableV2(
            self,
            "TabelaConversas",
            table_name="henrick-conversas",
            partition_key=dynamodb.Attribute(name="usuario_id", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            removal_policy=RemovalPolicy.DESTROY,
        )

        # ---------------- Catalogo inicial ----------------

        caminho_catalogo = Path(__file__).parent.parent / "seed" / "catalogo.json"
        catalogo = json.loads(caminho_catalogo.read_text(encoding="utf-8"))

        itens = [
            {
                "PutRequest": {
                    "Item": {
                        "produto_id": {"S": produto["id"]},
                        "nome": {"S": produto["nome"]},
                        "descricao": {"S": produto["descricao"]},
                        "categoria": {"S": produto["categoria"]},
                        "preco": {"N": str(produto["preco"])},
                        "moeda": {"S": produto["moeda"]},
                        "estoque": {"N": str(produto["estoque"])},
                    }
                }
            }
            for produto in catalogo
        ]

        seed_catalogo = cr.AwsCustomResource(
            self,
            "SeedCatalogo",
            on_create=cr.AwsSdkCall(
                service="DynamoDB",
                action="batchWriteItem",
                parameters={"RequestItems": {"henrick-produtos": itens}},
                physical_resource_id=cr.PhysicalResourceId.of("henrick-seed-catalogo"),
            ),
            policy=cr.AwsCustomResourcePolicy.from_sdk_calls(
                resources=[self.tabela_produtos.table_arn],
            ),
            install_latest_aws_sdk=False,
        )
        seed_catalogo.node.add_dependency(self.tabela_produtos)
                # ---------------- Tools (Lambdas) ----------------

        pasta_tools = Path(__file__).parent.parent.parent / "tools"

        logs_listar_catalogo = logs.LogGroup(
            self,
            "LogsListarCatalogo",
            log_group_name="/aws/lambda/henrick-tool-listar-catalogo",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tool_listar_catalogo = lambda_.Function(
            self,
            "ToolListarCatalogo",
            function_name="henrick-tool-listar-catalogo",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="listar_catalogo.handler",
            code=lambda_.Code.from_asset(str(pasta_tools)),
            environment={"TABELA_PRODUTOS": self.tabela_produtos.table_name},
            timeout=Duration.seconds(10),
            log_group=logs_listar_catalogo,
        )

        self.tabela_produtos.grant_read_data(self.tool_listar_catalogo)

        logs_registrar_intencao = logs.LogGroup(
            self,
            "LogsRegistrarIntencao",
            log_group_name="/aws/lambda/henrick-tool-registrar-intencao",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tool_registrar_intencao = lambda_.Function(
            self,
            "ToolRegistrarIntencao",
            function_name="henrick-tool-registrar-intencao",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="registrar_intencao.handler",
            code=lambda_.Code.from_asset(str(pasta_tools)),
            environment={
                "TABELA_PRODUTOS": self.tabela_produtos.table_name,
                "TABELA_INTENCOES": self.tabela_intencoes.table_name,
                "INTENCAO_TTL_SEGUNDOS": "300",
            },
            timeout=Duration.seconds(10),
            log_group=logs_registrar_intencao,
        )

        self.tabela_produtos.grant(self.tool_registrar_intencao, "dynamodb:GetItem")
        self.tabela_intencoes.grant(self.tool_registrar_intencao, "dynamodb:PutItem")

        logs_realizar_compra = logs.LogGroup(
            self,
            "LogsRealizarCompra",
            log_group_name="/aws/lambda/henrick-tool-realizar-compra",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.tool_realizar_compra = lambda_.Function(
            self,
            "ToolRealizarCompra",
            function_name="henrick-tool-realizar-compra",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="realizar_compra.handler",
            code=lambda_.Code.from_asset(str(pasta_tools)),
            environment={
                "TABELA_INTENCOES": self.tabela_intencoes.table_name,
                "TABELA_USUARIOS": self.tabela_usuarios.table_name,
                "TABELA_PRODUTOS": self.tabela_produtos.table_name,
            },
            timeout=Duration.seconds(10),
            log_group=logs_realizar_compra,
        )

        self.tabela_intencoes.grant(self.tool_realizar_compra, "dynamodb:GetItem", "dynamodb:UpdateItem")
        self.tabela_usuarios.grant(self.tool_realizar_compra, "dynamodb:GetItem", "dynamodb:UpdateItem")
        self.tabela_produtos.grant(self.tool_realizar_compra, "dynamodb:UpdateItem")


                # ---------------- Agente no AgentCore ----------------

        pasta_build_agente = Path(__file__).parent.parent.parent / "agent" / "build"
        id_modelo = "anthropic.claude-haiku-4-5-20251001-v1:0"

        self.agente = agentcore.Runtime(
            self,
            "AgenteCompras",
            runtime_name="henrick_agente_compras",
            agent_runtime_artifact=agentcore.AgentRuntimeArtifact.from_code_asset(
                path=str(pasta_build_agente),
                runtime=agentcore.AgentCoreRuntime.PYTHON_3_12,
                entrypoint=["main.py"],
            ),
            environment_variables={
                "MODEL_ID": f"us.{id_modelo}",
                "FN_LISTAR_CATALOGO": self.tool_listar_catalogo.function_name,
                "FN_REGISTRAR_INTENCAO": self.tool_registrar_intencao.function_name,
                "FN_REALIZAR_COMPRA": self.tool_realizar_compra.function_name,
                "TABELA_CONVERSAS": self.tabela_conversas.table_name,
            },
        )

        # Modelo: o perfil "us." e os modelos nas regioes dos EUA que ele pode usar.
        self.agente.role.add_to_principal_policy(
            iam.PolicyStatement(
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=[
                    f"arn:aws:bedrock:us-east-1:{self.account}:inference-profile/us.{id_modelo}",
                    f"arn:aws:bedrock:us-east-1::foundation-model/{id_modelo}",
                    f"arn:aws:bedrock:us-east-2::foundation-model/{id_modelo}",
                    f"arn:aws:bedrock:us-west-2::foundation-model/{id_modelo}",
                ],
            )
        )

        # Tools: so as tres Lambdas.
        self.tool_listar_catalogo.grant_invoke(self.agente.role)
        self.tool_registrar_intencao.grant_invoke(self.agente.role)
        self.tool_realizar_compra.grant_invoke(self.agente.role)

        # Historico: so ler e gravar na tabela de conversas.
        self.tabela_conversas.grant(self.agente.role, "dynamodb:GetItem", "dynamodb:PutItem")

        # Logs do agente: o AgentCore cria o grupo sozinho.
        # Aqui so ajustamos a retencao e garantimos que ele seja apagado no destroy.
        nome_logs_agente = f"/aws/bedrock-agentcore/runtimes/{self.agente.agent_runtime_id}-DEFAULT"
        arn_logs_agente = f"arn:aws:logs:{self.region}:{self.account}:log-group:{nome_logs_agente}"

        logs_agente = cr.AwsCustomResource(
            self,
            "LogsAgente",
            on_create=cr.AwsSdkCall(
                service="CloudWatchLogs",
                action="putRetentionPolicy",
                parameters={"logGroupName": nome_logs_agente, "retentionInDays": 7},
                physical_resource_id=cr.PhysicalResourceId.of(nome_logs_agente),
            ),
            on_delete=cr.AwsSdkCall(
                service="CloudWatchLogs",
                action="deleteLogGroup",
                parameters={"logGroupName": nome_logs_agente},
                ignore_error_codes_matching="ResourceNotFoundException",
            ),
            policy=cr.AwsCustomResourcePolicy.from_sdk_calls(
                resources=[arn_logs_agente, f"{arn_logs_agente}:*"],
            ),
            install_latest_aws_sdk=False,
        )
        logs_agente.node.add_dependency(self.agente)

        CfnOutput(self, "AgenteArn", value=self.agente.agent_runtime_arn)