import aws_cdk as cdk

from infra.infra_stack import InfraStack

app = cdk.App()

InfraStack(
    app,
    "henrick-desafio-1",
    env=cdk.Environment(account="296155107950", region="us-east-1"),
)

app.synth()