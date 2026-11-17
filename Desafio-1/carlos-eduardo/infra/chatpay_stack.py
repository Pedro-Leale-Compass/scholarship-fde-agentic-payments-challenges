import os
from pathlib import Path
import subprocess

from aws_cdk import (
    CfnResource,
    CfnOutput,
    Duration,
    Fn,
    RemovalPolicy,
    Stack,
    aws_apigateway as apigateway,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_ecr_assets as ecr_assets,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_s3 as s3,
    aws_s3_deployment as s3_deployment,
)
from constructs import Construct


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "fellows-carlos-eduardo"
REGION = "us-east-1"
FOUNDATION_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0"
MODEL_ID = f"us.{FOUNDATION_MODEL_ID}"
ENABLE_CLOUDFRONT = os.environ.get("ENABLE_CLOUDFRONT", "false").lower() == "true"


class ChatPayStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(
            scope,
            construct_id,
            stack_name=PREFIX,
            **kwargs,
        )

        self._ensure_local_assets()
        removal_policy = RemovalPolicy.DESTROY
        tables = self._create_tables(removal_policy)
        user_pool, user_pool_client = self._create_cognito()
        frontend_bucket, distribution = self._create_frontend(removal_policy)
        frontend_origin = (
            f"https://{distribution.domain_name}"
            if distribution
            else "http://localhost:5173"
        )

        tool_functions = self._create_tool_functions(tables)
        runtime = self._create_agent_runtime(tool_functions)
        runtime_arn = runtime.get_att("AgentRuntimeArn").to_string()
        chat_function = self._create_chat_function(
            tables["conversations"],
            runtime_arn,
            frontend_origin,
        )
        self._create_api(user_pool, chat_function, frontend_origin)
        self._deploy_frontend_assets(
            frontend_bucket,
            distribution,
            user_pool,
            user_pool_client,
        )

        CfnOutput(self, "FrontendBucket", value=frontend_bucket.bucket_name)
        CfnOutput(
            self,
            "DistributionId",
            value=distribution.distribution_id if distribution else "local-dev",
        )
        CfnOutput(self, "CloudFrontUrl", value=frontend_origin)
        CfnOutput(self, "ApiUrl", value=self.api.url)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id)
        CfnOutput(self, "ProductsTable", value=tables["products"].table_name)
        CfnOutput(self, "UsersTable", value=tables["users"].table_name)
        CfnOutput(self, "ConversationsTable", value=tables["conversations"].table_name)
        CfnOutput(self, "IntentsTable", value=tables["intents"].table_name)
        CfnOutput(self, "TransactionsTable", value=tables["transactions"].table_name)

    def _ensure_local_assets(self):
        use_shell = os.name == "nt"
        if not (ROOT / "api" / "node_modules").is_dir():
            subprocess.run(
                ["npm", "ci", "--prefix", str(ROOT / "api")],
                check=True,
                shell=use_shell,
            )
        if not (ROOT / "frontend" / "dist" / "index.html").is_file():
            if not (ROOT / "frontend" / "node_modules").is_dir():
                subprocess.run(
                    ["npm", "ci", "--prefix", str(ROOT / "frontend")],
                    check=True,
                    shell=use_shell,
                )
            subprocess.run(
                ["npm", "run", "build", "--prefix", str(ROOT / "frontend")],
                check=True,
                shell=use_shell,
            )

    def _create_tables(self, removal_policy):
        definitions = {
            "products": (("product_id", dynamodb.AttributeType.STRING),),
            "users": (("user_id", dynamodb.AttributeType.STRING),),
            "conversations": (
                ("user_id", dynamodb.AttributeType.STRING),
                ("message_id", dynamodb.AttributeType.STRING),
            ),
            "intents": (("intent_id", dynamodb.AttributeType.STRING),),
            "transactions": (
                ("user_id", dynamodb.AttributeType.STRING),
                ("transaction_key", dynamodb.AttributeType.STRING),
            ),
        }
        tables = {}
        for name, keys in definitions.items():
            table = dynamodb.Table(
                self,
                f"{name.title()}DataTable",
                table_name=f"{PREFIX}-{name}",
                partition_key=dynamodb.Attribute(
                    name=keys[0][0],
                    type=keys[0][1],
                ),
                sort_key=(
                    dynamodb.Attribute(name=keys[1][0], type=keys[1][1])
                    if len(keys) == 2
                    else None
                ),
                billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
                encryption=dynamodb.TableEncryption.AWS_MANAGED,
                point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                    point_in_time_recovery_enabled=True,
                ),
                removal_policy=removal_policy,
            )
            tables[name] = table
        return tables

    def _create_cognito(self):
        user_pool = cognito.UserPool(
            self,
            "ChatPayUserPool",
            user_pool_name=f"{PREFIX}-users",
            self_sign_up_enabled=False,
            user_invitation=cognito.UserInvitationConfig(
                email_subject="Seu acesso ao ChatPay",
                email_body="Olá {username}! Seu acesso ao ChatPay está pronto. Sua senha temporária é {####}.",
            ),
            sign_in_aliases=cognito.SignInAliases(username=True, email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            password_policy=cognito.PasswordPolicy(
                min_length=12,
                require_digits=True,
                require_lowercase=True,
                require_uppercase=True,
                require_symbols=True,
            ),
            removal_policy=RemovalPolicy.DESTROY,
        )
        client = user_pool.add_client(
            "ChatPayFrontendClient",
            user_pool_client_name=f"{PREFIX}-frontend",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(
                user_srp=True,
            ),
            prevent_user_existence_errors=True,
            enable_token_revocation=True,
        )
        return user_pool, client

    def _create_frontend(self, removal_policy):
        bucket = s3.Bucket(
            self,
            "PrivateFrontendBucket",
            bucket_name=f"{PREFIX}-frontend-{self.account}-{REGION}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=removal_policy,
            auto_delete_objects=True,
        )
        if not ENABLE_CLOUDFRONT:
            return bucket, None

        distribution = cloudfront.Distribution(
            self,
            "FrontendDistribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
            ),
            error_responses=[
                cloudfront.ErrorResponse(
                    http_status=403,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=Duration.minutes(1),
                ),
                cloudfront.ErrorResponse(
                    http_status=404,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=Duration.minutes(1),
                ),
            ],
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
        )
        return bucket, distribution

    def _deploy_frontend_assets(
        self,
        bucket,
        distribution,
        user_pool,
        user_pool_client,
    ):
        s3_deployment.BucketDeployment(
            self,
            "DeployFrontend",
            sources=[
                s3_deployment.Source.asset(str(ROOT / "frontend" / "dist")),
                s3_deployment.Source.json_data(
                    "config.json",
                    {
                        "apiUrl": self.api.url,
                        "userPoolId": user_pool.user_pool_id,
                        "userPoolClientId": user_pool_client.user_pool_client_id,
                    },
                ),
            ],
            destination_bucket=bucket,
            distribution=distribution,
            distribution_paths=["/*"] if distribution else None,
            prune=True,
            retain_on_delete=False,
        )

    def _log_group(self, function_name):
        return logs.LogGroup(
            self,
            f"{function_name.title().replace('-', '')}Logs",
            log_group_name=f"/aws/lambda/{function_name}",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

    def _lambda_role(self, role_name, log_group):
        role = iam.Role(
            self,
            f"{role_name.title().replace('-', '')}Role",
            role_name=role_name,
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["logs:CreateLogStream", "logs:PutLogEvents"],
                resources=[log_group.log_group_arn],
            )
        )
        return role

    def _create_tool_functions(self, tables):
        access = {
            "listar_catalogo": {"products": ["dynamodb:Scan"]},
            "registrar_intencao": {
                "products": ["dynamodb:GetItem"],
                "intents": ["dynamodb:PutItem"],
            },
            "realizar_compra": {
                "products": [
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:TransactWriteItems",
                ],
                "users": [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:TransactWriteItems",
                ],
                "intents": [
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:TransactWriteItems",
                ],
                "transactions": [
                    "dynamodb:PutItem",
                    "dynamodb:TransactWriteItems",
                ],
            },
            "consultar_historico_compras": {"transactions": ["dynamodb:Query"]},
        }
        functions = {}
        for tool_name, table_access in access.items():
            function_name = f"{PREFIX}-{tool_name.replace('_', '-')}"
            log_group = self._log_group(function_name)
            role = self._lambda_role(function_name, log_group)
            for table_name, actions in table_access.items():
                role.add_to_policy(
                    iam.PolicyStatement(
                        actions=actions,
                        resources=[tables[table_name].table_arn],
                    )
                )
            functions[tool_name] = lambda_.Function(
                self,
                f"{tool_name.title().replace('_', '')}Function",
                function_name=function_name,
                runtime=lambda_.Runtime.PYTHON_3_12,
                handler="handlers.lambda_handler",
                code=lambda_.Code.from_asset(
                    str(ROOT / "tools"),
                    exclude=["test_*.py", "seed_products.py", "create_user.py", "__pycache__"],
                ),
                timeout=Duration.seconds(30),
                memory_size=256,
                log_group=log_group,
                role=role,
                environment={
                    "TOOL_NAME": tool_name,
                    **{
                        f"{table_name.upper()}_TABLE": tables[table_name].table_name
                        for table_name in table_access
                    },
                },
            )
        return functions

    def _create_agent_runtime(self, tool_functions):
        image = ecr_assets.DockerImageAsset(
            self,
            "AgentImage",
            directory=str(ROOT / "agent"),
            platform=ecr_assets.Platform.LINUX_ARM64,
        )
        runtime_name = "FellowsCarlosEduardoChatPay"
        role = iam.Role(
            self,
            "AgentRuntimeRole",
            role_name=f"{PREFIX}-agent-runtime",
            assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        )
        account = self.account
        logs_arn = (
            f"arn:aws:logs:{REGION}:{account}:log-group:"
            f"/aws/bedrock-agentcore/runtimes/*"
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["logs:DescribeLogGroups"],
                resources=[f"arn:aws:logs:{REGION}:{account}:log-group:*"],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                ],
                resources=[logs_arn, f"{logs_arn}:log-stream:*"],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["ecr:GetAuthorizationToken"],
                resources=["*"],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "ecr:BatchCheckLayerAvailability",
                    "ecr:BatchGetImage",
                    "ecr:GetDownloadUrlForLayer",
                ],
                resources=[
                    f"arn:aws:ecr:{REGION}:{account}:repository/"
                    f"cdk-hnb659fds-container-assets-{account}-{REGION}"
                ],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=[
                    f"arn:aws:bedrock:*:{account}:inference-profile/{MODEL_ID}",
                    f"arn:aws:bedrock:*::foundation-model/{FOUNDATION_MODEL_ID}",
                ],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["lambda:InvokeFunction"],
                resources=[function.function_arn for function in tool_functions.values()],
            )
        )

        environment = {
            "BEDROCK_MODEL_ID": MODEL_ID,
        }
        environment.update({
            f"{tool_name.upper()}_FUNCTION_ARN": function.function_arn
            for tool_name, function in tool_functions.items()
        })
        runtime = CfnResource(
            self,
            "AgentRuntime",
            type="AWS::BedrockAgentCore::Runtime",
            properties={
                "AgentRuntimeName": runtime_name,
                "AgentRuntimeArtifact": {
                    "ContainerConfiguration": {"ContainerUri": image.image_uri},
                },
                "NetworkConfiguration": {"NetworkMode": "PUBLIC"},
                "ProtocolConfiguration": "HTTP",
                "RoleArn": role.role_arn,
                "EnvironmentVariables": environment,
                "Description": "ChatPay Strands agent for Carlos Eduardo",
                "Tags": {"Project": PREFIX, "Owner": "carlos-eduardo"},
            },
        )
        runtime.node.add_dependency(role)
        for function in tool_functions.values():
            runtime.node.add_dependency(function)
        return runtime

    def _create_chat_function(self, conversations_table, runtime_arn, frontend_origin):
        name = f"{PREFIX}-chat-api"
        log_group = self._log_group(name)
        role = self._lambda_role(name, log_group)
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["dynamodb:Query", "dynamodb:PutItem"],
                resources=[conversations_table.table_arn],
            )
        )
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeAgentRuntime"],
                resources=[runtime_arn, f"{runtime_arn}/*"],
            )
        )
        return lambda_.Function(
            self,
            "ChatApiFunction",
            function_name=name,
            runtime=lambda_.Runtime.NODEJS_22_X,
            handler="index.handler",
            code=lambda_.Code.from_asset(
                str(ROOT / "api"),
                exclude=["package-lock.json", "*.test.mjs"],
            ),
            timeout=Duration.minutes(15),
            memory_size=1024,
            log_group=log_group,
            role=role,
            environment={
                "CONVERSATIONS_TABLE": conversations_table.table_name,
                "AGENT_RUNTIME_ARN": runtime_arn,
                "ALLOWED_ORIGIN": frontend_origin,
            },
        )

    def _create_api(self, user_pool, chat_function, frontend_origin):
        self.api = apigateway.RestApi(
            self,
            "ChatApi",
            rest_api_name=f"{PREFIX}-webchat",
            endpoint_types=[apigateway.EndpointType.REGIONAL],
            deploy_options=apigateway.StageOptions(
                stage_name="prod",
                throttling_rate_limit=10,
                throttling_burst_limit=20,
            ),
            default_cors_preflight_options=apigateway.CorsOptions(
                allow_origins=[frontend_origin],
                allow_methods=["GET", "POST", "OPTIONS"],
                allow_headers=["Authorization", "Content-Type"],
                allow_credentials=False,
                max_age=Duration.minutes(10),
            ),
        )
        authorizer = apigateway.CognitoUserPoolsAuthorizer(
            self,
            "ChatCognitoAuthorizer",
            cognito_user_pools=[user_pool],
        )
        chat_resource = self.api.root.add_resource("chat")
        conversations_resource = self.api.root.add_resource("conversations")
        post_method = chat_resource.add_method(
            "POST",
            apigateway.LambdaIntegration(chat_function, proxy=True),
            authorization_type=apigateway.AuthorizationType.COGNITO,
            authorizer=authorizer,
        )
        get_method = conversations_resource.add_method(
            "GET",
            apigateway.LambdaIntegration(chat_function, proxy=True),
            authorization_type=apigateway.AuthorizationType.COGNITO,
            authorizer=authorizer,
        )

        for method in (post_method, get_method):
            cfn_method = method.node.default_child
            cfn_method.add_property_override(
                "Integration.Uri",
                Fn.sub(
                    "arn:aws:apigateway:${AWS::Region}:lambda:path/2021-11-15/"
                    "functions/${FunctionArn}/response-streaming-invocations",
                    {"FunctionArn": chat_function.function_arn},
                ),
            )
            cfn_method.add_property_override("Integration.ResponseTransferMode", "STREAM")
            cfn_method.add_property_override("Integration.TimeoutInMillis", 900000)

        cors_values = {
            "Access-Control-Allow-Origin": f"'{frontend_origin}'",
            "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
            "Access-Control-Allow-Methods": "'GET,POST,OPTIONS'",
        }
        for response_id, response_type in (
            ("UnauthorizedResponse", apigateway.ResponseType.UNAUTHORIZED),
            ("AccessDeniedResponse", apigateway.ResponseType.ACCESS_DENIED),
        ):
            self.api.add_gateway_response(
                response_id,
                type=response_type,
                response_headers=cors_values,
            )
