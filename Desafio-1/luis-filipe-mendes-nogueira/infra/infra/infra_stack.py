from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_cognito as cognito,
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
                    "Você recebeu acesso ao Agente de Pagamentos.\n"
                    "Usuário: {username}\n"
                    "Senha temporária: {####}\n"
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
