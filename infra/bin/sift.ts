#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'

import { SiftAuthStack } from '../lib/auth-stack'
import { SiftStack } from '../lib/sift-stack'

const app = new cdk.App()
const ctx = (key: string): string | undefined => app.node.tryGetContext(key) || undefined

// With AWS credentials configured, CDK fills these in; without them the
// stacks still synthesize (environment-agnostic) for review.
const env = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' }
  : undefined

// Sign-in first: it can be deployed (and used from localhost) on its own.
//   npx cdk deploy SiftAuth
const auth = new SiftAuthStack(app, 'SiftAuth', {
  env,
  // Comma-separated app URLs to allow as sign-in return addresses, e.g. your domain.
  appUrls: (ctx('appUrls') ?? '').split(',').filter(Boolean),
  googleClientId: ctx('googleClientId'),
  googleSecretName: ctx('googleSecretName'),
})

// Everything else (servers, database, CDN): npx cdk deploy Sift
new SiftStack(app, 'Sift', {
  env,
  auth,
  alertEmail: app.node.tryGetContext('alertEmail') ?? 'you@example.com',
  monthlyBudgetUsd: Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 50),
  dailyModelBudgetUsd: Number(app.node.tryGetContext('dailyModelBudgetUsd') ?? 5),
})
