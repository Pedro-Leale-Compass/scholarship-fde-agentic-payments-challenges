import * as cdk from 'aws-cdk-lib'
import { PaymentsBudgetStack } from '../lib/budget-stack'

const app = new cdk.App()
new PaymentsBudgetStack(app, 'ViniciusPaymentsBudget', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
})
