import * as cdk from 'aws-cdk-lib/core';
import * as accessanalyzer from 'aws-cdk-lib/aws-accessanalyzer';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { FoundationConfig, foundationParameterName } from './config';

export interface IamBaselineStackProps extends cdk.StackProps {
  readonly cfg: FoundationConfig;
  readonly logsKey: kms.IKey;
  readonly dataKey: kms.IKey;
  readonly secretsKey: kms.IKey;
  readonly trailArn: string;
  readonly trailBucket: s3.IBucket;
  readonly auditLogGroups: logs.ILogGroup[];
}

/** Managed policy names. App stacks reference the boundary and deny-secret-material policies by name. */
export const policyNames = (prefix: string) => ({
  workloadBoundary: `${prefix}-foundation-workload-boundary`,
  protectFoundation: `${prefix}-foundation-protect`,
  denySecretMaterial: `${prefix}-foundation-deny-secret-material`,
  appCfnExecution: `${prefix}-foundation-app-cfn-exec`,
  developerAccess: `${prefix}-foundation-developer-access`,
  auditorAccess: `${prefix}-foundation-auditor-access`,
});

/**
 * Least-privilege IAM baseline:
 *  - a permissions boundary that every role created by the app stacks must carry,
 *  - explicit denies that stop anyone but the admin from weakening the foundation,
 *  - a deny-secret-material policy for AI roles (they never read secrets or private keys),
 *  - the CloudFormation execution policy for the app bootstrap,
 *  - admin, developer and auditor roles for people.
 */
export class IamBaselineStack extends cdk.Stack {
  readonly workloadBoundary: iam.ManagedPolicy;
  readonly protectFoundation: iam.ManagedPolicy;
  readonly denySecretMaterial: iam.ManagedPolicy;
  readonly appCfnExecutionPolicy: iam.ManagedPolicy;
  readonly adminRole: iam.Role;
  readonly developerRole: iam.Role;
  readonly auditorRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamBaselineStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const p = cfg.prefix;
    const names = policyNames(p);
    const arn = (service: string, resource: string, region = '', account = this.account) =>
      `arn:${this.partition}:${service}:${region}:${account}:${resource}`;
    const iamArn = (resource: string) => arn('iam', resource);
    const appRoles = iamArn(`role/${p}-*`);
    const foundationRoles = [
      iamArn(`role/${p}-foundation-*`), iamArn(`role/${p}-admin`), iamArn(`role/${p}-developer`),
      iamArn(`role/${p}-auditor`), iamArn('role/cdk-*'),
    ];
    const foundationPolicies = iamArn(`policy/${p}-foundation-*`);
    const keyArns = [props.logsKey.keyArn, props.dataKey.keyArn, props.secretsKey.keyArn];
    const auditLogArns = props.auditLogGroups.flatMap((g) => [g.logGroupArn, `${g.logGroupArn}:*`]);
    const regions = [...new Set([cfg.region, 'us-east-1'])];

    // ---------------------------------------------------------------- guardrails shared by every policy below
    const protectStatements = [
      new iam.PolicyStatement({
        sid: 'ProtectAuditTrail',
        effect: iam.Effect.DENY,
        actions: ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'cloudtrail:UpdateTrail',
          'cloudtrail:PutEventSelectors', 'cloudtrail:PutInsightSelectors'],
        resources: [props.trailArn],
      }),
      new iam.PolicyStatement({
        sid: 'ProtectAuditBucket',
        effect: iam.Effect.DENY,
        actions: ['s3:DeleteBucket', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutLifecycleConfiguration',
          's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock',
          's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObject'],
        resources: [props.trailBucket.bucketArn, props.trailBucket.arnForObjects('*')],
      }),
      new iam.PolicyStatement({
        sid: 'ProtectAuditLogs',
        effect: iam.Effect.DENY,
        actions: ['logs:DeleteLogGroup', 'logs:DeleteLogStream', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy',
          'logs:AssociateKmsKey', 'logs:DisassociateKmsKey', 'logs:DeleteMetricFilter', 'logs:PutMetricFilter'],
        resources: auditLogArns,
      }),
      new iam.PolicyStatement({
        sid: 'ProtectFoundationKeys',
        effect: iam.Effect.DENY,
        actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:DisableKeyRotation', 'kms:PutKeyPolicy',
          'kms:UpdatePrimaryRegion'],
        resources: keyArns,
      }),
      new iam.PolicyStatement({
        sid: 'ProtectMonitoring',
        effect: iam.Effect.DENY,
        actions: ['config:StopConfigurationRecorder', 'config:DeleteConfigurationRecorder', 'config:PutConfigurationRecorder',
          'config:DeleteDeliveryChannel', 'config:PutDeliveryChannel', 'ec2:DeleteFlowLogs',
          'access-analyzer:DeleteAnalyzer', 'organizations:LeaveOrganization',
          'iam:UpdateAccountPasswordPolicy', 'iam:DeleteAccountPasswordPolicy', 's3:PutAccountPublicAccessBlock'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'ProtectFoundationIam',
        effect: iam.Effect.DENY,
        actions: ['iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy',
          'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary',
          'iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
          'iam:SetDefaultPolicyVersion', 'iam:DeletePolicy'],
        resources: [...foundationRoles, foundationPolicies],
      }),
      new iam.PolicyStatement({
        sid: 'KeepBoundaryOnAppRoles',
        effect: iam.Effect.DENY,
        actions: ['iam:DeleteRolePermissionsBoundary'],
        resources: [appRoles],
      }),
      new iam.PolicyStatement({
        sid: 'NoLongTermCredentials',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreateLoginProfile', 'iam:UpdateLoginProfile',
          'iam:AttachUserPolicy', 'iam:PutUserPolicy', 'iam:AddUserToGroup'],
        resources: ['*'],
      }),
    ];

    this.protectFoundation = new iam.ManagedPolicy(this, 'ProtectFoundation', {
      managedPolicyName: names.protectFoundation,
      description: 'Denies weakening the audit trail, keys, logs, monitoring and foundation IAM. Attach to every non-admin principal.',
      statements: protectStatements,
    });

    // ---------------------------------------------------------------- permissions boundary for app workloads
    this.workloadBoundary = new iam.ManagedPolicy(this, 'WorkloadBoundary', {
      managedPolicyName: names.workloadBoundary,
      description: 'Maximum permissions of any role created by the app stacks (Lambda, Step Functions, ECS ...).',
      statements: [
        new iam.PolicyStatement({
          sid: 'ProjectServicesInRegion',
          actions: [
            'acm:*', 'acm-pca:*', 'secretsmanager:*', 'dynamodb:*', 's3:*', 'states:*', 'events:*', 'scheduler:*',
            'apigateway:*', 'execute-api:*', 'cognito-idp:*', 'verifiedpermissions:*', 'sqs:*', 'sns:Publish',
            'lambda:InvokeFunction', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
            'logs:StartQuery', 'logs:GetQueryResults', 'logs:FilterLogEvents', 'logs:GetLogEvents',
            'cloudwatch:PutMetricData', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
            'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'cloudtrail:LookupEvents',
            'config:Describe*', 'config:Get*', 'config:List*', 'config:SelectResourceConfig',
            'bedrock:InvokeModel*', 'bedrock:Converse*', 'bedrock:ApplyGuardrail', 'bedrock:InvokeAgent',
            'bedrock:Retrieve*', 'bedrock:GetGuardrail', 'bedrock:GetInferenceProfile', 'bedrock:GetFoundationModel',
            'kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey',
            'kms:GenerateRandom', 'kms:CreateGrant',
            'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface', 'ec2:DescribeNetworkInterfaces',
            'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses', 'ec2:DescribeSubnets',
            'ec2:DescribeVpcs', 'ec2:DescribeSecurityGroups',
            'ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability',
          ],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': regions } },
        }),
        new iam.PolicyStatement({
          sid: 'Identity',
          actions: ['sts:GetCallerIdentity'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'PassOnlyAppRoles',
          actions: ['iam:PassRole'],
          resources: [appRoles],
          conditions: {
            StringEquals: {
              'iam:PassedToService': ['lambda.amazonaws.com', 'states.amazonaws.com', 'events.amazonaws.com',
                'scheduler.amazonaws.com', 'ecs-tasks.amazonaws.com'],
            },
          },
        }),
        ...protectStatements,
      ],
    });

    // ---------------------------------------------------------------- AI roles never touch secret material
    this.denySecretMaterial = new iam.ManagedPolicy(this, 'DenySecretMaterial', {
      managedPolicyName: names.denySecretMaterial,
      description: 'Attach to every role that calls Bedrock or reads model output: no secret values, private keys or exported certificates.',
      statements: [
        new iam.PolicyStatement({
          sid: 'NoSecretValues',
          effect: iam.Effect.DENY,
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:BatchGetSecretValue', 'secretsmanager:PutSecretValue',
            'secretsmanager:UpdateSecret', 'secretsmanager:RotateSecret', 'secretsmanager:RestoreSecret'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'NoPrivateKeysOrCertExport',
          effect: iam.Effect.DENY,
          actions: ['acm:ExportCertificate', 'acm-pca:IssueCertificate', 'acm-pca:RevokeCertificate',
            'acm-pca:DeleteCertificateAuthority', 'acm-pca:UpdateCertificateAuthority', 'acm-pca:ImportCertificateAuthorityCertificate'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'NoDecryptWithSecretsKey',
          effect: iam.Effect.DENY,
          actions: ['kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant'],
          resources: [props.secretsKey.keyArn],
        }),
        new iam.PolicyStatement({
          sid: 'NoPermissionChanges',
          effect: iam.Effect.DENY,
          actions: ['iam:*', 'verifiedpermissions:Create*', 'verifiedpermissions:Update*', 'verifiedpermissions:Delete*',
            'verifiedpermissions:Put*', 'cognito-idp:Admin*'],
          resources: ['*'],
        }),
      ],
    });

    // ---------------------------------------------------------------- CloudFormation execution policy for the app bootstrap
    this.appCfnExecutionPolicy = new iam.ManagedPolicy(this, 'AppCfnExecution', {
      managedPolicyName: names.appCfnExecution,
      description: `Execution policy for "cdk bootstrap --qualifier ${cfg.appBootstrapQualifier}". App stacks can only create roles that carry the workload boundary.`,
      statements: [
        new iam.PolicyStatement({
          sid: 'ManageProjectServices',
          actions: [
            'acm:*', 'acm-pca:*', 'apigateway:*', 'cognito-idp:*', 'verifiedpermissions:*', 'dynamodb:*', 's3:*',
            'lambda:*', 'states:*', 'events:*', 'scheduler:*', 'secretsmanager:*', 'sns:*', 'sqs:*', 'logs:*',
            'cloudwatch:*', 'ssm:*', 'bedrock:*', 'xray:*', 'cloudfront:*', 'amplify:*', 'ecr:*', 'ecs:*', 'ec2:*',
            'elasticloadbalancing:*', 'application-autoscaling:*',
            'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Get*',
            'kms:TagResource', 'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:Encrypt', 'kms:Decrypt',
            'kms:GenerateDataKey*', 'kms:DeleteAlias',
          ],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': regions } },
        }),
        new iam.PolicyStatement({
          sid: 'CreateRolesOnlyWithBoundary',
          actions: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary'],
          resources: [appRoles],
          conditions: { StringEquals: { 'iam:PermissionsBoundary': iamArn(`policy/${names.workloadBoundary}`) } },
        }),
        new iam.PolicyStatement({
          sid: 'ManageAppRoles',
          actions: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies',
            'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:TagRole', 'iam:UntagRole',
            'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy', 'iam:PassRole'],
          resources: [appRoles],
        }),
        new iam.PolicyStatement({
          sid: 'ManageAppPolicies',
          actions: ['iam:CreatePolicy', 'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
            'iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyVersions', 'iam:TagPolicy', 'iam:UntagPolicy'],
          resources: [iamArn(`policy/${p}-*`)],
        }),
        new iam.PolicyStatement({
          sid: 'NestedAppStacks',
          actions: ['cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack',
            'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:GetTemplate'],
          resources: [arn('cloudformation', `stack/${p}-*/*`, cfg.region)],
        }),
        new iam.PolicyStatement({
          sid: 'ServiceLinkedRoles',
          actions: ['iam:CreateServiceLinkedRole', 'iam:GetRole'],
          resources: [iamArn('role/aws-service-role/*')],
        }),
        ...protectStatements,
      ],
    });

    // ---------------------------------------------------------------- roles for people
    const trust = () => {
      const account = new iam.AccountPrincipal(this.account);
      return cfg.requireMfa ? account.withConditions({ Bool: { 'aws:MultiFactorAuthPresent': 'true' } }) : account;
    };

    this.adminRole = new iam.Role(this, 'AdminRole', {
      roleName: `${p}-admin`,
      description: 'Foundation owner. Deploys and changes the foundation stacks. Use sparingly.',
      assumedBy: trust(),
      maxSessionDuration: cdk.Duration.hours(1),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    const developerAccess = new iam.ManagedPolicy(this, 'DeveloperAccess', {
      managedPolicyName: names.developerAccess,
      description: 'Deploy app stacks through the app CDK bootstrap and exercise them; nothing else is writable.',
      statements: [
        new iam.PolicyStatement({
          sid: 'DeployThroughAppBootstrapOnly',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [iamArn(`role/cdk-${cfg.appBootstrapQualifier}-*`)],
        }),
        new iam.PolicyStatement({
          sid: 'ExerciseAppResources',
          actions: ['execute-api:Invoke', 'lambda:InvokeFunction', 'states:StartExecution', 'states:StopExecution',
            'states:StartSyncExecution', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
            'dynamodb:BatchWriteItem', 's3:PutObject', 's3:DeleteObject', 'events:PutEvents',
            'verifiedpermissions:IsAuthorized', 'verifiedpermissions:IsAuthorizedWithToken',
            'verifiedpermissions:BatchIsAuthorized', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword',
            'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminDeleteUser',
            'cognito-idp:AdminInitiateAuth'],
          resources: [
            arn('execute-api', '*', cfg.region), arn('lambda', `function:${p}-*`, cfg.region),
            arn('states', `stateMachine:${p}-*`, cfg.region), arn('states', `execution:${p}-*:*`, cfg.region),
            arn('dynamodb', `table/${p}-*`, cfg.region), `arn:${this.partition}:s3:::${p}-*/*`,
            arn('events', 'event-bus/*', cfg.region), arn('verifiedpermissions', 'policy-store/*'),
            arn('cognito-idp', 'userpool/*', cfg.region),
          ],
        }),
        new iam.PolicyStatement({
          sid: 'ExperimentWithBedrock',
          actions: ['bedrock:InvokeModel*', 'bedrock:Converse*', 'bedrock:ApplyGuardrail', 'bedrock:InvokeAgent'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': regions } },
        }),
        new iam.PolicyStatement({
          sid: 'UseDataKeyForTests',
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [props.dataKey.keyArn],
        }),
      ],
    });
    this.developerRole = new iam.Role(this, 'DeveloperRole', {
      roleName: `${p}-developer`,
      description: 'Team members building the app stacks. Read everything, write only through the app bootstrap.',
      assumedBy: trust(),
      maxSessionDuration: cdk.Duration.hours(4),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
        developerAccess,
        this.protectFoundation,
      ],
    });

    const auditorAccess = new iam.ManagedPolicy(this, 'AuditorAccess', {
      managedPolicyName: names.auditorAccess,
      description: 'Read the audit trail, flow logs and Config history.',
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadTrailBucket',
          actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
          resources: [props.trailBucket.bucketArn, props.trailBucket.arnForObjects('*')],
        }),
        new iam.PolicyStatement({
          sid: 'DecryptAuditData',
          actions: ['kms:Decrypt', 'kms:DescribeKey'],
          resources: [props.logsKey.keyArn],
        }),
        new iam.PolicyStatement({
          sid: 'QueryAuditLogs',
          actions: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery', 'logs:FilterLogEvents', 'logs:GetLogEvents',
            'logs:DescribeLogStreams'],
          resources: auditLogArns,
        }),
      ],
    });
    this.auditorRole = new iam.Role(this, 'AuditorRole', {
      roleName: `${p}-auditor`,
      description: 'Read-only security review: configuration, CloudTrail and logs. Cannot read secret values.',
      assumedBy: trust(),
      maxSessionDuration: cdk.Duration.hours(4),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('SecurityAudit'),
        auditorAccess,
        this.protectFoundation,
        this.denySecretMaterial,
      ],
    });

    // Reports resources shared outside the account (free for the account-level analyzer).
    new accessanalyzer.CfnAnalyzer(this, 'AccessAnalyzer', {
      analyzerName: `${p}-account-analyzer`,
      type: 'ACCOUNT',
    });

    // ---------------------------------------------------------------- outputs for the app stacks
    const param = (paramKey: string, value: string, description: string) =>
      new ssm.StringParameter(this, `Param-${paramKey.replace(/\//g, '-')}`, {
        parameterName: foundationParameterName(p, paramKey),
        stringValue: value,
        description,
      });
    param('iam/workload-boundary-arn', this.workloadBoundary.managedPolicyArn, 'Permissions boundary for every app role');
    param('iam/deny-secret-material-arn', this.denySecretMaterial.managedPolicyArn, 'Attach to every role that calls Bedrock');
    param('iam/app-cfn-exec-policy-arn', this.appCfnExecutionPolicy.managedPolicyArn, 'Execution policy for the app CDK bootstrap');
    new cdk.CfnOutput(this, 'AppBootstrapCommand', {
      description: 'Run once after the first foundation deploy, as the admin.',
      value: cdk.Fn.join('', [
        `npx cdk bootstrap aws://${this.account}/${cfg.region} --qualifier ${cfg.appBootstrapQualifier} `,
        `--toolkit-stack-name CDKToolkit-${cfg.appBootstrapQualifier} --cloudformation-execution-policies `,
        this.appCfnExecutionPolicy.managedPolicyArn,
      ]),
    });

    NagSuppressions.addResourceSuppressions([this.adminRole, this.developerRole, this.auditorRole], [
      { id: 'AwsSolutions-IAM4', reason: 'Human roles use AWS-maintained job-function policies (AdministratorAccess, ReadOnlyAccess, SecurityAudit) and are narrowed by explicit denies.' },
    ]);
    NagSuppressions.addResourceSuppressions(
      [this.workloadBoundary, this.appCfnExecutionPolicy, developerAccess, auditorAccess, this.protectFoundation, this.denySecretMaterial], [
        { id: 'AwsSolutions-IAM5', reason: 'Boundary and execution policies define the maximum service set, so they use service-level wildcards limited by region, role-name prefix and the required permissions boundary. Deny statements use wildcards on purpose.' },
      ]);
  }
}
