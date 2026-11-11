import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import { appStackProps, applyAppGuardrails } from '../lib/app-guardrails';
import { FoundationConfig, loadConfig, validateConfig } from '../lib/config';
import { IamBaselineStack } from '../lib/iam-baseline-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';

const baseConfig: FoundationConfig = {
  prefix: 'certpoc',
  sandboxAccountId: '111111111111',
  region: 'us-east-1',
  alertEmail: 'alerts@example.com',
  monthlyBudgetUsd: 25,
  requireMfa: true,
  enableAwsConfig: true,
  appBootstrapQualifier: 'certapp',
  logRetentionDays: 90,
  vpc: { cidr: '10.40.0.0/16', maxAzs: 2, interfaceEndpoints: [] },
  forbiddenAccountIds: ['999999999999'],
};

function build(overrides: Partial<FoundationConfig> = {}) {
  const cfg = validateConfig({ ...baseConfig, ...overrides });
  const app = new cdk.App();
  const env = { account: cfg.sandboxAccountId, region: cfg.region };
  const security = new SecurityStack(app, 'certpoc-foundation-security', { env, cfg });
  const network = new NetworkStack(app, 'certpoc-foundation-network', { env, cfg, logsKey: security.logsKey });
  const iamStack = new IamBaselineStack(app, 'certpoc-foundation-iam', {
    env, cfg,
    logsKey: security.logsKey, dataKey: security.dataKey, secretsKey: security.secretsKey,
    trailArn: security.trailArn, trailBucket: security.trailBucket,
    auditLogGroups: [security.trailLogGroup, network.flowLogGroup],
  });
  cdk.Aspects.of(app).add(new AwsSolutionsChecks());
  return { app, cfg, security, network, iamStack };
}

/** Finds the statement with the given Sid in a synthesized managed policy. */
function statement(template: Template, policyName: string, sid: string): any {
  const policies = template.findResources('AWS::IAM::ManagedPolicy', { Properties: { ManagedPolicyName: policyName } });
  const [policy] = Object.values(policies);
  expect(policy).toBeDefined();
  const found = policy.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === sid);
  expect(found).toBeDefined();
  return found;
}

const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

describe('config guard', () => {
  test('rejects the placeholder account id', () => {
    expect(() => validateConfig({ ...baseConfig, sandboxAccountId: '000000000000' })).toThrow(/placeholder/);
  });

  test('refuses to target a forbidden (production) account', () => {
    expect(() => validateConfig({ ...baseConfig, sandboxAccountId: '999999999999' })).toThrow(/forbiddenAccountIds/);
  });

  test('rejects the default CDK qualifier for app stacks', () => {
    expect(() => validateConfig({ ...baseConfig, appBootstrapQualifier: 'hnb659fds' })).toThrow(/appBootstrapQualifier/);
  });

  test('reports every problem at once', () => {
    expect(() => validateConfig({ ...baseConfig, region: 'nowhere', alertEmail: 'nope', logRetentionDays: 10 }))
      .toThrow(/region[\s\S]*alertEmail[\s\S]*logRetentionDays/);
  });

  test('loads a config file saved with a UTF-8 byte-order mark (Notepad, PowerShell 5)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'certpoc-')), 'sandbox.json');
    fs.writeFileSync(file, '﻿' + JSON.stringify(baseConfig));
    expect(loadConfig(file).sandboxAccountId).toBe('111111111111');
  });

  test('every stack is pinned to the sandbox account', () => {
    const { security, network, iamStack } = build();
    for (const stack of [security, network, iamStack]) {
      expect(stack.account).toBe('111111111111');
      expect(stack.region).toBe('us-east-1');
    }
  });
});

describe('security stack', () => {
  const { security } = build();
  const t = Template.fromStack(security);

  test('CloudTrail is multi-region, validated, KMS-encrypted and sent to CloudWatch Logs', () => {
    t.hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: 'certpoc-audit-trail',
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      KMSKeyId: Match.anyValue(),
      CloudWatchLogsLogGroupArn: Match.anyValue(),
    });
  });

  test('three customer-managed keys, all with rotation', () => {
    t.resourcePropertiesCountIs('AWS::KMS::Key', { EnableKeyRotation: true }, 3);
    for (const alias of ['logs', 'data', 'secrets']) {
      t.hasResourceProperties('AWS::KMS::Alias', { AliasName: `alias/certpoc/${alias}` });
    }
  });

  test('CloudTrail may only use the logs key for this one trail', () => {
    t.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([Match.objectLike({
          Sid: 'AllowCloudTrailEncrypt',
          Condition: Match.objectLike({ StringEquals: { 'aws:SourceArn': Match.anyValue() } }),
        })]),
      },
    });
  });

  test('trail bucket is private, versioned, TLS-only and KMS-encrypted', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({
        ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
      })] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('alarms on root use, denied calls, console without MFA, trail changes and key deletion', () => {
    t.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    t.resourceCountIs('AWS::Logs::MetricFilter', 5);
  });

  test('monthly budget with email alerts', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 25, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
    });
  });

  test('AWS Config recorder and rules, including certificate expiry', () => {
    t.resourceCountIs('AWS::Config::ConfigurationRecorder', 1);
    t.hasResourceProperties('AWS::Config::ConfigRule', {
      Source: { Owner: 'AWS', SourceIdentifier: 'ACM_CERTIFICATE_EXPIRATION_CHECK' },
    });
  });

  test('AWS Config can be switched off', () => {
    const off = Template.fromStack(build({ enableAwsConfig: false }).security);
    off.resourceCountIs('AWS::Config::ConfigurationRecorder', 0);
    off.resourceCountIs('AWS::Config::ConfigRule', 0);
  });

  test('account-wide S3 public access block and password policy', () => {
    const calls = JSON.stringify(t.findResources('Custom::AWS'));
    expect(calls).toContain('putPublicAccessBlock');
    expect(calls).toContain('updateAccountPasswordPolicy');
  });
});

describe('network stack', () => {
  const { network } = build();
  const t = Template.fromStack(network);

  test('no NAT gateways (they cost about $32/month each)', () => {
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('public and isolated subnets spread over the first available AZs', () => {
    t.resourceCountIs('AWS::EC2::Subnet', 4);
    const azs = Object.values(t.findResources('AWS::EC2::Subnet')).map((s: any) => JSON.stringify(s.Properties.AvailabilityZone));
    expect(new Set(azs)).toEqual(new Set([0, 1].map((i) => JSON.stringify({ 'Fn::Select': [i, { 'Fn::GetAZs': '' }] }))));
  });

  test('flow logs on and free gateway endpoints for S3 and DynamoDB', () => {
    t.resourceCountIs('AWS::EC2::FlowLog', 1);
    t.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' }, 2);
    t.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface' }, 0);
  });

  test('app security group allows only outbound HTTPS', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'certpoc-app',
      SecurityGroupEgress: [Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })],
    });
  });

  test('interface endpoints are opt-in', () => {
    const withKms = Template.fromStack(build({ vpc: { ...baseConfig.vpc, interfaceEndpoints: ['kms', 'secretsmanager'] } }).network);
    withKms.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface' }, 2);
  });
});

describe('IAM baseline', () => {
  const { iamStack } = build();
  const t = Template.fromStack(iamStack);

  test('boundary and execution policy forbid stopping the trail or deleting the foundation keys', () => {
    for (const policy of ['certpoc-foundation-workload-boundary', 'certpoc-foundation-app-cfn-exec', 'certpoc-foundation-protect']) {
      expect(statement(t, policy, 'ProtectAuditTrail').Effect).toBe('Deny');
      expect(asList(statement(t, policy, 'ProtectAuditTrail').Action)).toContain('cloudtrail:StopLogging');
      expect(asList(statement(t, policy, 'ProtectFoundationKeys').Action)).toContain('kms:ScheduleKeyDeletion');
    }
  });

  test('app stacks can only create roles that carry the workload boundary', () => {
    const create = statement(t, 'certpoc-foundation-app-cfn-exec', 'CreateRolesOnlyWithBoundary');
    expect(asList(create.Action)).toContain('iam:CreateRole');
    expect(JSON.stringify(create.Condition)).toContain('policy/certpoc-foundation-workload-boundary');
  });

  test('AI roles are denied secret values, private keys and permission changes', () => {
    expect(asList(statement(t, 'certpoc-foundation-deny-secret-material', 'NoSecretValues').Action))
      .toContain('secretsmanager:GetSecretValue');
    expect(asList(statement(t, 'certpoc-foundation-deny-secret-material', 'NoPrivateKeysOrCertExport').Action))
      .toContain('acm:ExportCertificate');
    expect(asList(statement(t, 'certpoc-foundation-deny-secret-material', 'NoPermissionChanges').Action)).toContain('iam:*');
  });

  test('developers deploy only through the app bootstrap roles', () => {
    const assume = statement(t, 'certpoc-foundation-developer-access', 'DeployThroughAppBootstrapOnly');
    expect(JSON.stringify(assume.Resource)).toContain('role/cdk-certapp-*');
  });

  test('human roles require MFA', () => {
    for (const roleName of ['certpoc-admin', 'certpoc-developer', 'certpoc-auditor']) {
      t.hasResourceProperties('AWS::IAM::Role', {
        RoleName: roleName,
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } } })],
        },
      });
    }
  });

  test('MFA requirement can be turned off (for example with IAM Identity Center)', () => {
    const noMfa = Template.fromStack(build({ requireMfa: false }).iamStack);
    const roles = Object.values(noMfa.findResources('AWS::IAM::Role'));
    expect(JSON.stringify(roles)).not.toContain('aws:MultiFactorAuthPresent');
  });

  test('admin sessions are short', () => {
    t.hasResourceProperties('AWS::IAM::Role', { RoleName: 'certpoc-admin', MaxSessionDuration: 3600 });
  });

  test('every managed policy fits the 6,144-character IAM limit', () => {
    for (const [id, policy] of Object.entries(t.findResources('AWS::IAM::ManagedPolicy'))) {
      const doc = JSON.stringify((policy as any).Properties.PolicyDocument);
      // Intrinsic functions become ARNs of about 70 characters once deployed.
      const estimate = doc.replace(/\{"Fn::[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, 'x'.repeat(70)).length;
      expect({ id, estimate }).toEqual({ id, estimate: expect.any(Number) });
      expect(estimate).toBeLessThan(6144);
    }
  });
});

describe('cdk-nag (AWS Solutions rules)', () => {
  const { security, network, iamStack } = build();
  test.each([
    ['security', security],
    ['network', network],
    ['iam', iamStack],
  ])('%s stack has no unacknowledged findings', (_name, stack) => {
    const nag = Match.stringLikeRegexp('AwsSolutions-.*');
    expect(Annotations.fromStack(stack).findError('*', nag)).toEqual([]);
    expect(Annotations.fromStack(stack).findWarning('*', nag)).toEqual([]);
  });
});

describe('app guardrails for teammates', () => {
  test('an app stack gets the workload boundary and the restricted bootstrap', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'certpoc-cert-service', appStackProps(baseConfig));
    new lambda.Function(stack, 'RequestCert', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
    });
    applyAppGuardrails(stack, baseConfig);
    const t = Template.fromStack(stack);

    const roles = Object.values(t.findResources('AWS::IAM::Role'));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(JSON.stringify((role as any).Properties.PermissionsBoundary)).toContain('policy/certpoc-foundation-workload-boundary');
    }
    expect(JSON.stringify(t.toJSON())).toContain('/cdk-bootstrap/certapp/version');
  });

  test('app stack names must start with the prefix and stay out of the foundation namespace', () => {
    const app = new cdk.App();
    expect(() => applyAppGuardrails(new cdk.Stack(app, 'CertService', appStackProps(baseConfig)), baseConfig)).toThrow(/must be named/);
    expect(() => applyAppGuardrails(new cdk.Stack(app, 'certpoc-foundation-x', appStackProps(baseConfig)), baseConfig)).toThrow(/must be named/);
  });
});
