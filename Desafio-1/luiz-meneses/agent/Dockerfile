# AgentCore Runtime exige imagem ARM64 que escute na porta 8080 (/invocations e /ping).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ENV PYTHONUNBUFFERED=1
COPY app.py .
RUN useradd -m agente
USER agente
EXPOSE 8080
CMD ["python", "app.py"]
