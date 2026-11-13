
import * as cdk from "aws-cdk-lib";
import { InfraStack } from "../lib/infra-stack";

const app = new cdk.App();

new InfraStack(app, "heleno-agentic-payments", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1"
  },

  description:
    "Infraestrutura AWS do desafio Agentic Payments - Heleno"
});

app.synth();
