#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ──
FUNCTION_NAME="${FUNCTION_NAME:-kindle-calendar}"
AWS_REGION="${AWS_REGION:-ap-southeast-2}"
MEMORY_SIZE="${MEMORY_SIZE:-1024}"
TIMEOUT="${TIMEOUT:-30}"
ECR_REPO="${ECR_REPO:-kindle-calendar}"

# ── Resolve AWS account ──
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_TAG="latest"
IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

echo "══════════════════════════════════════════"
echo "  Kindle Calendar — Lambda Deploy"
echo "══════════════════════════════════════════"
echo "  Function:  ${FUNCTION_NAME}"
echo "  Region:    ${AWS_REGION}"
echo "  ECR:       ${ECR_URI}"
echo "  Memory:    ${MEMORY_SIZE} MB"
echo "  Timeout:   ${TIMEOUT}s"
echo "══════════════════════════════════════════"

# ── Step 1: Create ECR repo if needed ──
echo ""
echo "→ Ensuring ECR repository exists..."
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${AWS_REGION}" 2>/dev/null || \
  aws ecr create-repository --repository-name "${ECR_REPO}" --region "${AWS_REGION}" --image-scanning-configuration scanOnPush=true

# ── Step 2: Docker login to ECR ──
echo "→ Authenticating Docker to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# ── Step 3: Build and push ──
echo "→ Building Docker image..."
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 -t "${ECR_REPO}:${IMAGE_TAG}" .

echo "→ Tagging and pushing..."
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${IMAGE_URI}"
docker push "${IMAGE_URI}"

# ── Step 4: Create or update Lambda function ──
echo "→ Deploying Lambda function..."
if aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${AWS_REGION}" 2>/dev/null; then
  # Update existing function
  aws lambda update-function-code \
    --function-name "${FUNCTION_NAME}" \
    --image-uri "${IMAGE_URI}" \
    --region "${AWS_REGION}" \
    --publish

  echo "→ Waiting for update to complete..."
  aws lambda wait function-updated-v2 --function-name "${FUNCTION_NAME}" --region "${AWS_REGION}"

  aws lambda update-function-configuration \
    --function-name "${FUNCTION_NAME}" \
    --memory-size "${MEMORY_SIZE}" \
    --timeout "${TIMEOUT}" \
    --region "${AWS_REGION}"
else
  # Check if execution role exists, create if not
  ROLE_NAME="${FUNCTION_NAME}-role"
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

  if ! aws iam get-role --role-name "${ROLE_NAME}" 2>/dev/null; then
    echo "→ Creating IAM execution role..."
    aws iam create-role \
      --role-name "${ROLE_NAME}" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": { "Service": "lambda.amazonaws.com" },
          "Action": "sts:AssumeRole"
        }]
      }'
    aws iam attach-role-policy \
      --role-name "${ROLE_NAME}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "→ Waiting for role propagation..."
    sleep 10
  fi

  ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text)

  aws lambda create-function \
    --function-name "${FUNCTION_NAME}" \
    --package-type Image \
    --code "ImageUri=${IMAGE_URI}" \
    --role "${ROLE_ARN}" \
    --memory-size "${MEMORY_SIZE}" \
    --timeout "${TIMEOUT}" \
    --region "${AWS_REGION}" \
    --publish

  echo "→ Waiting for function to become active..."
  aws lambda wait function-active-v2 --function-name "${FUNCTION_NAME}" --region "${AWS_REGION}"

  # Create function URL for direct HTTP access (no API Gateway needed)
  echo "→ Creating function URL..."
  aws lambda create-function-url-config \
    --function-name "${FUNCTION_NAME}" \
    --auth-type NONE \
    --region "${AWS_REGION}" || true

  # Allow public invocation via function URL
  aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id FunctionURLPublic \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region "${AWS_REGION}" 2>/dev/null || true
fi

# ── Step 5: Get function URL ──
FUNCTION_URL=$(aws lambda get-function-url-config --function-name "${FUNCTION_NAME}" --region "${AWS_REGION}" --query 'FunctionUrl' --output text 2>/dev/null || echo "N/A")

echo ""
echo "══════════════════════════════════════════"
echo "  Deploy complete!"
echo "══════════════════════════════════════════"
echo "  Function URL:  ${FUNCTION_URL}"
echo ""
echo "  Kindle usage:"
echo "    wget -q -O /mnt/us/display.png ${FUNCTION_URL}screen.png"
echo "    fbink -q -c -g file=/mnt/us/display.png"
echo ""
echo "  Set calendar credentials:"
echo "    aws lambda update-function-configuration \\"
echo "      --function-name ${FUNCTION_NAME} \\"
echo "      --environment 'Variables={CALENDAR_CREDS_PERSONAL=\"{...}\"}'"
echo "══════════════════════════════════════════"
