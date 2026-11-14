import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { nome } from '../config';

export interface AutenticacaoProps {
  urlFrontend?: string;
}

export class AutenticacaoConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: AutenticacaoProps) {
    super(scope, id);

    const emailBody = props?.urlFrontend
      ? `Olá! Seu usuário é {username} e sua senha temporária é {####}. Acesse: ${props.urlFrontend}`
      : 'Olá! Seu usuário é {username} e sua senha temporária é {####}. Acesse a aplicação web do assistente.';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: nome('user-pool'),
      selfSignUpEnabled: false, // Bloqueia auto cadastro (apenas administradores criam usuários)
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      userInvitation: {
        emailSubject: 'Convite — Assistente de Pagamentos (João Matheus)',
        emailBody: emailBody,
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.client = this.userPool.addClient('WebClient', {
      userPoolClientName: nome('web'),
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true, // Habilitado para testes automatizados e scripts via CLI
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });
  }
}

