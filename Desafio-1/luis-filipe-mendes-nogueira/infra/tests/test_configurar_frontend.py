import importlib.util
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


CAMINHO = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "configurar_frontend.py"
)

SPEC = importlib.util.spec_from_file_location(
    "configurar_frontend_teste",
    CAMINHO,
)
modulo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(modulo)


def outputs():
    return {
        modulo.STACK: {
            "ApiUrl": "https://abc123.execute-api.us-east-1.amazonaws.com/",
            "ChatApiUrl": "https://def456.execute-api.us-east-1.amazonaws.com/prod/",
            "Region": "us-east-1",
            "UserPoolId": "us-east-1_teste",
            "UserPoolClientId": "cliente-teste",
        }
    }


class TestConfigurarFrontend(unittest.TestCase):
    def test_monta_config_com_as_duas_apis(self):
        config = modulo.montar_config(outputs())

        self.assertEqual(
            config["apiUrl"],
            "https://abc123.execute-api.us-east-1.amazonaws.com",
        )
        self.assertEqual(
            config["chatApiUrl"],
            "https://def456.execute-api.us-east-1.amazonaws.com/prod",
        )
        self.assertEqual(
            config["cognito"]["userPoolClientId"],
            "cliente-teste",
        )

    def test_recusa_url_fora_da_regiao_ou_host_esperado(self):
        for endereco in (
            "http://def456.execute-api.us-east-1.amazonaws.com/prod",
            "https://def456.execute-api.us-west-2.amazonaws.com/prod",
            "https://example.com/prod",
        ):
            dados = outputs()
            dados[modulo.STACK]["ChatApiUrl"] = endereco

            with self.assertRaises(ValueError):
                modulo.montar_config(dados)

    def test_recusa_outputs_incompletos(self):
        dados = deepcopy(outputs())
        del dados[modulo.STACK]["ChatApiUrl"]

        with self.assertRaises(ValueError):
            modulo.montar_config(dados)

    def test_atualiza_public_e_exportacao(self):
        with tempfile.TemporaryDirectory() as temporario:
            raiz = Path(temporario)
            arquivo = raiz / "outputs.json"
            arquivo.write_text(json.dumps(outputs()), encoding="utf-8")

            (raiz / "frontend" / "out").mkdir(parents=True)

            config = modulo.atualizar(arquivo, raiz)

            for pasta in ("public", "out"):
                publicado = json.loads(
                    (raiz / "frontend" / pasta / "config.json")
                    .read_text(encoding="utf-8")
                )
                self.assertEqual(publicado, config)


if __name__ == "__main__":
    unittest.main()
