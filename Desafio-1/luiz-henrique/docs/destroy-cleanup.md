# Destroy Cleanup Prevention Document

## Problem

The `npm run destroy` script (CloudFormation `DestroyStack`) does not clean up all project resources. Across 2 deploy/destroy cycles, the following resource types were left behind as orphans:

| Resource Type | Cycle 1 Leftover | Cycle 2 Leftover | Total |
|---------------|-----------------|-----------------|-------|
| `logs:log-group` | 60 | 7 | 67 |
| `iam:role` | 18 | 2 | 20 |
| `apigateway:restapis/resources` | 0 | 1 | 1 |
| `lambda:function/version` (`:$LATEST`) | 6 | 4 | 10 |
| **Total** | **84** | **14** | **98** |

## Root Cause

CloudFormation `DeleteStack` removes the stack and its direct child resources, but does NOT delete:

1. **CloudWatch Log Groups** created by Lambda functions — these are separate resources not owned by the stack
2. **IAM Roles** with attached policies — must detach policies before deleting the role
3. **API Gateway child resources** — stale index entries remain after REST API deletion
4. **Lambda `$LATEST` versions** — cannot be deleted directly; cleared only when parent function is deleted and Resource Explorer re-indexes

## Required Fix: Add to Destroy Script

Add these cleanup steps to `npm run destroy` (or the CDK destroy stack) **before** or **after** `DeleteStack`:

### 1. Delete CloudWatch Log Groups

```bash
# Delete all log groups matching project patterns
aws logs describe-log-groups --profile desafio-1 --region us-east-1 \
  --query "logGroups[?contains(logGroupName, 'Desafio1Stack') || contains(logGroupName, 'luiz-henrique') || contains(logGroupName, 'bedrock-agentcore')].logGroupName" \
  --output text | tr '\t' '\n' | while read lg; do
  aws logs delete-log-group --log-group-name "$lg" --profile desafio-1 --region us-east-1 || true
done
```

### 2. Delete IAM Roles (with policy detachment)

```bash
# For each IAM role matching project pattern:
aws iam list-attached-role-policies --role-name <ROLE_NAME> --profile desafio-1 \
  --query 'AttachedPolicies[].PolicyArn' --output text | while read policy; do
  aws iam detach-role-policy --role-name <ROLE_NAME> --policy-arn "$policy" --profile desafio-1 || true
done

aws iam list-role-policies --role-name <ROLE_NAME> --profile desafio-1 \
  --query 'PolicyNames' --output text | while read pol; do
  aws iam delete-role-policy --role-name <ROLE_NAME> --policy-name "$pol" --profile desafio-1 || true
done

aws iam delete-role --role-name <ROLE_NAME> --profile desafio-1 || true
```

### 3. Delete API Gateway Resources

```bash
# Delete all resources under project REST APIs
aws apigateway get-rest-apis --profile desafio-1 --region us-east-1 \
  --query 'items[?name==`Desafio1Stack`].id' --output text | while read api_id; do
  aws apigateway get-resources --rest-api-id "$api_id" --profile desafio-1 --region us-east-1 \
    --query 'items[].id' --output text | while read res_id; do
    aws apigateway delete-resource --rest-api-id "$api_id" --resource-id "$res_id" --profile desafio-1 --region us-east-1 || true
  done
  aws apigateway delete-rest-api --rest-api-id "$api_id" --profile desafio-1 --region us-east-1 || true
done
```

### 4. Lambda `$LATEST` Versions

Cannot be deleted directly. They clear automatically when:
- The parent Lambda function is deleted (by CloudFormation)
- Resource Explorer re-indexes (eventually consistent, may take minutes-hours)

## Verification After Destroy

Run this to confirm zero project resources remain:

```bash
aws resource-explorer-2 list-resources \
  --profile desafio-1 \
  --region us-east-1 \
  --view-arn arn:aws:resource-explorer-2:us-east-1:<account-id>:view/us-east-1/<view-id> \
  --no-paginate --output json | python3 -c "
import json, sys
d = json.load(sys.stdin)
project = [r for r in d['Resources'] if 'Desafio1Stack' in r.get('Arn','') or 'luiz-henrique' in r.get('Arn','') or '<rest-api-id>' in r.get('Arn','')]
print(f'Project resources remaining: {len(project)}')
for r in project:
    print(f'  {r[\"Service\"]} | {r[\"ResourceType\"]} | {r[\"Arn\"]}')
"
```

Expected output: `Project resources remaining: 0`

## Files Created During This Cleanup

- `resources-before-destroy.json` — 232 resources (cycle 1 before)
- `resources-after-destroy.json` — 194 resources (cycle 1 after, clean baseline)
- `resources-before-destroy2.json` — 241 resources (cycle 2 before)
- `resources-after-destroy-2.json` — 204 resources (cycle 2 after, before manual cleanup)
- `resources-after-cleanup.json` — 134 resources (after manual cleanup, stale index)
- `orphans-cycle-2.md` — 10 cycle-2 orphans documented
- `orphans-full-report-after-destroy-2.md` — full 98-resource orphan report
- `destroy-cleanup.md` — this document