#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { IamBaselineStack } from '../lib/iam-baseline-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';

const app = new cdk.App();
const cfg = loadConfig(app.node.tryGetContext('config') ?? 'config/sandbox.json');

// Every stack is pinned to the sandbox account: a deploy with credentials for any other account fails.
const env = { account: cfg.sandboxAccountId, region: cfg.region };
const p = cfg.prefix;

const security = new SecurityStack(app, `${p}-foundation-security`, {
  env, cfg, description: `${p} foundation: KMS keys, CloudTrail, AWS Config, budget, account hardening`,
});
const network = new NetworkStack(app, `${p}-foundation-network`, {
  env, cfg, logsKey: security.logsKey, description: `${p} foundation: VPC, flow logs, endpoints`,
});
new IamBaselineStack(app, `${p}-foundation-iam`, {
  env,
  cfg,
  logsKey: security.logsKey,
  dataKey: security.dataKey,
  secretsKey: security.secretsKey,
  trailArn: security.trailArn,
  trailBucket: security.trailBucket,
  auditLogGroups: [security.trailLogGroup, network.flowLogGroup],
  description: `${p} foundation: permissions boundary, guardrail policies, admin/developer/auditor roles`,
});

cdk.Tags.of(app).add('Project', p);
cdk.Tags.of(app).add('Environment', 'sandbox');
cdk.Tags.of(app).add('ManagedBy', 'cdk-foundation');

// AWS Solutions security rules run on every synth; an unsuppressed finding fails it.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
