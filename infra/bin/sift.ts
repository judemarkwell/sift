#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'

import { SiftStack } from '../lib/sift-stack'

const app = new cdk.App()

new SiftStack(app, 'Sift', {
  // With AWS credentials configured, CDK fills these in; without them the
  // stack still synthesizes (environment-agnostic) for review.
  env: process.env.CDK_DEFAULT_ACCOUNT
    ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' }
    : undefined,
  alertEmail: app.node.tryGetContext('alertEmail') ?? 'you@example.com',
  monthlyBudgetUsd: Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 50),
  dailyModelBudgetUsd: Number(app.node.tryGetContext('dailyModelBudgetUsd') ?? 5),
})
