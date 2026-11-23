import * as cdk from "aws-cdk-lib/core";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as config from "aws-cdk-lib/aws-config";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { FoundationConfig, foundationParameterName } from "./config";

export interface SecurityStackProps extends cdk.StackProps {
    readonly cfg: FoundationConfig;
}

/**
 * Account-wide security baseline: customer-managed KMS keys, an encrypted multi-region
 * CloudTrail with alarms on risky events, AWS Config, a cost budget, and account settings
 * CloudFormation has no resource for (S3 public access block, IAM password policy).
 */
export class SecurityStack extends cdk.Stack {
    /** Encrypts audit data: CloudTrail, CloudWatch Logs, VPC flow logs, the alert topic. */
    readonly logsKey: kms.Key;
    /** For application data: DynamoDB inventory and policy tables, S3 reports, queues. */
    readonly dataKey: kms.Key;
    /** For Secrets Manager secrets (the password feature, step 6). AI roles are denied decrypt on it. */
    readonly secretsKey: kms.Key;
    readonly trailBucket: s3.Bucket;
    readonly trailLogGroup: logs.LogGroup;
    readonly trailArn: string;
    readonly alertTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: SecurityStackProps) {
        super(scope, id, props);
        const { cfg } = props;
        const p = cfg.prefix;
        const retention = cfg.logRetentionDays as logs.RetentionDays;
        const trailName = `${p}-audit-trail`;
        // Built as a string (not trail.trailArn) so the key policy can name the trail without a dependency cycle.
        this.trailArn = `arn:${this.partition}:cloudtrail:${this.region}:${this.account}:trail/${trailName}`;

        // ---------------------------------------------------------------- KMS keys
        const key = (
            keyId: string,
            alias: string,
            description: string,
            removalPolicy: cdk.RemovalPolicy,
        ) =>
            new kms.Key(this, keyId, {
                alias: `alias/${p}/${alias}`,
                description,
                enableKeyRotation: true,
                pendingWindow: cdk.Duration.days(7),
                removalPolicy,
            });

        // The logs key is kept on stack deletion: deleting it would make the retained audit logs unreadable.
        this.logsKey = key(
            "LogsKey",
            "logs",
            `${p}: CloudTrail, CloudWatch Logs, flow logs, alerts`,
            cdk.RemovalPolicy.RETAIN,
        );
        this.dataKey = key(
            "DataKey",
            "data",
            `${p}: application data (DynamoDB, S3, SQS)`,
            cdk.RemovalPolicy.DESTROY,
        );
        this.secretsKey = key(
            "SecretsKey",
            "secrets",
            `${p}: Secrets Manager secrets`,
            cdk.RemovalPolicy.DESTROY,
        );

        // CloudTrail writes encrypted log files (scoped to this trail only).
        this.logsKey.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: "AllowCloudTrailEncrypt",
                principals: [
                    new iam.ServicePrincipal("cloudtrail.amazonaws.com"),
                ],
                actions: ["kms:GenerateDataKey*"],
                resources: ["*"],
                conditions: {
                    StringEquals: { "aws:SourceArn": this.trailArn },
                    StringLike: {
                        "kms:EncryptionContext:aws:cloudtrail:arn": `arn:${this.partition}:cloudtrail:*:${this.account}:trail/*`,
                    },
                },
            }),
        );
        this.logsKey.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: "AllowCloudTrailDescribeKey",
                principals: [
                    new iam.ServicePrincipal("cloudtrail.amazonaws.com"),
                ],
                actions: ["kms:DescribeKey"],
                resources: ["*"],
                conditions: {
                    StringEquals: { "aws:SourceArn": this.trailArn },
                },
            }),
        );
        // CloudWatch Logs encrypts log groups in this account and region.
        this.logsKey.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: "AllowCloudWatchLogs",
                principals: [
                    new iam.ServicePrincipal(
                        `logs.${this.region}.amazonaws.com`,
                    ),
                ],
                actions: [
                    "kms:Encrypt*",
                    "kms:Decrypt*",
                    "kms:ReEncrypt*",
                    "kms:GenerateDataKey*",
                    "kms:Describe*",
                ],
                resources: ["*"],
                conditions: {
                    ArnLike: {
                        "kms:EncryptionContext:aws:logs:arn": `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
                    },
                },
            }),
        );
        // CloudWatch alarms publish to the encrypted alert topic.
        this.logsKey.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: "AllowCloudWatchAlarmsToEncryptedTopic",
                principals: [
                    new iam.ServicePrincipal("cloudwatch.amazonaws.com"),
                ],
                actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
                resources: ["*"],
                conditions: {
                    StringEquals: { "aws:SourceAccount": this.account },
                },
            }),
        );

        // ---------------------------------------------------------------- alerts
        this.alertTopic = new sns.Topic(this, "AlertTopic", {
            topicName: `${p}-security-alerts`,
            displayName: `${p} security alerts`,
            masterKey: this.logsKey,
            enforceSSL: true,
        });
        this.alertTopic.addSubscription(
            new subs.EmailSubscription(cfg.alertEmail),
        );

        // ---------------------------------------------------------------- audit log storage
        const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
            // S3 server access logging can only deliver to SSE-S3 buckets.
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            lifecycleRules: [
                { expiration: cdk.Duration.days(cfg.logRetentionDays) },
            ],
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.trailBucket = new s3.Bucket(this, "TrailBucket", {
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: this.logsKey,
            bucketKeyEnabled: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: "trail-bucket/",
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(cfg.logRetentionDays),
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
            // Audit evidence outlives the stack.
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.trailLogGroup = new logs.LogGroup(this, "TrailLogGroup", {
            logGroupName: `/${p}/cloudtrail`,
            encryptionKey: this.logsKey,
            retention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ---------------------------------------------------------------- CloudTrail
        const trail = new cloudtrail.Trail(this, "AuditTrail", {
            trailName,
            bucket: this.trailBucket,
            encryptionKey: this.logsKey,
            cloudWatchLogGroup: this.trailLogGroup,
            sendToCloudWatchLogs: true,
            isMultiRegionTrail: true,
            includeGlobalServiceEvents: true,
            enableFileValidation: true,
            managementEvents: cloudtrail.ReadWriteType.ALL,
        });
        trail.node.addDependency(this.logsKey);

        // CloudWatch alarms on the trail (CIS AWS Foundations style). Each alarm costs about $0.10/month.
        const alarmOn = (
            alarmId: string,
            metricName: string,
            pattern: string,
            description: string,
            threshold = 1,
        ) => {
            const filter = new logs.MetricFilter(this, `${alarmId}Filter`, {
                logGroup: this.trailLogGroup,
                filterPattern: logs.FilterPattern.literal(pattern),
                metricNamespace: `${p}/Security`,
                metricName,
                metricValue: "1",
                defaultValue: 0,
            });
            const alarm = new cloudwatch.Alarm(this, `${alarmId}Alarm`, {
                alarmName: `${p}-${metricName}`,
                alarmDescription: description,
                metric: filter.metric({
                    statistic: "Sum",
                    period: cdk.Duration.minutes(5),
                }),
                threshold,
                evaluationPeriods: 1,
                comparisonOperator:
                    cloudwatch.ComparisonOperator
                        .GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            alarm.addAlarmAction(new cwActions.SnsAction(this.alertTopic));
        };
        alarmOn(
            "RootUsage",
            "RootAccountUsage",
            '{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }',
            "The root user was used. Root should only be used for account-level tasks.",
        );
        // Threshold 5: access-control tests (step 5, step 10) deliberately trigger a few denials.
        alarmOn(
            "Unauthorized",
            "UnauthorizedApiCalls",
            '{ ($.errorCode = "*UnauthorizedOperation") || ($.errorCode = "AccessDenied*") }',
            "Five or more denied API calls in 5 minutes.",
            5,
        );
        alarmOn(
            "ConsoleNoMfa",
            "ConsoleLoginWithoutMfa",
            '{ ($.eventName = "ConsoleLogin") && ($.additionalEventData.MFAUsed != "Yes") && ($.userIdentity.type = "IAMUser") && ($.responseElements.ConsoleLogin = "Success") }',
            "An IAM user signed in to the console without MFA.",
        );
        alarmOn(
            "TrailChanged",
            "CloudTrailChanged",
            '{ ($.eventName = "StopLogging") || ($.eventName = "DeleteTrail") || ($.eventName = "UpdateTrail") || ($.eventName = "PutEventSelectors") }',
            "Someone stopped, deleted or changed a CloudTrail trail.",
        );
        alarmOn(
            "KeyDisabled",
            "KmsKeyDisabledOrScheduledForDeletion",
            '{ ($.eventSource = "kms.amazonaws.com") && (($.eventName = "DisableKey") || ($.eventName = "ScheduleKeyDeletion")) }',
            "A KMS key was disabled or scheduled for deletion.",
        );

        // ---------------------------------------------------------------- AWS Config
        if (cfg.enableAwsConfig) {
            const configRole = new iam.Role(this, "ConfigRole", {
                assumedBy: new iam.ServicePrincipal("config.amazonaws.com"),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        "service-role/AWS_ConfigRole",
                    ),
                ],
            });
            this.trailBucket.grantPut(
                configRole,
                `config/AWSLogs/${this.account}/Config/*`,
            );
            configRole.addToPolicy(
                new iam.PolicyStatement({
                    actions: ["s3:GetBucketAcl", "s3:ListBucket"],
                    resources: [this.trailBucket.bucketArn],
                }),
            );
            NagSuppressions.addResourceSuppressions(
                configRole,
                [
                    {
                        id: "AwsSolutions-IAM4",
                        reason: "AWS_ConfigRole is the AWS-maintained policy Config needs to read resource configuration.",
                    },
                    {
                        id: "AwsSolutions-IAM5",
                        reason: "Wildcards come from the scoped S3 prefix and KMS grant helpers; all target foundation resources.",
                    },
                ],
                true,
            );

            const recorder = new config.CfnConfigurationRecorder(
                this,
                "ConfigRecorder",
                {
                    name: `${p}-recorder`,
                    roleArn: configRole.roleArn,
                    // Only the resource types this POC uses, recorded daily: keeps Config to a few cents a month.
                    recordingGroup: {
                        allSupported: false,
                        includeGlobalResourceTypes: false,
                        resourceTypes: [
                            "AWS::ACM::Certificate",
                            "AWS::ACMPCA::CertificateAuthority",
                            "AWS::KMS::Key",
                            "AWS::SecretsManager::Secret",
                            "AWS::S3::Bucket",
                            "AWS::DynamoDB::Table",
                            "AWS::Lambda::Function",
                            "AWS::IAM::Role",
                            "AWS::IAM::Policy",
                            "AWS::CloudTrail::Trail",
                            "AWS::EC2::SecurityGroup",
                            "AWS::EC2::VPC",
                        ],
                    },
                    recordingMode: { recordingFrequency: "DAILY" },
                },
            );
            const channel = new config.CfnDeliveryChannel(
                this,
                "ConfigDeliveryChannel",
                {
                    name: `${p}-delivery`,
                    s3BucketName: this.trailBucket.bucketName,
                    s3KeyPrefix: "config",
                    s3KmsKeyArn: this.logsKey.keyArn,
                    snsTopicArn: this.alertTopic.topicArn,
                    configSnapshotDeliveryProperties: {
                        deliveryFrequency: "TwentyFour_Hours",
                    },
                },
            );
            channel.addResourceDependency(recorder);
            this.alertTopic.grantPublish(configRole);
            this.logsKey.grantEncryptDecrypt(configRole);

            const rules: [string, string, Record<string, unknown>?][] = [
                [
                    "CloudTrailEnabled",
                    config.ManagedRuleIdentifiers.CLOUD_TRAIL_ENABLED,
                ],
                [
                    "CloudTrailEncrypted",
                    config.ManagedRuleIdentifiers
                        .CLOUD_TRAIL_ENCRYPTION_ENABLED,
                ],
                [
                    "KeyRotation",
                    config.ManagedRuleIdentifiers
                        .CMK_BACKING_KEY_ROTATION_ENABLED,
                ],
                [
                    "KeyNotPendingDeletion",
                    config.ManagedRuleIdentifiers
                        .KMS_CMK_NOT_SCHEDULED_FOR_DELETION,
                ],
                [
                    "S3NoPublicRead",
                    config.ManagedRuleIdentifiers
                        .S3_BUCKET_PUBLIC_READ_PROHIBITED,
                ],
                [
                    "S3SslOnly",
                    config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
                ],
                [
                    "RootMfa",
                    config.ManagedRuleIdentifiers.ROOT_ACCOUNT_MFA_ENABLED,
                ],
                [
                    "NoRootAccessKeys",
                    config.ManagedRuleIdentifiers.IAM_ROOT_ACCESS_KEY_CHECK,
                ],
                // Ties into the certificate service: flags certificates that expire within 30 days.
                [
                    "CertExpiry",
                    config.ManagedRuleIdentifiers
                        .ACM_CERTIFICATE_EXPIRATION_CHECK,
                    { daysToExpiration: 30 },
                ],
            ];
            for (const [ruleId, identifier, inputParameters] of rules) {
                const rule = new config.ManagedRule(this, ruleId, {
                    configRuleName: `${p}-${ruleId}`,
                    identifier,
                    inputParameters,
                });
                rule.node.addDependency(channel);
            }
        }

        // ---------------------------------------------------------------- cost budget
        new budgets.CfnBudget(this, "MonthlyBudget", {
            budget: {
                budgetName: `${p}-monthly`,
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: "USD" },
            },
            notificationsWithSubscribers: [
                ["ACTUAL", 50],
                ["ACTUAL", 80],
                ["ACTUAL", 100],
                ["FORECASTED", 100],
            ].map(([notificationType, threshold]) => ({
                notification: {
                    notificationType: notificationType as string,
                    comparisonOperator: "GREATER_THAN",
                    threshold: threshold as number,
                    thresholdType: "PERCENTAGE",
                },
                subscribers: [
                    { subscriptionType: "EMAIL", address: cfg.alertEmail },
                ],
            })),
        });

        // ---------------------------------------------------------------- account settings without a CloudFormation resource
        const blockPublicS3 = new cr.AwsCustomResource(
            this,
            "AccountS3PublicAccessBlock",
            {
                onUpdate: {
                    service: "S3Control",
                    action: "putPublicAccessBlock",
                    parameters: {
                        AccountId: this.account,
                        PublicAccessBlockConfiguration: {
                            BlockPublicAcls: true,
                            IgnorePublicAcls: true,
                            BlockPublicPolicy: true,
                            RestrictPublicBuckets: true,
                        },
                    },
                    physicalResourceId: cr.PhysicalResourceId.of(
                        `${p}-account-s3-public-access-block`,
                    ),
                },
                policy: cr.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        actions: ["s3:PutAccountPublicAccessBlock"],
                        resources: ["*"],
                    }),
                ]),
                installLatestAwsSdk: false,
            },
        );
        const passwordPolicy = new cr.AwsCustomResource(
            this,
            "AccountPasswordPolicy",
            {
                onUpdate: {
                    service: "IAM",
                    action: "updateAccountPasswordPolicy",
                    parameters: {
                        MinimumPasswordLength: 14,
                        RequireSymbols: true,
                        RequireNumbers: true,
                        RequireUppercaseCharacters: true,
                        RequireLowercaseCharacters: true,
                        AllowUsersToChangePassword: true,
                        MaxPasswordAge: 90,
                        PasswordReusePrevention: 24,
                    },
                    physicalResourceId: cr.PhysicalResourceId.of(
                        `${p}-account-password-policy`,
                    ),
                },
                policy: cr.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        actions: ["iam:UpdateAccountPasswordPolicy"],
                        resources: ["*"],
                    }),
                ]),
                installLatestAwsSdk: false,
            },
        );
        for (const res of [blockPublicS3, passwordPolicy]) {
            NagSuppressions.addResourceSuppressions(
                res,
                [
                    {
                        id: "AwsSolutions-IAM5",
                        reason: 'Account-level APIs have no resource ARN, so "*" is the only valid resource.',
                    },
                ],
                true,
            );
        }
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287`,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "CDK-managed singleton Lambda for AwsCustomResource uses AWSLambdaBasicExecutionRole for its logs.",
                },
                {
                    id: "AwsSolutions-L1",
                    reason: "Runtime of the CDK-managed AwsCustomResource Lambda is set by aws-cdk-lib.",
                },
            ],
            true,
        );

        // ---------------------------------------------------------------- outputs for the app stacks
        const param = (paramKey: string, value: string, description: string) =>
            new ssm.StringParameter(
                this,
                `Param-${paramKey.replace(/\//g, "-")}`,
                {
                    parameterName: foundationParameterName(p, paramKey),
                    stringValue: value,
                    description,
                },
            );
        param(
            "kms/logs-key-arn",
            this.logsKey.keyArn,
            "KMS key for logs and audit data",
        );
        param(
            "kms/data-key-arn",
            this.dataKey.keyArn,
            "KMS key for application data (DynamoDB, S3, SQS)",
        );
        param(
            "kms/secrets-key-arn",
            this.secretsKey.keyArn,
            "KMS key for Secrets Manager secrets",
        );
        param(
            "cloudtrail/log-group-name",
            this.trailLogGroup.logGroupName,
            "CloudTrail log group (input for the anomaly-detection feature)",
        );
        param(
            "cloudtrail/bucket-name",
            this.trailBucket.bucketName,
            "CloudTrail S3 bucket",
        );
        param(
            "alerts/topic-arn",
            this.alertTopic.topicArn,
            "SNS topic for security alerts",
        );
    }
}
