# Sift on AWS (CDK)

Two stacks:

- **`SiftAuth`** (`lib/auth-stack.ts`): sign-in only (Cognito user pool, hosted login pages, Google). Nothing in it bills while idle, so deploy it first and use it from localhost.
- **`Sift`** (`lib/sift-stack.ts`): servers, database and CDN. Deploy when you're ready to host.

```
CloudFront ─┬─ /*      → S3 (built React app)
            └─ /api/*  → ALB → ECS Fargate (FastAPI gateway, streaming)

Fargate task → DynamoDB (single table) · Secrets Manager (model keys)
             → Comprehend (PII) · Bedrock (optional models)
Cognito user pool (SiftAuth) → ID tokens the API verifies (app/auth.py)
```

## What it costs while idle

Roughly one small Fargate task plus one Application Load Balancer, about $35–45/month in us-east-1. There's deliberately **no NAT gateway** (tasks sit in public subnets behind a security group that only admits the load balancer), which avoids another $30+/month. DynamoDB is on-demand and CloudFront/S3 are pennies at this scale. A monthly AWS Budget emails you at 80% of `monthlyBudgetUsd` and when the forecast passes 100%.

## Before the first deploy

The app still runs on local stand-ins for these AWS pieces. Each has a documented slot:

| Piece | Local stand-in | To finish |
|---|---|---|
| Storage | SQLite (`app/storage/sqlite.py`) | Implement `app/storage/dynamodb.py` against the key design in its docstring |
| PII names | `MockComprehendClient` | Pass `boto3.client("comprehend")` to `ComprehendDetector` |
| Payments | `MockPayments` (test mode) | Stripe Checkout + a `checkout.session.completed` webhook |
| Image uploads | Bytes in SQLite (`uploads` table) | A private S3 bucket (SSE-KMS, lifecycle rule matching retention); keep only metadata in DynamoDB |

## Sign-in (deploy this first)

```bash
cd infra && npm install
npx cdk bootstrap --profile sift            # once per account/region
npx cdk deploy SiftAuth --profile sift
```

Copy the outputs into `backend/.env`:

```bash
SIFT_AUTH=cognito
SIFT_COGNITO_REGION=<Region>
SIFT_COGNITO_USER_POOL_ID=<UserPoolId>
SIFT_COGNITO_CLIENT_ID=<UserPoolClientId>
SIFT_COGNITO_DOMAIN=<LoginDomain>
```

Restart the backend and open http://localhost:5173: you'll get the sign-in screen. New accounts start on the Free plan.

**Adding Google** (after the first deploy, since Google needs Cognito's address):

1. In Google Cloud console → APIs & Services → OAuth consent screen: External, app name "Sift", your support email; add yourself as a test user.
2. Credentials → Create credentials → OAuth client ID → Web application. Authorized redirect URI: the `GoogleRedirectUri` output.
3. Store the client secret (never in code or context):
   `aws secretsmanager create-secret --name sift/google-oauth --secret-string '<client secret>' --profile sift`
4. Redeploy: `npx cdk deploy SiftAuth --profile sift -c googleClientId=<client id> -c googleSecretName=sift/google-oauth`
5. Add `SIFT_COGNITO_PROVIDERS=Google` to `backend/.env` so the sign-in screen shows the Google button.

When the app has a real address, add it as a sign-in return URL: `-c appUrls=https://app.yourdomain.com`.

## Deploy the rest

```bash
cd infra
npm install
npx cdk deploy Sift --profile sift -c alertEmail=you@domain.com -c monthlyBudgetUsd=50

# then store the model key (never in code or git)
aws secretsmanager put-secret-value --secret-id sift/model-keys \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'

# and publish the frontend
cd ../frontend && npm run build
aws s3 sync dist s3://<SiteBucket output> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId output> --paths "/*"
```

`npx cdk synth` works without AWS credentials if you just want to review the CloudFormation.
