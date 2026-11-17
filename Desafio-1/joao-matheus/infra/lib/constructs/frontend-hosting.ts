import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { nome } from '../config';

export class FrontendHostingConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution?: cloudfront.Distribution;
  public readonly urlFrontend: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Bucket S3 privado para hospedar os artefatos estáticos do frontend
    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Flag de contexto para habilitar/desabilitar CloudFront temporariamente conforme
    // orientação da coordenação enquanto a Service Control Policy (SCP) da AWS Organization é ajustada.
    const habilitarCloudFront = this.node.tryGetContext('habilitarCloudFront') ?? true;

    if (habilitarCloudFront) {
      // Distribuição CloudFront com Origin Access Control (OAC)
      this.distribution = new cloudfront.Distribution(this, 'Distribution', {
        comment: nome('frontend'),
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.seconds(0),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.seconds(0),
          },
        ],
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      });

      this.urlFrontend = `https://${this.distribution.distributionDomainName}`;
    } else {
      // Fallback para desenvolvimento com frontend local (Vite em localhost:5173)
      this.urlFrontend = 'http://localhost:5173';
    }
  }
}
