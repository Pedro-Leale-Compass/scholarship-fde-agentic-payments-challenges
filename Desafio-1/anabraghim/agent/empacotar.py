"""Gera o zip do agente para o AgentCore Runtime (Linux ARM64, Python 3.12).

    python agent/empacotar.py <diretorio_de_saida>

- Instala as dependências de requirements.lock como wheels manylinux aarch64,
  independente do sistema de quem roda (Windows, macOS ou Linux x86).
- Copia main.py e o pacote agente/ para a raiz do zip.
- O zip é determinístico (ordem e datas fixas). A última linha impressa é o
  SHA-256 do zip, usado pelo deploy.sh como nome do objeto no S3: sem mudança
  de código ou de dependência, o runtime não é atualizado.

Só acessa o PyPI. Não chama a AWS.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

RAIZ_AGENTE = Path(__file__).resolve().parent
DATA_FIXA = (2020, 1, 1, 0, 0, 0)
IGNORAR = {"__pycache__", ".pytest_cache"}


def instalar_dependencias(destino: Path) -> None:
    subprocess.run(
        [
            sys.executable, "-m", "pip", "install",
            "--quiet", "--disable-pip-version-check", "--no-compile",
            "--platform", "manylinux2014_aarch64",
            "--implementation", "cp",
            "--python-version", "3.12",
            "--only-binary=:all:",
            "--target", str(destino),
            # Lock já resolvido para Linux: o pip avalia marcadores (ex.: sys_platform)
            # pelo sistema local, então resolver aqui no Windows puxaria pywin32.
            "--no-deps", "--require-hashes",
            "-r", str(RAIZ_AGENTE / "requirements.lock"),
        ],
        check=True,
    )
    # Scripts de console (no Windows, .exe com caminho embutido): inúteis no runtime e
    # diferentes a cada build, o que quebraria o hash determinístico.
    shutil.rmtree(destino / "bin", ignore_errors=True)
    for record in destino.glob("*.dist-info/RECORD"):
        linhas = record.read_text(encoding="utf-8").splitlines(keepends=True)
        record.write_text("".join(l for l in linhas if not l.startswith("../../bin/")), encoding="utf-8")


def copiar_codigo(destino: Path) -> None:
    shutil.copy2(RAIZ_AGENTE / "main.py", destino / "main.py")
    shutil.copytree(RAIZ_AGENTE / "agente", destino / "agente", ignore=shutil.ignore_patterns(*IGNORAR))


def zipar(origem: Path, arquivo_zip: Path) -> None:
    arquivos = sorted(
        p for p in origem.rglob("*") if p.is_file() and not IGNORAR.intersection(p.relative_to(origem).parts)
    )
    with zipfile.ZipFile(arquivo_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for caminho in arquivos:
            info = zipfile.ZipInfo(caminho.relative_to(origem).as_posix(), date_time=DATA_FIXA)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, caminho.read_bytes())


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("uso: python agent/empacotar.py <diretorio_de_saida>")
    saida = Path(sys.argv[1]).resolve()
    pacote = saida / "pacote"
    if saida.exists():
        shutil.rmtree(saida)
    pacote.mkdir(parents=True)

    instalar_dependencias(pacote)
    copiar_codigo(pacote)

    arquivo_zip = saida / "agente.zip"
    zipar(pacote, arquivo_zip)
    print(hashlib.sha256(arquivo_zip.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
