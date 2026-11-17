import json
from fnmatch import fnmatchcase
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from aws_cdk import App, Environment, Stack
from aws_cdk.assertions import Template

from infra.agentcore import criar_runtime


RAIZ_INFRA = Path(__file__).resolve().parents[1]
PREFIXO = "luis-filipe-mendes-nogueira"
NOME_RUNTIME = "luis_filipe_mendes_nogueira_agent"
CONTA = "631570928305"
FUNCOES = {
    nome: f"arn:aws:lambda:us-east-1:{CONTA}:function:{PREFIXO}-{sufixo}"
    for nome, sufixo in (
        ("listar_catalogo", "listar-catalogo"),
        ("registrar_intencao", "registrar-intencao"),
        ("realizar_compra", "realizar-compra"),
    )
}


class TestAgentCore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporario = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporario.cleanup)
        diretorio = Path(cls.temporario.name)
        pacote = diretorio / "agentcore.zip"
        with ZipFile(pacote, "w") as arquivo:
            arquivo.writestr("runtime.py", "# Fixture local; não será publicada.\n")

        cls.app = App(
            outdir=str(diretorio / "cdk.out"),
            context={"@aws-cdk/core:enablePartitionLiterals": True},
        )
        cls.stack = Stack(
            cls.app,
            "TesteAgentCore",
            env=Environment(account=CONTA, region="us-east-1"),
        )
        criar_runtime(cls.stack, PREFIXO, pacote, FUNCOES)
        cls.template = Template.from_stack(cls.stack)
        cls.recursos = cls.template.to_json()["Resources"]
        cls.runtime = cls.template.find_resources(
            "AWS::BedrockAgentCore::Runtime"
        )["AgentCoreRuntime"]
        politica = next(iter(cls.template.find_resources("AWS::IAM::Policy").values()))
        cls.statements = {
            item["Sid"]: item
            for item in politica["Properties"]["PolicyDocument"]["Statement"]
        }
        documento = json.loads(
            (RAIZ_INFRA / "policies" / "cloudformation-execution.json").read_text()
        )
        cls.politica_deploy = documento
        cls.permissoes_deploy = {
            item["Sid"]: item for item in documento["Statement"]
        }

    def test_runtime_usa_zip_python_e_identidade_iam(self):
        propriedades = self.runtime["Properties"]
        configuracao = propriedades["AgentRuntimeArtifact"]["CodeConfiguration"]
        self.assertEqual(configuracao["Runtime"], "PYTHON_3_13")
        self.assertEqual(configuracao["EntryPoint"], ["runtime.py"])
        self.assertIn("S3", configuracao["Code"])
        self.assertNotIn("AuthorizerConfiguration", propriedades)
        self.assertEqual(propriedades["Tags"]["Projeto"], PREFIXO)
        self.assertEqual(
            propriedades["LifecycleConfiguration"],
            {"IdleRuntimeSessionTimeout": 60, "MaxLifetime": 900},
        )
        self.assertEqual(self.runtime["DeletionPolicy"], "Delete")
        self.assertTrue(self.runtime["DependsOn"])

    def test_role_tem_somente_as_tres_lambdas(self):
        item = self.statements["InvocarFerramentas"]
        self.assertEqual(item["Action"], "lambda:InvokeFunction")
        self.assertEqual(set(item["Resource"]), set(FUNCOES.values()))
        valores = self.runtime["Properties"]["EnvironmentVariables"]
        self.assertEqual(set(valores.values()), set(FUNCOES.values()))

    def test_modelo_so_pode_ser_invocado_pelo_perfil_haiku(self):
        perfil = self.statements["InvocarPerfilHaiku"]["Resource"]
        self.assertTrue(perfil.endswith(
            "inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"
        ))
        item = self.statements["HaikuSomentePeloPerfil"]
        self.assertEqual(
            item["Condition"]["StringEquals"]["bedrock:InferenceProfileArn"],
            perfil,
        )
        self.assertEqual(len(item["Resource"]), 3)
        for regiao in ("us-east-1", "us-east-2", "us-west-2"):
            self.assertIn(
                f"arn:aws:bedrock:{regiao}::foundation-model/"
                "anthropic.claude-haiku-4-5-20251001-v1:0",
                item["Resource"],
            )

    def test_role_nao_recebe_wildcard_global_nem_acesso_direto_ao_banco(self):
        for item in self.statements.values():
            recursos = item["Resource"]
            recursos = recursos if isinstance(recursos, list) else [recursos]
            self.assertNotIn("*", recursos)
            acoes = item["Action"]
            acoes = acoes if isinstance(acoes, list) else [acoes]
            self.assertFalse(any("*" in acao for acao in acoes))
            self.assertFalse(any(acao.startswith("dynamodb:") for acao in acoes))

    def test_trust_limita_conta_e_runtime(self):
        role = next(iter(self.template.find_resources("AWS::IAM::Role").values()))
        trust = role["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(
            trust["Principal"]["Service"], "bedrock-agentcore.amazonaws.com"
        )
        self.assertEqual(trust["Condition"]["StringEquals"]["aws:SourceAccount"], CONTA)
        self.assertEqual(
            trust["Condition"]["ArnLike"]["aws:SourceArn"],
            f"arn:aws:bedrock-agentcore:us-east-1:{CONTA}:runtime/{NOME_RUNTIME}-*",
        )

    def test_logs_tem_retencao_e_remocao_definidas(self):
        grupo = next(iter(self.template.find_resources("AWS::Logs::LogGroup").values()))
        self.assertEqual(grupo["Properties"]["RetentionInDays"], 7)
        self.assertEqual(grupo["DeletionPolicy"], "Delete")

    def test_unica_excecao_global_e_criacao_condicionada(self):
        globais = [
            item for item in self.politica_deploy["Statement"]
            if item["Resource"] == "*" or item["Resource"] == ["*"]
        ]
        self.assertEqual(len(globais), 1)
        self.assertEqual(globais[0]["Action"], "bedrock-agentcore:CreateAgentRuntime")
        self.assertEqual(globais[0]["Condition"]["StringEquals"], {
            "aws:RequestedRegion": "us-east-1",
            "aws:RequestTag/Projeto": PREFIXO,
        })
        self.assertLessEqual(
            len(json.dumps(self.politica_deploy, separators=(",", ":"))), 6144
        )

    def test_passrole_do_runtime_e_exato_e_restrito_ao_servico(self):
        item = self.permissoes_deploy["PassarRoleDoAgentCore"]
        self.assertEqual(item["Action"], "iam:PassRole")
        self.assertEqual(
            item["Resource"], f"arn:aws:iam::{CONTA}:role/{PREFIXO}-agentcore-role"
        )
        self.assertEqual(item["Condition"]["StringEquals"], {
            "iam:PassedToService": "bedrock-agentcore.amazonaws.com"
        })

    def test_gerenciamento_inclui_endpoint_e_exclui_outros_runtimes(self):
        item = self.permissoes_deploy["GerenciarRuntimeDoProjeto"]
        self.assertEqual(
            item["Resource"],
            f"arn:aws:bedrock-agentcore:us-east-1:{CONTA}:runtime/{NOME_RUNTIME}-*",
        )
        self.assertIn("bedrock-agentcore:CreateAgentRuntimeEndpoint", item["Action"])
        self.assertIn("bedrock-agentcore:DeleteAgentRuntimeEndpoint", item["Action"])
        self.assertNotIn("bedrock-agentcore:InvokeAgentRuntime", item["Action"])

    def test_criacao_cobre_arn_do_endpoint_antes_de_existir_runtime_id(self):
        # ARN real da verificação dependente em CreateAgentRuntime, obtido
        # no responseElements.message do CloudTrail em 2026-11-16.
        recurso_avaliado = f"arn:aws:bedrock-agentcore:us-east-1:{CONTA}:runtime/*"
        correspondencias = []
        for item in self.politica_deploy["Statement"]:
            acoes = item["Action"]
            acoes = acoes if isinstance(acoes, list) else [acoes]
            recursos = item["Resource"]
            recursos = recursos if isinstance(recursos, list) else [recursos]
            if "bedrock-agentcore:CreateAgentRuntimeEndpoint" in acoes and any(
                fnmatchcase(recurso_avaliado, recurso) for recurso in recursos
            ):
                correspondencias.append(item)
        self.assertEqual(len(correspondencias), 1)
        self.assertEqual(set(correspondencias[0]["Action"]), {
            "bedrock-agentcore:CreateAgentRuntimeEndpoint",
            "bedrock-agentcore:TagResource",
        })
        self.assertEqual(
            correspondencias[0]["Condition"]["StringEquals"],
            {
                "aws:RequestedRegion": "us-east-1",
                "aws:RequestTag/Projeto": PREFIXO,
            },
        )

    def test_role_de_servico_aws_nao_pode_ser_editada_ou_excluida(self):
        item = self.permissoes_deploy["CriarRoleDeServicoDeIdentidadeAgentCore"]
        self.assertEqual(item["Action"], "iam:CreateServiceLinkedRole")
        self.assertEqual(item["Condition"]["StringEquals"], {
            "iam:AWSServiceName": "runtime-identity.bedrock-agentcore.amazonaws.com"
        })
        self.assertNotIn("*", item["Resource"])

    def test_tags_da_identidade_nao_abrem_diretorio_compartilhado(self):
        item = self.permissoes_deploy["EtiquetarIdentidadeDoRuntime"]
        self.assertEqual(item["Action"], "bedrock-agentcore:TagResource")
        self.assertEqual(
            item["Resource"],
            f"arn:aws:bedrock-agentcore:us-east-1:{CONTA}:"
            f"workload-identity-directory/default/workload-identity/{NOME_RUNTIME}*",
        )

    def test_tag_do_diretorio_exige_tag_do_projeto_e_arn_exato(self):
        item = self.permissoes_deploy["TagsDiretorioNaCriacao"]
        self.assertEqual(item["Action"], "bedrock-agentcore:TagResource")
        self.assertEqual(
            item["Resource"],
            f"arn:aws:bedrock-agentcore:us-east-1:{CONTA}:workload-identity-directory/default",
        )
        self.assertEqual(item["Condition"]["StringEquals"], {
            "aws:RequestTag/Projeto": PREFIXO,
        })


if __name__ == "__main__":
    unittest.main()
