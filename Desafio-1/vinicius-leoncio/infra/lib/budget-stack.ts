import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as budgets from 'aws-cdk-lib/aws-budgets'

export class PaymentsBudgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)
    const email = new cdk.CfnParameter(this, 'BudgetAlertEmail', {
      type: 'String',
      description: 'E-mail que receberá os alertas de orçamento mensal.',
      allowedPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    })
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'vinicius-payments-monthly',
        budgetLimit: { amount: 20, unit: 'USD' },
        timeUnit: 'MONTHLY',
        budgetType: 'COST',
      },
      notificationsWithSubscribers: [
        ...[50, 75].map((threshold) => ({
          notification: { notificationType: 'ACTUAL' as const, comparisonOperator: 'GREATER_THAN' as const, threshold, thresholdType: 'PERCENTAGE' as const },
          subscribers: [{ subscriptionType: 'EMAIL' as const, address: email.valueAsString }],
        })),
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 90, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: email.valueAsString }],
        },
      ],
    })
  }
}
