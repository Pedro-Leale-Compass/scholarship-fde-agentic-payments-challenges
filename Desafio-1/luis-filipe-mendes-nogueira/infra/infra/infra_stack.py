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
)
from constructs import Construct

class InfraStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        prefixo = "luis-filipe-mendes-nogueira"

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
                    "Você recebeu acesso ao Agente de Pagamentos.<br><br>"
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
