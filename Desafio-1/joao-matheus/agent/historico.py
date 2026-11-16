def converter(historico: list) -> list[dict]:
    """Converte o histórico da aplicação em mensagens compatíveis com o Bedrock/Strands.

    Regras aplicadas:
    1. Filtra entradas com campos válidos e texto não-vazio.
    2. Descarta mensagens anteriores até que a primeira seja do papel 'user' (exigência Bedrock).
    3. Mescla mensagens consecutivas com o mesmo papel.
    4. Limita às últimas 30 mensagens mantendo início por 'user'.
    5. Formata no padrão: {'role': 'user'|'assistant', 'content': [{'text': '...'}]}.
    """
    if not isinstance(historico, list):
        return []

    # 1. Filtra itens com formato válido e texto não vazio
    mensagens_validas = []
    for item in historico:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        texto = item.get("texto")
        if role not in ["user", "assistant"] or not isinstance(texto, str) or not texto.strip():
            continue
        mensagens_validas.append({
            "role": role,
            "texto": texto.strip(),
        })

    # 2. Descartar mensagens anteriores até encontrar a primeira mensagem com role "user"
    inicio = 0
    while inicio < len(mensagens_validas) and mensagens_validas[inicio]["role"] != "user":
        inicio += 1
    mensagens_filtradas = mensagens_validas[inicio:]

    # 3. Mesclar mensagens consecutivas do mesmo papel
    mescladas = []
    for m in mensagens_filtradas:
        if mescladas and mescladas[-1]["role"] == m["role"]:
            mescladas[-1]["texto"] += f"\n{m['texto']}"
        else:
            mescladas.append(m.copy())

    # 4. Limitar às últimas 30 mensagens mantendo início por "user"
    if len(mescladas) > 30:
        mescladas = mescladas[-30:]
        if mescladas and mescladas[0]["role"] != "user":
            mescladas = mescladas[1:]

    # 5. Formatar no padrão Message do Bedrock / Strands
    return [
        {
            "role": m["role"],
            "content": [{"text": m["texto"]}],
        }
        for m in mescladas
    ]
