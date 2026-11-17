import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as constructs from 'constructs'

export type AutenticacaoProps = {
  prefixo: string
  urlApp?: string
}

export class Autenticacao extends constructs.Construct {
  readonly userPool: cognito.UserPool
  readonly userPoolClient: cognito.UserPoolClient

  constructor(scope: constructs.Construct, id: string, props: AutenticacaoProps) {
    super(scope, id)

    const acesso = props.urlApp ? `\n\nAcesse: ${props.urlApp}` : ''

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.prefixo}-usuarios`,
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      userInvitation: {
        emailSubject: 'Seu acesso ao agente de pagamentos',
        emailBody:
          'Olá! Você foi convidado(a) para o agente de pagamentos da Isabele.\n\n' +
          'Usuário: {username}\nSenha temporária: {####}\n\n' +
          `No primeiro acesso será pedido que você defina uma nova senha.${acesso}`,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    this.userPoolClient = this.userPool.addClient('ClienteFrontend', {
      userPoolClientName: `${props.prefixo}-frontend`,
      generateSecret: false,
      authFlows: { userSrp: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      enableTokenRevocation: true,
    })
  }
}
