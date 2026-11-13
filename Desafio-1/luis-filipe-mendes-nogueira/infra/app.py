#!/usr/bin/env python3
import os

import aws_cdk as cdk

from infra.infra_stack import InfraStack


app = cdk.App()
InfraStack(
    app,
    "luis-filipe-mendes-nogueira-desafio-1",
    stack_name="luis-filipe-mendes-nogueira-desafio-1",
    env=cdk.Environment(region="us-east-1"),
)

app.synth()
