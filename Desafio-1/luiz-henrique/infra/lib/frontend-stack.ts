import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

export interface FrontendStackProps {
  stackPrefix: string;
  apiDomain: string;
}

export class FrontendStack extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id);

    const { stackPrefix } = props;
    const prefix = `${stackPrefix}-`;

    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${prefix}frontend`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const oac = new cloudfront.OriginAccessIdentity(this, 'OAC', {
      comment: `${prefix}oac`,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.bucket, { originAccessIdentity: oac }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(0),
        },
      ],
    });

    this.bucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('*')],
        principals: [new cdk.aws_iam.CanonicalUserPrincipal(oac.originAccessIdentityId)],
      })
    );

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset('../frontend/out')],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
  }
}
