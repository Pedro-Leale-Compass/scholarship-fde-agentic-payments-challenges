import tempfile
import unittest
from pathlib import Path

from aws_cdk import (
    App,
    Environment,
    Stack,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
)
from aws_cdk.assertions import Template

from infra.chat import criar_chat


class TestChat(unittest.TestCase):
    def test_api_protegida_streaming_e_permissoes(self):
        with tempfile.TemporaryDirectory() as diretorio:
            raiz = Path(diretorio)
            codigo = raiz / "api" / "chat" / "dist"
            codigo.mkdir(parents=True)
            (codigo / "index.mjs").write_text(
                "export const handler = () => {};",
                encoding="utf-8",
            )

            app = App()
            stack = Stack(
                app,
                "TesteChat",
                env=Environment(
                    account="631570928305",
                    region="us-east-1",
                ),
            )

            tabela = dynamodb.Table(
                stack,
                "Conversas",
                partition_key=dynamodb.Attribute(
                    name="usuario_id",
                    type=dynamodb.AttributeType.STRING,
                ),
                sort_key=dynamodb.Attribute(
                    name="registro_id",
                    type=dynamodb.AttributeType.STRING,
                ),
            )

            pool = cognito.UserPool(stack, "Pool")
            cliente = pool.add_client("Frontend")

            arn = (
                "arn:aws:bedrock-agentcore:us-east-1:"
                "631570928305:runtime/"
                "luis_filipe_mendes_nogueira_agent-teste"
            )

            criar_chat(
                stack=stack,
                prefixo="luis-filipe-mendes-nogueira",
                raiz_projeto=raiz,
                tabela_conversas=tabela,
                user_pool=pool,
                app_client=cliente,
                arn_runtime=arn,
            )

            template = Template.from_stack(stack)

            funcoes = template.find_resources(
                "AWS::Lambda::Function"
            )
            self.assertEqual(len(funcoes), 1)

            funcao = next(iter(funcoes.values()))["Properties"]
            self.assertEqual(funcao["Runtime"], "nodejs24.x")
            self.assertEqual(funcao["Timeout"], 120)

            metodos = template.find_resources(
                "AWS::ApiGateway::Method"
            )

            protegidos = [
                recurso["Properties"]
                for recurso in metodos.values()
                if recurso["Properties"]["HttpMethod"] != "OPTIONS"
            ]

            self.assertEqual(len(protegidos), 4)

            for metodo in protegidos:
                self.assertEqual(
                    metodo["AuthorizationType"],
                    "COGNITO_USER_POOLS",
                )
                self.assertEqual(
                    metodo["AuthorizationScopes"],
                    ["aws.cognito.signin.user.admin"],
                )
                self.assertEqual(
                    metodo["Integration"]["Type"],
                    "AWS_PROXY",
                )
                self.assertEqual(
                    metodo["Integration"]["ResponseTransferMode"],
                    "STREAM",
                )
                self.assertEqual(
                    metodo["Integration"]["TimeoutInMillis"],
                    120000,
                )
                self.assertIn(
                    "response-streaming-invocations",
                    str(metodo["Integration"]["Uri"]),
                )

            statements = [
                statement
                for recurso in template.find_resources(
                    "AWS::IAM::Policy"
                ).values()
                for statement in recurso["Properties"][
                    "PolicyDocument"
                ]["Statement"]
            ]

            acoes = {
                acao
                for statement in statements
                for acao in (
                    statement["Action"]
                    if isinstance(statement["Action"], list)
                    else [statement["Action"]]
                )
            }

            self.assertIn(
                "bedrock-agentcore:InvokeAgentRuntime",
                acoes,
            )
            self.assertIn(
                "bedrock-agentcore:StopRuntimeSession",
                acoes,
            )
            self.assertNotIn("lambda:InvokeFunction", acoes)
            self.assertNotIn("bedrock:InvokeModel", acoes)
            self.assertNotIn("dynamodb:Scan", acoes)
            self.assertNotIn("*", acoes)


if __name__ == "__main__":
    unittest.main()
