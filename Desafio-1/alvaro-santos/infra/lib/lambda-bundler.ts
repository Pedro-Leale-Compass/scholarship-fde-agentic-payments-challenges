import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as esbuild from 'esbuild';

/**
 * Empacota uma Lambda TypeScript in-process via esbuild, evitando dependência de Docker ou npx.
 * Apenas clientes DynamoDB usam o SDK v3 nativo do runtime NODEJS_22_X; pacotes mais recentes
 * como @aws-sdk/client-bedrock-agentcore vão no bundle para evitar divergência de versão na Lambda.
 */
export function bundleNode22Lambda(entryFile: string, assetRootDir: string): lambda.Code {
  return lambda.Code.fromAsset(assetRootDir, {
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
