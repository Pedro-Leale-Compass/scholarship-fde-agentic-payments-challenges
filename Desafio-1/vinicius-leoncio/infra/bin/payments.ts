import * as cdk from 'aws-cdk-lib'
import { PaymentsBudgetStack } from '../lib/budget-stack'
import { PaymentsStack } from '../lib/payments-stack'

const app = new cdk.App()
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
}
const budgetStack = new PaymentsBudgetStack(app, 'ViniciusPaymentsBudget', { env })
const paymentsStack = new PaymentsStack(app, 'ViniciusPaymentsSprint2', {
  env,
  defaultUserLimit: 500,
  deployFrontend: String(app.node.tryGetContext('deployFrontend') ?? 'false').toLowerCase() === 'true',
  localFrontendOrigin: 'http://localhost:3000',
})
paymentsStack.addStackDependency(budgetStack)
