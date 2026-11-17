from pathlib import Path

from aws_cdk import (
    ArnFormat,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_apigateway as apigateway,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
)


def criar_chat(
    stack: Stack,
    prefixo: str,
    raiz_projeto: Path,
    tabela_conversas: dynamodb.ITable,
    user_pool: cognito.IUserPool,
    app_client: cognito.IUserPoolClient,
    arn_runtime: str,
) -> apigateway.RestApi:
    codigo = raiz_projeto / "api" / "chat" / "dist"

    if not (codigo / "index.mjs").is_file():
        raise FileNotFoundError(
            "Pacote do chat ausente. "
            "Execute npm --prefix api/chat run build na raiz."
        )

    nome_funcao = f"{prefixo}-chat"

    grupo_logs = logs.LogGroup(
        stack,
        "ChatLogs",
        log_group_name=f"/aws/lambda/{nome_funcao}",
        retention=logs.RetentionDays.ONE_WEEK,
        removal_policy=RemovalPolicy.DESTROY,
    )

    role = iam.Role(
        stack,
        "ChatRole",
        role_name=f"{prefixo}-chat-role",
        assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
    )

    role.add_to_policy(
        iam.PolicyStatement(
            actions=[
                "logs:CreateLogStream",
                "logs:PutLogEvents",
            ],
            resources=[
                stack.format_arn(
                    service="logs",
                    resource="log-group",
                    resource_name=(
                        f"/aws/lambda/{nome_funcao}:log-stream:*"
                    ),
                    arn_format=ArnFormat.COLON_RESOURCE_NAME,
                )
            ],
        )
    )

    role.add_to_policy(
        iam.PolicyStatement(
            actions=[
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
            ],
            resources=[tabela_conversas.table_arn],
        )
    )

    role.add_to_policy(
        iam.PolicyStatement(
            actions=[
                "bedrock-agentcore:InvokeAgentRuntime",
                "bedrock-agentcore:StopRuntimeSession",
            ],
            resources=[
                arn_runtime,
                f"{arn_runtime}/runtime-endpoint/DEFAULT",
            ],
        )
    )

    funcao = lambda_.Function(
        stack,
        "ChatFunction",
        function_name=nome_funcao,
        runtime=lambda_.Runtime.NODEJS_24_X,
        architecture=lambda_.Architecture.ARM_64,
        handler="index.handler",
        code=lambda_.Code.from_asset(str(codigo)),
        role=role,
        log_group=grupo_logs,
        memory_size=256,
        timeout=Duration.seconds(120),
        environment={
            "CONVERSAS_TABLE": tabela_conversas.table_name,
            "AGENT_RUNTIME_ARN": arn_runtime,
            "COGNITO_CLIENT_ID": app_client.user_pool_client_id,
            "FRONTEND_ORIGIN": "http://localhost:3001",
        },
    )

    api = apigateway.RestApi(
        stack,
        "ChatApi",
        rest_api_name=f"{prefixo}-chat-api",
        endpoint_types=[apigateway.EndpointType.REGIONAL],
        cloud_watch_role=False,
        deploy_options=apigateway.StageOptions(
            stage_name="prod",
            tracing_enabled=False,
            metrics_enabled=False,
            data_trace_enabled=False,
            throttling_rate_limit=2,
            throttling_burst_limit=4,
        ),
        default_cors_preflight_options=apigateway.CorsOptions(
            allow_origins=["http://localhost:3001"],
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
            max_age=Duration.minutes(5),
        ),
    )

    Tags.of(api).add("Projeto", prefixo)

    autorizador = apigateway.CognitoUserPoolsAuthorizer(
        stack,
        "ChatAuthorizer",
        cognito_user_pools=[user_pool],
        results_cache_ttl=Duration.seconds(0),
    )

    integracao = apigateway.LambdaIntegration(
        funcao,
        proxy=True,
        allow_test_invoke=False,
        response_transfer_mode=apigateway.ResponseTransferMode.STREAM,
        timeout=Duration.seconds(120),
    )

    opcoes = {
        "authorization_type": apigateway.AuthorizationType.COGNITO,
        "authorizer": autorizador,
        "authorization_scopes": [
            "aws.cognito.signin.user.admin",
        ],
    }

    api.root.add_resource("chat").add_method(
        "POST",
        integracao,
        **opcoes,
    )

    conversas = api.root.add_resource("conversas")

    conversas.add_method("POST", integracao, **opcoes)
    conversas.add_method("GET", integracao, **opcoes)

    conversas.add_resource("{conversa_id}").add_method(
        "GET",
        integracao,
        **opcoes,
    )

    for tipo in (
        apigateway.ResponseType.UNAUTHORIZED,
        apigateway.ResponseType.ACCESS_DENIED,
        apigateway.ResponseType.DEFAULT_4_XX,
        apigateway.ResponseType.DEFAULT_5_XX,
    ):
        api.add_gateway_response(
            f"ChatResposta{tipo.response_type.replace('_', '')}",
            type=tipo,
            response_headers={
                "Access-Control-Allow-Origin": (
                    "'http://localhost:3001'"
                ),
                "Access-Control-Allow-Headers": (
                    "'Authorization,Content-Type'"
                ),
            },
        )

    CfnOutput(
        stack,
        "ChatApiUrl",
        value=api.url.rstrip("/"),
    )

    return api
