import { CliCredentialsStackSynthesizer } from 'aws-cdk-lib';

// Uses the caller's existing SSO permissions. No additional deployment IAM roles.
export function deploymentSynthesizer(prefix: string) {
  return new CliCredentialsStackSynthesizer({
    fileAssetsBucketName: `${prefix}-assets-` + '${AWS::AccountId}-${AWS::Region}',
  });
}
