#!/usr/bin/env bash
# Destroy cleanup: remove orphaned resources that `cdk destroy` does not delete.
#
# CloudFormation / CDK DestroyStack removes the stack and its direct child
# resources, but it does NOT delete:
#   - CloudWatch Log Groups created automatically by Lambda functions
#   - IAM Roles that have attached managed policies (must detach first)
#   - API Gateway child resources / stale REST API entries
#   - Lambda $LATEST versions (cleared only when parent function is gone)
#
# Usage:
#   eval "$(bash scripts/aws-creds.sh)"
#   bash scripts/destroy-cleanup.sh

set -euo pipefail

PROFILE="${AWS_PROFILE:-desafio-1}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="luiz-henrique"

echo "=== Destroy cleanup (profile=$PROFILE, region=$REGION) ==="

# ---------------------------------------------------------------------------
# 1. CloudWatch Log Groups
#    Patterns: /aws/lambda/luiz-henrique-*, /aws/lambda/Desafio1Stack-*,
#              /aws/bedrock-agentcore/runtimes/luiz_henrique_agent-*,
#              /aws/vendedlogs/states/waiter-state-machine-Desafio1Stack-*
# ---------------------------------------------------------------------------
echo ""
echo "--- Deleting CloudWatch Log Groups ---"
LOG_GROUPS=$(aws logs describe-log-groups \
  --profile "$PROFILE" --region "$REGION" \
  --query "logGroups[?contains(logGroupName, '/aws/lambda/luiz-henrique-') || contains(logGroupName, '/aws/lambda/Desafio1Stack-') || contains(logGroupName, '/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-') || contains(logGroupName, '/aws/vendedlogs/states/waiter-state-machine-Desafio1Stack-')].logGroupName" \
  --output text 2>/dev/null || true)

if [ -n "$LOG_GROUPS" ]; then
  echo "$LOG_GROUPS" | tr '\t' '\n' | while read -r lg; do
    [ -z "$lg" ] && continue
    echo "  deleting log group: $lg"
    aws logs delete-log-group --log-group-name "$lg" --profile "$PROFILE" --region "$REGION" 2>&1 || true
  done
else
  echo "  (none found)"
fi

# ---------------------------------------------------------------------------
# 2. IAM Roles
#    Pattern: Desafio1Stack-*, luiz-henrique-agent-runtime-role
#    Must detach managed policies and delete inline policies first.
# ---------------------------------------------------------------------------
echo ""
echo "--- Deleting IAM Roles ---"
ROLES=$(aws iam list-roles \
  --profile "$PROFILE" \
  --query "Roles[?contains(RoleName, 'Desafio1Stack-') || RoleName == 'luiz-henrique-agent-runtime-role'].RoleName" \
  --output text 2>/dev/null || true)

if [ -n "$ROLES" ]; then
  echo "$ROLES" | tr '\t' '\n' | while read -r role; do
    [ -z "$role" ] && continue
    echo "  processing role: $role"

    # Detach all managed policies
    POLICIES=$(aws iam list-attached-role-policies --role-name "$role" --profile "$PROFILE" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)
    if [ -n "$POLICIES" ]; then
      echo "$POLICIES" | tr '\t' '\n' | while read -r pol; do
        [ -z "$pol" ] && continue
        echo "    detaching policy: $pol"
        aws iam detach-role-policy --role-name "$role" --policy-arn "$pol" --profile "$PROFILE" 2>&1 || true
      done
    fi

    # Delete all inline policies
    INLINE=$(aws iam list-role-policies --role-name "$role" --profile "$PROFILE" \
      --query 'PolicyNames' --output text 2>/dev/null || true)
    if [ -n "$INLINE" ]; then
      echo "$INLINE" | tr '\t' '\n' | while read -r pol; do
        [ -z "$pol" ] && continue
        echo "    deleting inline policy: $pol"
        aws iam delete-role-policy --role-name "$role" --policy-name "$pol" --profile "$PROFILE" 2>&1 || true
      done
    fi

    # Delete the role
    echo "    deleting role: $role"
    aws iam delete-role --role-name "$role" --profile "$PROFILE" 2>&1 || true
  done
else
  echo "  (none found)"
fi

# ---------------------------------------------------------------------------
# 3. API Gateway Resources & REST APIs
#    Find REST APIs whose name contains the project prefix, delete all
#    child resources, then delete the REST API itself.
# ---------------------------------------------------------------------------
echo ""
echo "--- Deleting API Gateway REST APIs ---"
API_IDS=$(aws apigateway get-rest-apis \
  --profile "$PROFILE" --region "$REGION" \
  --query "items[?contains(name, '$PREFIX')].id" \
  --output text 2>/dev/null || true)

if [ -n "$API_IDS" ]; then
  echo "$API_IDS" | tr '\t' '\n' | while read -r api_id; do
    [ -z "$api_id" ] && continue
    echo "  processing API: $api_id"

    # Delete all resources under this API (except the root)
    RESOURCE_IDS=$(aws apigateway get-resources \
      --rest-api-id "$api_id" --profile "$PROFILE" --region "$REGION" \
      --query 'items[?path != `/`].id' --output text 2>/dev/null || true)

    if [ -n "$RESOURCE_IDS" ]; then
      echo "$RESOURCE_IDS" | tr '\t' '\n' | while read -r res_id; do
        [ -z "$res_id" ] && continue
        echo "    deleting resource: $res_id"
        aws apigateway delete-resource --rest-api-id "$api_id" --resource-id "$res_id" --profile "$PROFILE" --region "$REGION" 2>&1 || true
      done
    fi

    # Delete stages first (cannot delete API with active stages)
    STAGES=$(aws apigateway get-stages \
      --rest-api-id "$api_id" --profile "$PROFILE" --region "$REGION" \
      --query 'item[].stageName' --output text 2>/dev/null || true)
    if [ -n "$STAGES" ]; then
      echo "$STAGES" | tr '\t' '\n' | while read -r stage; do
        [ -z "$stage" ] && continue
        echo "    deleting stage: $stage"
        aws apigateway delete-stage --rest-api-id "$api_id" --stage-name "$stage" --profile "$PROFILE" --region "$REGION" 2>&1 || true
      done
    fi

    # Delete deployments
    DEPLOYMENTS=$(aws apigateway get-deployments \
      --rest-api-id "$api_id" --profile "$PROFILE" --region "$REGION" \
      --query 'items[].id' --output text 2>/dev/null || true)
    if [ -n "$DEPLOYMENTS" ]; then
      echo "$DEPLOYMENTS" | tr '\t' '\n' | while read -r dep; do
        [ -z "$dep" ] && continue
        echo "    deleting deployment: $dep"
        aws apigateway delete-deployment --rest-api-id "$api_id" --deployment-id "$dep" --profile "$PROFILE" --region "$REGION" 2>&1 || true
      done
    fi

    # Delete the REST API
    echo "    deleting REST API: $api_id"
    aws apigateway delete-rest-api --rest-api-id "$api_id" --profile "$PROFILE" --region "$REGION" 2>&1 || true
  done
else
  echo "  (none found)"
fi

# ---------------------------------------------------------------------------
# 4. Lambda Functions
#    Pattern: luiz-henrique-*, Desafio1Stack-*
#    (These are deleted by cdk destroy, but we ensure they are gone.)
# ---------------------------------------------------------------------------
echo ""
echo "--- Deleting Lambda Functions ---"
FUNCTIONS=$(aws lambda list-functions \
  --profile "$PROFILE" --region "$REGION" \
  --query "Functions[?contains(FunctionName, 'luiz-henrique-') || contains(FunctionName, 'Desafio1Stack-')].FunctionName" \
  --output text 2>/dev/null || true)

if [ -n "$FUNCTIONS" ]; then
  echo "$FUNCTIONS" | tr '\t' '\n' | while read -r fn; do
    [ -z "$fn" ] && continue
    echo "  deleting function: $fn"
    aws lambda delete-function --function-name "$fn" --profile "$PROFILE" --region "$REGION" 2>&1 || true
  done
else
  echo "  (none found)"
fi

echo ""
echo "=== Destroy cleanup complete ==="
echo "Note: Lambda \$LATEST version entries and stale Resource Explorer index"
echo "entries may persist until AWS re-indexes; they are harmless."
