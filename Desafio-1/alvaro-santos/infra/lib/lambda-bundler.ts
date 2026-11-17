import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as esbuild from 'esbuild';

/**
 * Empacota uma Lambda TypeScript in-process via esbuild, evitando dependência de Docker ou npx.
 * Apenas clientes DynamoDB usam o SDK v3 nativo do runtime NODEJS_22_X; pacotes mais recentes
 * como @aws-sdk/client-bedrock-agentcore vão no bundle para evitar divergência de versão na Lambda.
 */
export function bundleNode22Lambda(entryFile: string, assetRootDir: string): lambda.Code {
  return lambda.Code.fromAsset(assetRootDir, {
    // Combina o fingerprint de todo o diretório raiz com o entrypoint relativo para gerar um hash
    // único por Lambda antes do bundling, evitando deduplicação indevida e o rename() que falha no Windows.
    assetHashType: cdk.AssetHashType.CUSTOM,
    assetHash: `${cdk.FileSystem.fingerprint(assetRootDir)}:${path.relative(assetRootDir, entryFile)}`,
    bundling: {
      image: lambda.Runtime.NODEJS_22_X.bundlingImage,
      local: {
        tryBundle(outputDir: string): boolean {
          esbuild.buildSync({
            entryPoints: [entryFile],
            bundle: true,
            platform: 'node',
            target: 'node22',
            minify: true,
            sourcemap: true,
            nodePaths: [path.resolve(__dirname, '../node_modules')],
            external: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
            outfile: path.join(outputDir, 'index.js'),
          });
          return true;
        },
      },
    },
  });
}
