from pathlib import Path

from aws_cdk import (
    ArnFormat,
    CfnOutput,
    CfnResource,
    RemovalPolicy,
    Stack,
    aws_iam as iam,
    aws_logs as logs,
    aws_s3_assets as assets,
)


def criar_runtime(
    stack: Stack,
    prefixo: str,
    pacote: Path,
    funcoes: dict[str, str],
) -> CfnResource:
    if not pacote.is_file():
        raise FileNotFoundError(
            "Pacote do agente ausente. "
            "Execute scripts/empacotar_agent.py antes do CDK."
        )

    # O nome do AgentCore aceita letras, números e underscores.
    nome_runtime = "luis_filipe_mendes_nogueira_agent"

    arn_runtime_padrao = stack.format_arn(
        service="bedrock-agentcore",
        resource="runtime",
        resource_name=f"{nome_runtime}-*",
        arn_format=ArnFormat.SLASH_RESOURCE_NAME,
    )

    role = iam.Role(
        stack,
        "AgentCoreRole",
        role_name=f"{prefixo}-agentcore-role",
        assumed_by=iam.ServicePrincipal(
            "bedrock-agentcore.amazonaws.com",
            conditions={
                "StringEquals": {
                    "aws:SourceAccount": stack.account,
                },
                "ArnLike": {
                    "aws:SourceArn": arn_runtime_padrao,
                },
            },
        ),
    )

    codigo = assets.Asset(
        stack,
        "AgentCoreCode",
        path=str(pacote),
    )

    modelo = "anthropic.claude-haiku-4-5-20251001-v1:0"
    perfil = f"us.{modelo}"

    arn_perfil = stack.format_arn(
        service="bedrock",
        resource="inference-profile",
        resource_name=perfil,
        arn_format=ArnFormat.SLASH_RESOURCE_NAME,
    )

    arns_modelo = [
        (
            f"arn:{stack.partition}:bedrock:{regiao}::"
            f"foundation-model/{modelo}"
        )
        for regiao in (
            "us-east-1",
            "us-east-2",
            "us-west-2",
        )
    ]

    arn_logs_padrao = stack.format_arn(
        service="logs",
        resource="log-group",
        resource_name=(
            "/aws/bedrock-agentcore/runtimes/"
            f"{nome_runtime}-*"
        ),
        arn_format=ArnFormat.COLON_RESOURCE_NAME,
    )

    politica = iam.Policy(
        stack,
        "AgentCorePolicy",
        statements=[
            iam.PolicyStatement(
                sid="InvocarFerramentas",
                actions=["lambda:InvokeFunction"],
                resources=list(funcoes.values()),
            ),
            iam.PolicyStatement(
                sid="InvocarPerfilHaiku",
                actions=[
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                ],
                resources=[arn_perfil],
            ),
            iam.PolicyStatement(
                sid="HaikuSomentePeloPerfil",
                actions=[
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                ],
                resources=arns_modelo,
                conditions={
                    "StringEquals": {
                        "bedrock:InferenceProfileArn": arn_perfil,
                    },
                },
            ),
            iam.PolicyStatement(
                sid="LerPacoteDoAgente",
                actions=[
                    "s3:GetObject",
                    "s3:GetObjectVersion",
                ],
                resources=[
                    codigo.bucket.arn_for_objects(
                        codigo.s3_object_key
                    ),
                ],
            ),
            iam.PolicyStatement(
                sid="ConsultarStreamsDoRuntime",
                actions=["logs:DescribeLogStreams"],
                resources=[arn_logs_padrao],
            ),
            iam.PolicyStatement(
                sid="EscreverLogsDoRuntime",
                actions=[
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                resources=[
                    f"{arn_logs_padrao}:log-stream:*",
                ],
            ),
        ],
    )
    politica.attach_to_role(role)

    # Sem AuthorizerConfiguration, a autenticação é AWS IAM.
    runtime = CfnResource(
        stack,
        "AgentCoreRuntime",
        type="AWS::BedrockAgentCore::Runtime",
        properties={
            "AgentRuntimeName": nome_runtime,
            "Tags": {"Projeto": prefixo},
            "Description": (
                "Agente de pagamentos simulados com Strands e Haiku."
            ),
            "AgentRuntimeArtifact": {
                "CodeConfiguration": {
                    "Code": {
                        "S3": {
                            "Bucket": codigo.s3_bucket_name,
                            "Prefix": codigo.s3_object_key,
                        },
                    },
                    "Runtime": "PYTHON_3_13",
                    "EntryPoint": ["runtime.py"],
                },
            },
            "RoleArn": role.role_arn,
            "NetworkConfiguration": {
                "NetworkMode": "PUBLIC",
            },
            "ProtocolConfiguration": "HTTP",
            "LifecycleConfiguration": {
                "IdleRuntimeSessionTimeout": 60,
                "MaxLifetime": 900,
            },
            "EnvironmentVariables": {
                "LISTAR_CATALOGO_FUNCTION": (
                    funcoes["listar_catalogo"]
                ),
                "REGISTRAR_INTENCAO_FUNCTION": (
                    funcoes["registrar_intencao"]
                ),
                "REALIZAR_COMPRA_FUNCTION": (
                    funcoes["realizar_compra"]
                ),
            },
        },
    )

    runtime.apply_removal_policy(RemovalPolicy.DESTROY)

    # A política deve existir antes da criação do runtime.
    runtime.node.add_dependency(politica)

    runtime_id = runtime.get_att("AgentRuntimeId").to_string()

    logs.LogGroup(
        stack,
        "AgentCoreLogs",
        log_group_name=(
            "/aws/bedrock-agentcore/runtimes/"
            f"{runtime_id}-DEFAULT"
        ),
        retention=logs.RetentionDays.ONE_WEEK,
        removal_policy=RemovalPolicy.DESTROY,
    )

    CfnOutput(
        stack,
        "AgentRuntimeArn",
        value=runtime.get_att("AgentRuntimeArn").to_string(),
    )

    CfnOutput(
        stack,
        "AgentRuntimeId",
        value=runtime_id,
    )

    CfnOutput(
        stack,
        "AgentRuntimeRoleArn",
        value=role.role_arn,
    )

    return runtime
