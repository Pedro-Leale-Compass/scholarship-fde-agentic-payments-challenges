import hashlib
import json
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


RAIZ = Path(__file__).resolve().parents[2]
DIRETORIO_AGENT = RAIZ / "agent"
DIRETORIO_SAIDA = DIRETORIO_AGENT / "dist"

ARQUIVOS_AGENT = (
    "runtime.py",
    "agente.py",
    "ferramentas.py",
    "prompt.py",
)

LIMITE_ZIP = 250 * 1024 * 1024
LIMITE_DESCOMPACTADO = 750 * 1024 * 1024


def verificar_arquitetura(caminho):
    # Bibliotecas ELF para AArch64 usam e_machine = 183.
    with caminho.open("rb") as arquivo:
        cabecalho = arquivo.read(20)

    if cabecalho[:4] != b"\x7fELF":
        return

    ordem = "little" if cabecalho[5] == 1 else "big"
    arquitetura = int.from_bytes(cabecalho[18:20], ordem)

    if arquitetura != 183:
        raise RuntimeError(
            f"Biblioteca incompatível com ARM64: {caminho.name}"
        )


def criar_zip(diretorio, destino):
    arquivos = sorted(
        caminho
        for caminho in diretorio.rglob("*")
        if caminho.is_file()
        and "__pycache__" not in caminho.parts
        and caminho.suffix != ".pyc"
    )

    tamanho = sum(caminho.stat().st_size for caminho in arquivos)

    if tamanho > LIMITE_DESCOMPACTADO:
        raise RuntimeError(
            "O pacote excede o limite descompactado do AgentCore."
        )

    with ZipFile(destino, "w", compression=ZIP_DEFLATED) as pacote:
        for caminho in arquivos:
            verificar_arquitetura(caminho)

            nome = caminho.relative_to(diretorio).as_posix()

            # Data e permissões fixas evitam mudanças artificiais no ZIP.
            informacao = ZipInfo(
                filename=nome,
                date_time=(2020, 1, 1, 0, 0, 0),
            )
            informacao.create_system = 3
            informacao.compress_type = ZIP_DEFLATED

            modo = 0o755 if caminho.stat().st_mode & 0o111 else 0o644
            informacao.external_attr = (stat.S_IFREG | modo) << 16

            pacote.writestr(informacao, caminho.read_bytes())

    if destino.stat().st_size > LIMITE_ZIP:
        raise RuntimeError(
            "O ZIP excede o limite de 250 MB do AgentCore."
        )

    return tamanho


def main():
    for nome in ARQUIVOS_AGENT:
        if not (DIRETORIO_AGENT / nome).is_file():
            raise FileNotFoundError(f"Arquivo obrigatório ausente: {nome}")

    DIRETORIO_SAIDA.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="agentcore-build-") as temporario:
        trabalho = Path(temporario)
        dependencias = trabalho / "pacote"
        relatorio = trabalho / "pip-report.json"
        zip_temporario = trabalho / "agentcore.zip"

        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--requirement",
                str(DIRETORIO_AGENT / "requirements.txt"),
                "--target",
                str(dependencias),
                "--platform",
                "manylinux2014_aarch64",
                "--implementation",
                "cp",
                "--python-version",
                "3.13",
                "--abi",
                "cp313",
                "--abi",
                "abi3",
                "--abi",
                "none",
                "--only-binary=:all:",
                "--ignore-installed",
                "--no-compile",
                "--report",
                str(relatorio),
            ],
            check=True,
        )

        for nome in ARQUIVOS_AGENT:
            shutil.copyfile(
                DIRETORIO_AGENT / nome,
                dependencias / nome,
            )

        tamanho_descompactado = criar_zip(
            dependencias,
            zip_temporario,
        )

        # Só substitui o pacote anterior após construir e verificar o novo.
        destino = DIRETORIO_SAIDA / "agentcore.zip"
        shutil.copyfile(zip_temporario, destino)

        dados = json.loads(relatorio.read_text(encoding="utf-8"))
        versoes = sorted(
            (
                {
                    "nome": item["metadata"]["name"],
                    "versao": item["metadata"]["version"],
                }
                for item in dados["install"]
            ),
            key=lambda item: item["nome"].lower(),
        )

        (DIRETORIO_SAIDA / "dependencias.json").write_text(
            json.dumps(versoes, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        with destino.open("rb") as arquivo:
            checksum = hashlib.file_digest(arquivo, "sha256").hexdigest()

        resumo = {
            "arquivo": str(destino),
            "arquitetura": "arm64",
            "python": "3.13",
            "tamanho_zip_mb": round(
                destino.stat().st_size / 1024 / 1024, 2
            ),
            "tamanho_descompactado_mb": round(
                tamanho_descompactado / 1024 / 1024, 2
            ),
            "sha256": checksum,
        }

        print(json.dumps(resumo, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
