import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_DEPLOY = Path(__file__).resolve().parents[1] / "deploy.sh"


class TestDeploy(unittest.TestCase):
    def executar_com_stubs(self, falha_pacote):
        # Todos os executáveis são substituídos antes de executar a cópia.
        # Não roda pip/CDK reais e não acessa AWS.
        with tempfile.TemporaryDirectory() as temporario:
            diretorio = Path(temporario)
            executaveis = diretorio / "bin"
            executaveis.mkdir()
            ativacao = diretorio / ".venv" / "bin" / "activate"
            ativacao.parent.mkdir(parents=True)
            ativacao.write_text("# Ambiente isolado de teste.\n")
            shutil.copyfile(SCRIPT_DEPLOY, diretorio / "deploy.sh")
            comandos = {
                "node": '#!/bin/bash\necho 24\n',
                "python": (
                    '#!/bin/bash\nprintf "python:%s\\n" "$*" >> "$REGISTRO_TESTE"\n'
                    'case "$1" in\n'
                    '  */empacotar_agent.py) exit "$FALHA_PACOTE" ;;\n'
                    'esac\n'
                ),
                "cdk": (
                    '#!/bin/bash\nprintf "cdk:%s\\n" "$*" >> "$REGISTRO_TESTE"\n'
                ),
            }
            for nome, conteudo in comandos.items():
                caminho = executaveis / nome
                caminho.write_text(conteudo)
                caminho.chmod(0o755)
            registro = diretorio / "chamadas.txt"
            ambiente = {
                **os.environ,
                "PATH": f"{executaveis}:{os.environ['PATH']}",
                "REGISTRO_TESTE": str(registro),
                "FALHA_PACOTE": str(falha_pacote),
            }
            resultado = subprocess.run(
                ["bash", str(diretorio / "deploy.sh"), "perfil-teste"],
                env=ambiente,
                capture_output=True,
                text=True,
                check=False,
            )
            return resultado, registro.read_text().splitlines()

    def test_falha_no_pacote_impede_deploy_e_seed(self):
        resultado, chamadas = self.executar_com_stubs(falha_pacote=9)
        self.assertEqual(resultado.returncode, 9)
        self.assertEqual(len(chamadas), 1)
        self.assertTrue(chamadas[0].endswith("scripts/empacotar_agent.py"))

    def test_publicacao_ocorre_depois_do_pacote_e_antes_do_seed(self):
        resultado, chamadas = self.executar_com_stubs(falha_pacote=0)
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertEqual(len(chamadas), 3)
        self.assertTrue(chamadas[0].endswith("scripts/empacotar_agent.py"))
        self.assertTrue(chamadas[1].startswith("cdk:deploy "))
        self.assertIn("--profile perfil-teste", chamadas[1])
        self.assertIn("--outputs-file", chamadas[1])
        self.assertIn("scripts/seed_catalogo.py", chamadas[2])


if __name__ == "__main__":
    unittest.main()
