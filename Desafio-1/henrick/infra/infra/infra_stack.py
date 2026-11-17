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
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_apigateway as apigw


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

                # ---------------- Cognito (login) ----------------

        self.user_pool = cognito.UserPool(
            self,
            "UserPool",
            user_pool_name="henrick-usuarios",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.app_client = self.user_pool.add_client(
            "AppClient",
            user_pool_client_name="henrick-frontend",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(user_srp=True, user_password=True),
        )

        CfnOutput(self, "UserPoolId", value=self.user_pool.user_pool_id)
        CfnOutput(self, "AppClientId", value=self.app_client.user_pool_client_id)


                # ---------------- Lambda do chat ----------------

        pasta_api = Path(__file__).parent.parent.parent / "api"
        origem_frontend = "http://localhost:5173"

        logs_chat = logs.LogGroup(
            self,
            "LogsChat",
            log_group_name="/aws/lambda/henrick-chat",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        self.lambda_chat = lambda_.Function(
            self,
            "LambdaChat",
            function_name="henrick-chat",
            runtime=lambda_.Runtime.NODEJS_22_X,
            handler="chat.handler",
            code=lambda_.Code.from_asset(str(pasta_api)),
            environment={
                "AGENTE_ARN": self.agente.agent_runtime_arn,
                "ORIGEM_PERMITIDA": origem_frontend,
                "TABELA_USUARIOS": self.tabela_usuarios.table_name,
                "LIMITE_PADRAO": "1500",
            },
            timeout=Duration.seconds(120),
            memory_size=256,
            log_group=logs_chat,
        )

        self.tabela_usuarios.grant(self.lambda_chat, "dynamodb:PutItem")
        self.agente.grant_invoke_runtime(self.lambda_chat)

        # ---------------- API Gateway ----------------

        self.api = apigw.RestApi(
            self,
            "Api",
            rest_api_name="henrick-api",
            deploy_options=apigw.StageOptions(stage_name="prod"),
            cloud_watch_role=False,
            default_cors_preflight_options=apigw.CorsOptions(
                allow_origins=[origem_frontend],
                allow_methods=["POST", "OPTIONS"],
                allow_headers=["Content-Type", "Authorization"],
            ),
        )

        # Erros do proprio API Gateway (como o 401) tambem precisam do cabecalho de CORS.
        for nome, tipo in [("Erros4xx", apigw.ResponseType.DEFAULT_4_XX), ("Erros5xx", apigw.ResponseType.DEFAULT_5_XX)]:
            self.api.add_gateway_response(
                nome,
                type=tipo,
                response_headers={"Access-Control-Allow-Origin": f"'{origem_frontend}'"},
            )

        autorizador = apigw.CognitoUserPoolsAuthorizer(
            self,
            "AutorizadorCognito",
            cognito_user_pools=[self.user_pool],
            authorizer_name="henrick-cognito",
        )

        metodo_chat = self.api.root.add_resource("chat").add_method(
            "POST",
            apigw.LambdaIntegration(self.lambda_chat, proxy=True),
            authorizer=autorizador,
            authorization_type=apigw.AuthorizationType.COGNITO,
        )

        # Liga o streaming: o CDK ainda nao tem opcao pronta, entao ajustamos o recurso direto.
        cfn_metodo = metodo_chat.node.default_child
        cfn_metodo.add_property_override("Integration.ResponseTransferMode", "STREAM")
        cfn_metodo.add_property_override("Integration.TimeoutInMillis", 120000)
        cfn_metodo.add_property_override(
            "Integration.Uri",
            f"arn:aws:apigateway:{self.region}:lambda:path/2021-11-15/functions/"
            f"{self.lambda_chat.function_arn}/response-streaming-invocations",
        )

        CfnOutput(self, "ApiUrl", value=self.api.url_for_path("/chat"))