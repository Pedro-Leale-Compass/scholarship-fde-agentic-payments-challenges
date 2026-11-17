import os
import json
import functools
from decimal import Decimal
from datetime import datetime, timezone
import boto3

class UsuarioNaoAutenticadoErro(Exception):
    """Exceção levantada quando usuario_id está ausente ou inválido no evento."""
    pass

def obter_dynamodb_resource():
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    return boto3.resource("dynamodb", region_name=region)

def obter_dynamodb_client():
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    return boto3.client("dynamodb", region_name=region)

def tabela(env_var: str):
    nome_tabela = os.environ[env_var]
    return obter_dynamodb_resource().Table(nome_tabela)

def recusa(codigo: str, mensagem: str) -> dict:
    return {
        "status": "recusado",
        "codigo": codigo,
        "mensagem": mensagem,
    }

def agora_utc() -> datetime:
    return datetime.now(timezone.utc)

def para_json(obj):
    if isinstance(obj, list):
        return [para_json(item) for item in obj]
    if isinstance(obj, dict):
        return {chave: para_json(valor) for chave, valor in obj.items()}
    if isinstance(obj, Decimal):
        return float(round(obj, 2))
    return obj

def extrair_evento(event) -> tuple[str, dict]:
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except Exception:
            event = {}

    if not isinstance(event, dict):
        raise UsuarioNaoAutenticadoErro("Evento em formato inválido.")

    usuario_id = event.get("usuario_id")
    if not usuario_id or not isinstance(usuario_id, str) or not usuario_id.strip():
        raise UsuarioNaoAutenticadoErro("Usuário não autenticado.")

    argumentos = event.get("argumentos", {})
    if not isinstance(argumentos, dict):
        argumentos = {}

    return usuario_id.strip(), argumentos

def registrar_auditoria(tool: str, usuario_id: str, argumentos: dict, resultado: dict):
    registro = {
        "auditoria": True,
        "tool": tool,
        "usuario_id": usuario_id,
        "argumentos": argumentos,
        "resultado": {
            "status": resultado.get("status") if isinstance(resultado, dict) else "desconhecido",
            "codigo": resultado.get("codigo") if isinstance(resultado, dict) else None,
        },
    }
    print(json.dumps(registro, default=str))

def tratar_erros(tool_name: str):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(event, context=None):
            usuario_id = "desconhecido"
            argumentos = {}
            try:
                if isinstance(event, str):
                    try:
                        e = json.loads(event)
                    except Exception:
                        e = {}
                elif isinstance(event, dict):
                    e = event
                else:
                    e = {}

                u = e.get("usuario_id")
                if isinstance(u, str) and u.strip():
                    usuario_id = u.strip()
                if isinstance(e.get("argumentos"), dict):
                    argumentos = e.get("argumentos")

                resultado = func(event, context)
                registrar_auditoria(tool_name, usuario_id, argumentos, resultado)
                return para_json(resultado)

            except UsuarioNaoAutenticadoErro as err:
                res = recusa("USUARIO_NAO_AUTENTICADO", str(err) or "Usuário não autenticado.")
                registrar_auditoria(tool_name, usuario_id, argumentos, res)
                return res

            except Exception as exc:
                erro_log = {
                    "erro": True,
                    "tool": tool_name,
                    "usuario_id": usuario_id,
                    "tipo_erro": type(exc).__name__,
                    "mensagem": str(exc),
                }
                print(json.dumps(erro_log, default=str))
                res = recusa("ERRO_INTERNO", "Não foi possível processar a solicitação agora.")
                registrar_auditoria(tool_name, usuario_id, argumentos, res)
                return res

        return wrapper
    return decorator
