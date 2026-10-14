# Sift on AWS (CDK)

One stack, defined in `lib/sift-stack.ts`. It synthesizes today; it isn't deployed yet.

```
CloudFront ─┬─ /*      → S3 (built React app)
            └─ /api/*  → ALB → ECS Fargate (FastAPI gateway, streaming)

Fargate task → DynamoDB (single table) · Secrets Manager (model keys)
             → Comprehend (PII) · Bedrock (optional models)
Cognito user pool → JWTs the API verifies
```

## What it costs while idle

Roughly one small Fargate task plus one Application Load Balancer, about $35–45/month in us-east-1. There's deliberately **no NAT gateway** (tasks sit in public subnets behind a security group that only admits the load balancer), which avoids another $30+/month. DynamoDB is on-demand and CloudFront/S3 are pennies at this scale. A monthly AWS Budget emails you at 80% of `monthlyBudgetUsd` and when the forecast passes 100%.

## Before the first deploy

The app still runs on local stand-ins for three AWS pieces. Each has a documented slot:

| Piece | Local stand-in | To finish |
|---|---|---|
| Storage | SQLite (`app/storage/sqlite.py`) | Implement `app/storage/dynamodb.py` against the key design in its docstring |
| Sign-in | One local admin user (`app/auth.py`) | Implement `CognitoVerifier` (JWKS check) and a sign-in screen (Amplify Auth or Cognito Hosted UI) |
| PII names | `MockComprehendClient` | Pass `boto3.client("comprehend")` to `ComprehendDetector` |
| Payments | `MockPayments` (test mode) | Stripe Checkout + a `checkout.session.completed` webhook |
| Image uploads | Bytes in SQLite (`uploads` table) | A private S3 bucket (SSE-KMS, lifecycle rule matching retention); keep only metadata in DynamoDB |

## Deploy

```bash
cd infra
npm install
npx cdk bootstrap                       # once per account/region
npx cdk deploy -c alertEmail=you@domain.com -c monthlyBudgetUsd=50

# then store the model key (never in code or git)
aws secretsmanager put-secret-value --secret-id sift/model-keys \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'

# and publish the frontend
cd ../frontend && npm run build
aws s3 sync dist s3://<SiteBucket output> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId output> --paths "/*"
```

`npx cdk synth` works without AWS credentials if you just want to review the CloudFormation.
