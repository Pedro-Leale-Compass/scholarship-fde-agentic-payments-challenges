import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_DEPLOY = Path(__file__).resolve().parents[1] / "deploy.sh"


class TestDeploy(unittest.TestCase):
    def executar_com_stubs(self, falha=""):
        with tempfile.TemporaryDirectory() as temporario:
            raiz = Path(temporario)
            infra = raiz / "infra"
            infra.mkdir()

            executaveis = raiz / "bin"
            executaveis.mkdir()

            ativacao = infra / ".venv" / "bin" / "activate"
            ativacao.parent.mkdir(parents=True)
            ativacao.write_text("# Ambiente de teste.\n")

            shutil.copyfile(SCRIPT_DEPLOY, infra / "deploy.sh")

            comandos = {
                "node": "#!/bin/bash\necho 24\n",
                "npm": r"""#!/bin/bash
printf 'npm:%s\n' "$*" >> "$REGISTRO_TESTE"
if [[ "$FALHA_ETAPA" == "chat-teste" && "$*" == *"/api/chat test" ]]; then
  exit 9
fi
if [[ "$FALHA_ETAPA" == "chat-build" && "$*" == *"/api/chat run build" ]]; then
  exit 9
fi
""",
                "python": r"""#!/bin/bash
printf 'python:%s\n' "$*" >> "$REGISTRO_TESTE"
if [[ "$FALHA_ETAPA" == "pacote" && "$1" == */empacotar_agent.py ]]; then
  exit 9
fi
""",
                "cdk": r"""#!/bin/bash
printf 'cdk:%s\n' "$*" >> "$REGISTRO_TESTE"
if [[ "$FALHA_ETAPA" == "deploy" ]]; then
  exit 9
fi
""",
            }

            for nome, conteudo in comandos.items():
                caminho = executaveis / nome
                caminho.write_text(conteudo)
                caminho.chmod(0o755)

            registro = raiz / "chamadas.txt"

            resultado = subprocess.run(
                ["bash", str(infra / "deploy.sh"), "perfil-teste"],
                env={
                    **os.environ,
                    "PATH": f"{executaveis}:{os.environ['PATH']}",
                    "REGISTRO_TESTE": str(registro),
                    "FALHA_ETAPA": falha,
                },
                capture_output=True,
                text=True,
                check=False,
            )

            chamadas = (
                registro.read_text().splitlines()
                if registro.exists()
                else []
            )

            return resultado, chamadas

    def test_falha_no_teste_do_chat_impede_publicacao(self):
        resultado, chamadas = self.executar_com_stubs("chat-teste")

        self.assertEqual(resultado.returncode, 9)
        self.assertEqual(len(chamadas), 2)
        self.assertFalse(any(c.startswith("cdk:") for c in chamadas))

    def test_falha_no_build_do_chat_impede_publicacao(self):
        resultado, chamadas = self.executar_com_stubs("chat-build")

        self.assertEqual(resultado.returncode, 9)
        self.assertEqual(len(chamadas), 3)
        self.assertFalse(any(c.startswith("cdk:") for c in chamadas))

    def test_falha_no_pacote_impede_deploy_e_seed(self):
        resultado, chamadas = self.executar_com_stubs("pacote")

        self.assertEqual(resultado.returncode, 9)
        self.assertEqual(len(chamadas), 4)
        self.assertIn("empacotar_agent.py", chamadas[-1])
        self.assertFalse(any(c.startswith("cdk:") for c in chamadas))

    def test_falha_no_deploy_impede_seed_e_configuracao(self):
        resultado, chamadas = self.executar_com_stubs("deploy")

        self.assertEqual(resultado.returncode, 9)
        self.assertEqual(len(chamadas), 5)
        self.assertTrue(chamadas[-1].startswith("cdk:deploy "))
        self.assertFalse(any("seed_catalogo.py" in c for c in chamadas))
        self.assertFalse(any("configurar_frontend.py" in c for c in chamadas))

    def test_publicacao_respeita_ordem_e_perfil(self):
        resultado, chamadas = self.executar_com_stubs()

        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertEqual(len(chamadas), 10)

        self.assertIn("/api/chat ci --include=dev", chamadas[0])
        self.assertIn("/api/chat test", chamadas[1])
        self.assertIn("/api/chat run build", chamadas[2])
        self.assertIn("empacotar_agent.py", chamadas[3])
        self.assertTrue(chamadas[4].startswith("cdk:deploy "))
        self.assertIn("--profile perfil-teste", chamadas[4])
        self.assertIn("--outputs-file", chamadas[4])
        self.assertIn("seed_catalogo.py", chamadas[5])
        self.assertIn("configurar_frontend.py", chamadas[6])
        self.assertIn("/frontend ci --include=dev", chamadas[7])
        self.assertIn("/frontend test", chamadas[8])
        self.assertIn("/frontend run build", chamadas[9])


if __name__ == "__main__":
    unittest.main()
