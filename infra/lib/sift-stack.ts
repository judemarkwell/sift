/**
 * Sift on AWS, as one stack.
 *
 *   CloudFront ─┬─ /*      → S3 (the built React app)
 *               └─ /api/*  → ALB → ECS Fargate (the FastAPI gateway, streaming)
 *
 *   Fargate task ── DynamoDB  (single table: chats, traces, settings, billing)
 *                ── Secrets Manager (model API keys)
 *                ── Comprehend (PII detection)   ── Bedrock (optional models)
 *   Cognito user pool (SiftAuth stack) → ID tokens the API verifies (app/auth.py)
 *
 * Cost notes (the things that bill while idle):
 *   - No NAT gateway: tasks run in public subnets with a locked-down security
 *     group, which saves roughly $30+/month per AZ.
 *   - One Fargate task (0.5 vCPU / 1 GB) and one ALB are the steady cost.
 *   - A monthly AWS Budget emails you at 80% of `monthlyBudgetUsd`.
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as budgets from 'aws-cdk-lib/aws-budgets'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'

import type { SiftAuthStack } from './auth-stack'

export interface SiftStackProps extends cdk.StackProps {
  /** Email for budget alerts. */
  alertEmail: string
  /** Monthly AWS spend that triggers an alert (infrastructure + Bedrock/Comprehend). */
  monthlyBudgetUsd: number
  /** Platform-wide daily cap on model spend, enforced by the app. */
  dailyModelBudgetUsd: number
  /** Sign-in (deployed separately so it can exist before the rest). */
  auth: SiftAuthStack
}

export class SiftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SiftStackProps) {
    super(scope, id, props)

    // ---- data -------------------------------------------------------------
    // Key design is documented in backend/app/storage/dynamodb.py.
    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'sift',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1', // conversations by user, newest first
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'GSI2', // traces by conversation
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
        },
      ],
      timeToLiveAttribute: 'expires_at', // for per-org trace retention settings
    })

    // Model keys. Set the value after deploy:
    //   aws secretsmanager put-secret-value --secret-id sift/model-keys \
    //     --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
    const modelKeys = new secrets.Secret(this, 'ModelKeys', {
      secretName: 'sift/model-keys',
      description: 'API keys for model providers, read by the Sift gateway',
      secretObjectValue: { ANTHROPIC_API_KEY: cdk.SecretValue.unsafePlainText('set-me') },
    })

    // ---- API (FastAPI on Fargate) --------------------------------------------
    // Public subnets only: no NAT gateway to pay for. The task's security group
    // only accepts traffic from the load balancer.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    })
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED })

    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      minHealthyPercent: 100, // start the new task before stopping the old one
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      idleTimeout: cdk.Duration.seconds(300), // long streaming replies
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('../backend'),
        containerPort: 8000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'sift-api', logRetention: logs.RetentionDays.ONE_MONTH }),
        environment: {
          SIFT_STORAGE: 'dynamodb',
          SIFT_DYNAMODB_TABLE: table.tableName,
          SIFT_DEFAULT_PLAN: 'free',
          SIFT_DAILY_BUDGET_USD: String(props.dailyModelBudgetUsd),
          SIFT_AUTH: 'cognito',
          SIFT_COGNITO_REGION: props.auth.region,
          SIFT_COGNITO_USER_POOL_ID: props.auth.userPool.userPoolId,
          SIFT_COGNITO_CLIENT_ID: props.auth.client.userPoolClientId,
          SIFT_COGNITO_DOMAIN: props.auth.domainUrl,
          SIFT_ENABLE_MOCK_MODELS: 'true',
        },
        secrets: {
          ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(modelKeys, 'ANTHROPIC_API_KEY'),
        },
      },
    })
    api.targetGroup.configureHealthCheck({ path: '/api/health', healthyHttpCodes: '200' })

    const role = api.taskDefinition.taskRole
    table.grantReadWriteData(role)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['comprehend:DetectPiiEntities', 'comprehend:ContainsPiiEntities'],
        resources: ['*'], // Comprehend's real-time PII APIs don't support resource-level permissions
      }),
    )
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    )

    // ---- web (S3 + CloudFront, with /api routed to the ALB) -----------------------
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.LoadBalancerV2Origin(api.loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            readTimeout: cdk.Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' }],
    })

    // ---- guardrails ---------------------------------------------------------------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'sift-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
        },
      ],
    })

    new cdk.CfnOutput(this, 'Url', { value: `https://${cdn.distributionDomainName}` })
    new cdk.CfnOutput(this, 'SiteBucket', { value: site.bucketName })
    new cdk.CfnOutput(this, 'DistributionId', { value: cdn.distributionId })
  }
}
