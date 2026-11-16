import * as path from 'path';
import * as fs from 'fs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface FrontendDeployConstructProps {
  bucket: s3.IBucket;
  distribution?: cloudfront.IDistribution;
  api: apigw.RestApi;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
}

export class FrontendDeployConstruct extends Construct {
  constructor(scope: Construct, id: string, props: FrontendDeployConstructProps) {
    super(scope, id);

    const distPath = path.resolve(__dirname, '../../../frontend/dist');

    // Validação preventiva de existência dos artefatos compilados do frontend
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `Diretório ${distPath} não encontrado. Execute 'npm run build:frontend' ou 'npm run deploy' antes de executar o CDK.`
      );
    }

    // Montagem segura da URL base da API REST sem barra final
    const apiUrl = `https://${props.api.restApiId}.execute-api.us-east-1.amazonaws.com/${props.api.deploymentStage.stageName}`;

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      destinationBucket: props.bucket,
      sources: [
        s3deploy.Source.asset(distPath),
        s3deploy.Source.jsonData('config.json', {
          apiUrl,
          userPoolId: props.userPool.userPoolId,
          userPoolClientId: props.userPoolClient.userPoolClientId,
          region: 'us-east-1',
        }),
      ],
      distribution: props.distribution,
      distributionPaths: props.distribution ? ['/*'] : undefined,
      memoryLimit: 512,
      prune: true,
    });
  }
}
