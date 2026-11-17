#!/usr/bin/env python3
import os

import aws_cdk as cdk

from chatpay_stack import ChatPayStack

app = cdk.App()
ChatPayStack(
    app,
    "FellowsCarlosEduardo",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region="us-east-1",
    ),
)
app.synth()
