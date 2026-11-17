import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as constructs from 'constructs'

export type FrontendProps = { prefixo: string }

export type ConfigFrontend = {
  urlApi: string
  regiao: string
  userPoolId: string
  userPoolClientId: string
}

export const PASTA_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url))

export function createHashPasta(pasta: string): string {
  const hash = createHash('sha256')
  const visit = (atual: string) => {
    for (const nome of readdirSync(atual).sort()) {
      const caminho = path.join(atual, nome)
      if (statSync(caminho).isDirectory()) visit(caminho)
      else hash.update(path.relative(pasta, caminho)).update(readFileSync(caminho))
    }
  }
  visit(pasta)
  return hash.digest('hex').slice(0, 32)
}

export class Frontend extends constructs.Construct {
  readonly bucket: s3.Bucket
  readonly distribuicao: cloudfront.Distribution
  readonly urlApp: string

  constructor(scope: constructs.Construct, id: string, props: FrontendProps) {
    super(scope, id)
    const stack = cdk.Stack.of(this)

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${props.prefixo}-frontend-${stack.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    const origem = origins.S3BucketOrigin.withOriginAccessControl(this.bucket)

    this.distribuicao = new cloudfront.Distribution(this, 'Distribuicao', {
      comment: `${props.prefixo} - frontend do agente de pagamentos`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origem,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        '/config.json': {
          origin: origem,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: cdk.Duration.seconds(0),
      })),
    })

    this.urlApp = `https://${this.distribuicao.distributionDomainName}`
  }

  publishSite(config: ConfigFrontend, pastaDist = PASTA_DIST): void {
    if (!existsSync(pastaDist)) {
      throw new Error(`pasta ${pastaDist} não encontrada: rode o build do frontend antes do deploy completo`)
    }

    const publicacao = new s3deploy.BucketDeployment(this, 'Publicacao', {
      sources: [s3deploy.Source.asset(pastaDist), s3deploy.Source.jsonData('config.json', config)],
      destinationBucket: this.bucket,
      prune: true,
      memoryLimit: 512,
      logGroup: new logs.LogGroup(this, 'PublicacaoLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    const hashSite = createHashPasta(pastaDist)
    const invalidacao: cr.AwsSdkCall = {
      service: 'CloudFront',
      action: 'createInvalidation',
      parameters: {
        DistributionId: this.distribuicao.distributionId,
        InvalidationBatch: {
          CallerReference: hashSite,
          Paths: { Quantity: 1, Items: ['/*'] },
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(`invalidacao-${hashSite}`),
    }

    const invalidacaoCache = new cr.AwsCustomResource(this, 'InvalidacaoCache', {
      onCreate: invalidacao,
      onUpdate: invalidacao,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [this.distribuicao.distributionArn],
        }),
      ]),
      installLatestAwsSdk: false,
    })
    invalidacaoCache.node.addDependency(publicacao)
  }
}
