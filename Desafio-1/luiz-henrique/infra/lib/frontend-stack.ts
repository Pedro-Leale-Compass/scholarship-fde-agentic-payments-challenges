import { Construct } from 'constructs';
import * as amplify from 'aws-cdk-lib/aws-amplify';

export interface FrontendStackProps {
  stackPrefix: string;
}

/**
 * Frontend estático hospedado no AWS Amplify Hosting.
 *
 * A conta deste desafio tem uma SCP que nega cloudfront:CreateDistribution,
 * cloudfront:CreateOriginAccessControl e cloudfront:CreateCloudFrontOriginAccessIdentity,
 * então S3 + CloudFront (OAC/OAI) não é implantável aqui. O Amplify Hosting entrega
 * o mesmo resultado (HTTPS + CDN) sem esses recursos.
 *
 * O deploy dos arquivos é feito por scripts/deploy-frontend.sh após o cdk deploy.
 */
export class FrontendStack extends Construct {
  public readonly app: amplify.CfnApp;
  public readonly branch: amplify.CfnBranch;
  public readonly frontendUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id);

    const { stackPrefix } = props;
    const prefix = `${stackPrefix}-`;

    this.app = new amplify.CfnApp(this, 'AmplifyApp', {
      name: `${prefix}frontend`,
      platform: 'WEB',
      description: 'Desafio 1 - frontend estático (Next.js export)',
    });

    this.branch = new amplify.CfnBranch(this, 'AmplifyBranch', {
      appId: this.app.attrAppId,
      branchName: 'main',
      stage: 'PRODUCTION',
      enableAutoBuild: false,
      description: 'branch de produção',
    });

    this.frontendUrl = `https://main.${this.app.attrDefaultDomain}`;
  }
}
