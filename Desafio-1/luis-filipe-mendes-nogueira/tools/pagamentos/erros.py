MENSAGENS_ERRO = {
    "INTENCAO_INVALIDA": (
        "Essa intenção de compra não existe ou não pertence a este usuário."
    ),
    "INTENCAO_JA_PAGA": (
        "Essa intenção já foi usada em uma compra anterior."
    ),
    "INTENCAO_EXPIRADA": (
        "Essa intenção de compra expirou. Registre uma nova intenção."
    ),
    "LIMITE_EXCEDIDO": (
        "O valor da compra excede o limite de gasto disponível "
        "para este usuário."
    ),
    "METODO_INVALIDO": (
        "Método de pagamento inválido. Use 'cartao' ou 'pix'."
    ),
    "VAGAS_INSUFICIENTES": (
        "Não há vagas suficientes disponíveis para este evento "
        "na quantidade solicitada."
    ),
    "ERRO_INTERNO": (
        "Ocorreu um erro inesperado ao processar a solicitação."
    ),
}


def criar_erro(codigo):
    return {
        "status": "recusado",
        "erro": codigo,
        "mensagem": MENSAGENS_ERRO[codigo],
    }