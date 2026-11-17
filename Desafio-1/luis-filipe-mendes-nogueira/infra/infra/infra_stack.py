from pathlib import Path

from aws_cdk import (
    ArnFormat,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_apigatewayv2 as apigateway,
    aws_apigatewayv2_authorizers as authorizers,
    aws_apigatewayv2_integrations as integrations,
    aws_cognito as cognito,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_dynamodb as dynamodb,
)
from constructs import Construct
from .agentcore import criar_runtime
from .chat import criar_chat

class InfraStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        prefixo = "luis-filipe-mendes-nogueira"

        def criar_tabela(
            identificador: str,
            nome: str,
            chave_particao: str,
            chave_ordenacao: str | None = None,
        ) -> dynamodb.Table:
            return dynamodb.Table(
                self,
                identificador,
                table_name=f"{prefixo}-{nome}",
                partition_key=dynamodb.Attribute(
                    name=chave_particao,
                    type=dynamodb.AttributeType.STRING,
                ),
                sort_key=(
                    dynamodb.Attribute(
                        name=chave_ordenacao,
                        type=dynamodb.AttributeType.STRING,
                    )
                    if chave_ordenacao
                    else None
                ),
                billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
                encryption=dynamodb.TableEncryption.AWS_MANAGED,
                removal_policy=RemovalPolicy.DESTROY,
            )

        tabela_usuarios = criar_tabela(
            "UsuariosTable",
            "usuarios",
            "usuario_id",
        )

        tabela_catalogo = criar_tabela(
            "CatalogoTable",
            "catalogo",
            "evento_id",
        )

        tabela_intencoes = criar_tabela(
            "IntencoesTable",
            "intencoes",
            "intencao_id",
        )

        tabela_transacoes = criar_tabela(
            "TransacoesTable",
            "transacoes",
            "intencao_id",
        )

        tabela_conversas = criar_tabela(
            "ConversasTable",
            "conversas",
            "usuario_id",
            "registro_id",
        )

        tabela_intencoes.add_global_secondary_index(
            index_name="por-status-expiracao",
            partition_key=dynamodb.Attribute(
                name="status",
                type=dynamodb.AttributeType.STRING,
            ),
            sort_key=dynamodb.Attribute(
                name="expira_em_epoch",
                type=dynamodb.AttributeType.NUMBER,
            ),
            projection_type=dynamodb.ProjectionType.INCLUDE,
            non_key_attributes=[
                "evento_id",
                "quantidade",
            ],
        )

        user_pool = cognito.UserPool(
            self,
            "UserPool",
            user_pool_name=f"{prefixo}-usuarios",
            feature_plan=cognito.FeaturePlan.LITE,
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(
                    required=True,
                    mutable=True,
                ),
            ),
            password_policy=cognito.PasswordPolicy(
                min_length=12,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=True,
                temp_password_validity=Duration.days(7),
            ),
            user_invitation=cognito.UserInvitationConfig(
                email_subject="Convite para o Agente de Pagamentos",
                email_body=(
                    "Você recebeu acesso ao Agente de Pagamentos do projeto &quot;luis-filipe-mendes-nogueira-desafio-1&quot;.<br><br>"
                    "Usuário: {username}<br>"
                    "Senha temporária: {####}<br><br>"
                    "Ao realizar o primeiro acesso, defina uma nova senha."
                ),
            ),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            removal_policy=RemovalPolicy.DESTROY,
        )

        app_client = user_pool.add_client(
            "FrontendClient",
            user_pool_client_name=f"{prefixo}-frontend",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(user_srp=True),
            disable_o_auth=True,
            prevent_user_existence_errors=True,
            enable_token_revocation=True,
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(7),
        )

        nome_lambda = f"{prefixo}-sessao"

        grupo_logs = logs.LogGroup(
            self,
            "SessaoLogs",
            log_group_name=f"/aws/lambda/{nome_lambda}",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        role_sessao = iam.Role(
            self,
            "SessaoRole",
            role_name=f"{prefixo}-sessao-role",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
        )

        arn_streams = self.format_arn(
            service="logs",
            resource="log-group",
            resource_name=(
                f"/aws/lambda/{nome_lambda}:log-stream:*"
            ),
            arn_format=ArnFormat.COLON_RESOURCE_NAME,
        )

        role_sessao.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=[arn_streams],
            )
        )

        raiz_projeto = Path(__file__).resolve().parents[2]

        funcao_sessao = lambda_.Function(
            self,
            "SessaoFunction",
            function_name=nome_lambda,
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="handler.handler",
            code=lambda_.Code.from_asset(
                str(raiz_projeto / "api" / "sessao")
            ),
            role=role_sessao,
            log_group=grupo_logs,
            memory_size=128,
            timeout=Duration.seconds(5),
        )

        nome_perfil = f"{prefixo}-perfil"

        logs_perfil = logs.LogGroup(
            self,
            "PerfilLogs",
            log_group_name=f"/aws/lambda/{nome_perfil}",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        role_perfil = iam.Role(
            self,
            "PerfilRole",
            role_name=f"{prefixo}-perfil-role",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
        )

        role_perfil.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=[
                    self.format_arn(
                        service="logs",
                        resource="log-group",
                        resource_name=(
                            f"/aws/lambda/{nome_perfil}:log-stream:*"
                        ),
                        arn_format=ArnFormat.COLON_RESOURCE_NAME,
                    )
                ],
            )
        )

        role_perfil.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                ],
                resources=[tabela_usuarios.table_arn],
            )
        )

        funcao_perfil = lambda_.Function(
            self,
            "PerfilFunction",
            function_name=nome_perfil,
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="handler.handler",
            code=lambda_.Code.from_asset(
                str(raiz_projeto / "api" / "perfil")
            ),
            role=role_perfil,
            log_group=logs_perfil,
            environment={
                "USUARIOS_TABLE": tabela_usuarios.table_name,
            },
            memory_size=128,
            timeout=Duration.seconds(5),
        )

        def criar_lambda_tool(
            identificador: str,
            nome: str,
            handler: str,
            variaveis: dict[str, str],
            permissoes: list[tuple[list[str], str]],
        ) -> lambda_.Function:
            nome_funcao = f"{prefixo}-{nome}"

            grupo_logs = logs.LogGroup(
                self,
                f"{identificador}Logs",
                log_group_name=f"/aws/lambda/{nome_funcao}",
                retention=logs.RetentionDays.ONE_WEEK,
                removal_policy=RemovalPolicy.DESTROY,
            )

            role = iam.Role(
                self,
                f"{identificador}Role",
                role_name=f"{nome_funcao}-role",
                assumed_by=iam.ServicePrincipal(
                    "lambda.amazonaws.com"
                ),
            )

            role.add_to_policy(
                iam.PolicyStatement(
                    actions=[
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                    ],
                    resources=[
                        self.format_arn(
                            service="logs",
                            resource="log-group",
                            resource_name=(
                                f"/aws/lambda/{nome_funcao}"
                                ":log-stream:*"
                            ),
                            arn_format=ArnFormat.COLON_RESOURCE_NAME,
                        )
                    ],
                )
            )

            for acoes, recurso in permissoes:
                role.add_to_policy(
                    iam.PolicyStatement(
                        actions=acoes,
                        resources=[recurso],
                    )
                )

            return lambda_.Function(
                self,
                identificador,
                function_name=nome_funcao,
                runtime=lambda_.Runtime.PYTHON_3_13,
                handler=handler,
                code=lambda_.Code.from_asset(
                    str(raiz_projeto / "tools" / "pagamentos"),
                    exclude=[
                        "__pycache__",
                        "**/__pycache__/**",
                        "*.pyc",
                        "**/*.pyc",
                    ],
                ),
                role=role,
                log_group=grupo_logs,
                environment=variaveis,
                memory_size=128,
                timeout=Duration.seconds(30),
            )

        indice_expiracao_arn = (
            f"{tabela_intencoes.table_arn}"
            "/index/por-status-expiracao"
        )

        variaveis_catalogo_intencoes = {
            "CATALOGO_TABLE": tabela_catalogo.table_name,
            "INTENCOES_TABLE": tabela_intencoes.table_name,
        }

        funcao_listar_catalogo = criar_lambda_tool(
            identificador="ListarCatalogoFunction",
            nome="listar-catalogo",
            handler="listar_catalogo.handler",
            variaveis=variaveis_catalogo_intencoes,
            permissoes=[
                (
                    ["dynamodb:Scan", "dynamodb:UpdateItem"],
                    tabela_catalogo.table_arn,
                ),
                (
                    ["dynamodb:Query"],
                    indice_expiracao_arn,
                ),
                (
                    ["dynamodb:UpdateItem"],
                    tabela_intencoes.table_arn,
                ),
            ],
        )

        funcao_registrar_intencao = criar_lambda_tool(
            identificador="RegistrarIntencaoFunction",
            nome="registrar-intencao",
            handler="registrar_intencao.handler",
            variaveis=variaveis_catalogo_intencoes,
            permissoes=[
                (
                    ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    tabela_catalogo.table_arn,
                ),
                (
                    ["dynamodb:Query"],
                    indice_expiracao_arn,
                ),
                (
                    ["dynamodb:PutItem", "dynamodb:UpdateItem"],
                    tabela_intencoes.table_arn,
                ),
            ],
        )

        funcao_realizar_compra = criar_lambda_tool(
            identificador="RealizarCompraFunction",
            nome="realizar-compra",
            handler="realizar_compra.handler",
            variaveis={
                **variaveis_catalogo_intencoes,
                "USUARIOS_TABLE": tabela_usuarios.table_name,
                "TRANSACOES_TABLE": tabela_transacoes.table_name,
            },
            permissoes=[
                (
                    ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    tabela_usuarios.table_arn,
                ),
                (
                    ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    tabela_intencoes.table_arn,
                ),
                (
                    ["dynamodb:PutItem"],
                    tabela_transacoes.table_arn,
                ),
                (
                    ["dynamodb:UpdateItem"],
                    tabela_catalogo.table_arn,
                ),
            ],
        )

        runtime_agente = criar_runtime(
            stack=self,
            prefixo=prefixo,
            pacote=(
                raiz_projeto / "agent" / "dist" / "agentcore.zip"
            ),
            funcoes={
                "listar_catalogo": (
                    funcao_listar_catalogo.function_arn
                ),
                "registrar_intencao": (
                    funcao_registrar_intencao.function_arn
                ),
                "realizar_compra": (
                    funcao_realizar_compra.function_arn
                ),
            },
        )

        criar_chat(
            stack=self,
            prefixo=prefixo,
            raiz_projeto=raiz_projeto,
            tabela_conversas=tabela_conversas,
            user_pool=user_pool,
            app_client=app_client,
            arn_runtime=runtime_agente.get_att(
                "AgentRuntimeArn"
            ).to_string(),
        )

        autorizador = authorizers.HttpJwtAuthorizer(
            "CognitoAuthorizer",
            jwt_issuer=user_pool.user_pool_provider_url,
            jwt_audience=[app_client.user_pool_client_id],
        )

        http_api = apigateway.HttpApi(
            self,
            "HttpApi",
            api_name=f"{prefixo}-api",
            cors_preflight=apigateway.CorsPreflightOptions(
                allow_origins=["http://localhost:3001"],
                allow_methods=[apigateway.CorsHttpMethod.GET],
                allow_headers=["Authorization"],
                max_age=Duration.minutes(5),
            ),
            create_default_stage=True,
        )

        http_api.add_routes(
            path="/sessao",
            methods=[apigateway.HttpMethod.GET],
            integration=integrations.HttpLambdaIntegration(
                "SessaoIntegration",
                handler=funcao_sessao,
            ),
            authorizer=autorizador,
            authorization_scopes=[
                "aws.cognito.signin.user.admin",
            ],
        )

        http_api.add_routes(
            path="/me",
            methods=[apigateway.HttpMethod.GET],
            integration=integrations.HttpLambdaIntegration(
                "PerfilIntegration",
                handler=funcao_perfil,
            ),
            authorizer=autorizador,
            authorization_scopes=[
                "aws.cognito.signin.user.admin",
            ],
        )

        CfnOutput(
            self,
            "UserPoolId",
            value=user_pool.user_pool_id,
        )

        CfnOutput(
            self,
            "UserPoolClientId",
            value=app_client.user_pool_client_id,
        )

        CfnOutput(
            self,
            "Region",
            value=self.region,
        )

        CfnOutput(
            self,
            "ApiUrl",
            value=http_api.api_endpoint,
        )

        CfnOutput(
            self,
            "CatalogoTableName",
            value=tabela_catalogo.table_name,
        )
