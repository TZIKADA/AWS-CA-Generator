# Step 3 · Foundation (Dolev)

The sandbox foundation for the **AI Certificate Management POC**: one dedicated AWS account, defined entirely
as code with AWS CDK (TypeScript), with a VPC, customer-managed KMS keys, CloudTrail and a least-privilege
IAM baseline. Every later step (cert service, access control, passwords, AI layer) deploys on top of it.

| Roadmap item | Where |
|---|---|
| Dedicated sandbox account, never production | Every stack is pinned to `sandboxAccountId`; CDK refuses to deploy with credentials for another account. `forbiddenAccountIds` blocks known production accounts outright. Account setup: step 1 below. |
| Everything as code | This CDK app: 3 stacks, 33 unit tests, cdk-nag security rules on every synth. |
| VPC | `certpoc-foundation-network` |
| KMS customer-managed keys | `certpoc-foundation-security` (logs, data, secrets keys, all with rotation) |
| CloudTrail | `certpoc-foundation-security` (multi-region, encrypted, validated, with alarms) |
| Least-privilege IAM baseline | `certpoc-foundation-iam` |

## What gets created

**`certpoc-foundation-security`**
- 3 KMS keys with yearly rotation: `alias/certpoc/logs` (audit data), `alias/certpoc/data` (DynamoDB, S3, SQS),
  `alias/certpoc/secrets` (Secrets Manager).
- CloudTrail `certpoc-audit-trail`: all regions plus global services, log file validation, encrypted with the
  logs key. It writes to a private, versioned, TLS-only S3 bucket and to the CloudWatch log group `/certpoc/cloudtrail`,
  which is the input for the AI anomaly detection in step 7.
- 5 alarms on the trail, emailed through an encrypted SNS topic: root user used, 5+ denied calls in 5 minutes,
  console login without MFA, trail changed or stopped, KMS key disabled or scheduled for deletion.
- AWS Config (only the resource types this POC uses, recorded daily) with 9 rules. These include
  `ACM_CERTIFICATE_EXPIRATION_CHECK` (30 days), root MFA, no root access keys, key rotation, and S3 public access and TLS.
- A monthly budget with email alerts at 50%, 80% and 100%, plus a forecast alert.
- Account settings: S3 Block Public Access for the whole account, and an IAM password policy.

**`certpoc-foundation-network`**
- VPC `10.40.0.0/16` in 2 AZs: public subnets (for the step-8 demo app only) and isolated private subnets.
- **No NAT gateway** (each costs about $32/month). Gateway endpoints for S3 and DynamoDB are included; they're free.
  Interface endpoints are opt-in in the config (about $7.30/month each, per AZ).
- VPC flow logs, encrypted, in `/certpoc/vpc-flow-logs`. The default security group is locked down, and the
  `certpoc-app` security group allows outbound HTTPS only.

**`certpoc-foundation-iam`**
| Policy / role | Purpose |
|---|---|
| `certpoc-foundation-workload-boundary` | Permissions boundary. The most any role created by the app stacks can ever do: only the POC's services, only in the chosen region. |
| `certpoc-foundation-protect` | Explicit denies. Nobody but the admin can stop the trail, delete the audit logs or bucket, disable the foundation keys, turn off Config or flow logs, change foundation roles and policies, remove a boundary, or create IAM users and access keys. Also built into the boundary and the execution policy. |
| `certpoc-foundation-deny-secret-material` | For every role that calls Bedrock: no secret values, no certificate export or issuing, no decrypt with the secrets key, no IAM or permission changes. This enforces the roadmap rule "never give the model direct access to private keys or secret values". |
| `certpoc-foundation-app-cfn-exec` | What CloudFormation may do when teammates deploy app stacks. It can only create roles named `certpoc-*` **that carry the boundary**, so an app stack can't escalate privileges. |
| `certpoc-admin` | You (the foundation owner). AdministratorAccess, MFA, 1-hour sessions. |
| `certpoc-developer` | Itay, Dan and Amit. Read everything; write only by deploying through the app bootstrap, or by calling their own APIs and functions for testing. MFA. |
| `certpoc-auditor` | Read-only security review: config, CloudTrail, logs. Cannot read secret values. MFA. |
| IAM Access Analyzer | Reports anything shared outside the account (free). |

Everything the app stacks need is published to SSM Parameter Store under `/certpoc/foundation/...`.

**Estimated cost:** about **$5–10/month** for the foundation alone: 3 KMS keys at $1 each, 5 alarms at $0.10 each,
plus small amounts for CloudWatch Logs ingestion and Config. The first CloudTrail management trail is free. This is an
estimate, so check Cost Explorer after the first week. The big costs come later and are not part of the foundation:
**AWS Private CA** (step 4) and interface endpoints.

## Deploy it

### 1. Create the sandbox account (once)

- **If the team has an AWS Organization:** from the management account, run
  `aws organizations create-account --email <new-unique-email> --account-name certpoc-sandbox`.
- **Otherwise:** sign up for a brand-new AWS account with its own email address. Never use an account that
  runs anything real.
- On the new account: turn on **MFA for the root user**, create **no** root access keys, and then stop using root.
- Create one temporary admin identity to run the first deploy. Use either an IAM Identity Center user (recommended)
  or an IAM user with MFA. After step 5 you switch to the `certpoc-admin` role and remove this identity's access keys.

### 2. Install the tools

```powershell
winget install Amazon.AWSCLI      # AWS CLI v2; Node.js is already installed
cd AI_CERT_POC\foundation
npm ci
```

### 3. Fill in the config

```powershell
copy config\sandbox.example.json config\sandbox.json
```

Edit `config/sandbox.json`. It is git-ignored because it holds your account id and email.

- `sandboxAccountId`: the 12-digit id of the new account.
- `alertEmail`: who gets the budget and security alerts.
- `region`: `us-east-1` has every service in the plan (Bedrock, Private CA, Verified Permissions). Change it only if
  you've checked all of them.
- `forbiddenAccountIds`: add any other accounts you have, so the foundation can never be deployed there.
- `requireMfa`: set this to `false` if you sign in with **IAM Identity Center**. IAM can't see Identity Center's
  MFA when you assume a role, so the MFA condition would lock you out. Identity Center already enforces MFA at sign-in.

### 4. Check it locally (no AWS needed)

```powershell
npm test         # 33 tests: encryption, trail, no NAT, boundary, MFA, AI denies, cdk-nag
npm run synth    # builds the CloudFormation templates; fails on any unacknowledged cdk-nag finding
```

### 5. Deploy the foundation

```powershell
aws configure sso                                  # or: aws configure --profile certpoc-bootstrap
aws sts get-caller-identity --profile <profile>    # MUST show the sandbox account id
npx cdk bootstrap aws://<ACCOUNT>/<REGION> --profile <profile>
npx cdk deploy --all --profile <profile>
```

- **Confirm the SNS subscription email** ("AWS Notification - Subscription Confirmation"), or alarms won't reach you.
- The `certpoc-foundation-iam` stack prints an `AppBootstrapCommand` output. Run it once, as admin. It creates a second,
  restricted bootstrap (qualifier `certapp`) that the app stacks deploy through:

```powershell
npx cdk bootstrap aws://<ACCOUNT>/<REGION> --qualifier certapp --toolkit-stack-name CDKToolkit-certapp `
  --cloudformation-execution-policies arn:aws:iam::<ACCOUNT>:policy/certpoc-foundation-app-cfn-exec --profile <profile>
```

### 6. Switch everyone to the roles

Add a profile per role to `%USERPROFILE%\.aws\config`:

```ini
[profile certpoc-dev]
source_profile = <your base profile>
role_arn = arn:aws:iam::<ACCOUNT>:role/certpoc-developer
mfa_serial = arn:aws:iam::<ACCOUNT>:mfa/<your-mfa-device>   ; only when requireMfa is true
region = us-east-1
```

You use `certpoc-admin` only to change the foundation. Teammates use `certpoc-developer`. Delete the access
keys of the temporary bootstrap identity.

### 7. Prove it works (for the step-10 security tests)

- CloudTrail console: `certpoc-audit-trail` shows **Logging: on**. Config shows the 9 rules being evaluated.
- As `certpoc-developer`, run `aws cloudtrail stop-logging --name certpoc-audit-trail`. It should fail with **AccessDenied**,
  and the attempt shows up in the trail.
- As `certpoc-developer`, run `aws kms schedule-key-deletion --key-id alias/certpoc/data`. It should also fail with **AccessDenied**.
- As `certpoc-auditor`, run `aws secretsmanager get-secret-value ...` on any secret. It should fail with **AccessDenied**.

## For the team: building your step on the foundation

App stacks (Itay's cert service, Dan's access control, the password feature, the AI layer) go in their own CDK app
or in this repo. The rules:

```ts
import { appStackProps, applyAppGuardrails, foundationValue, denySecretMaterialPolicy } from '../foundation/lib/app-guardrails';
import { loadConfig } from '../foundation/lib/config';

const cfg = loadConfig('../foundation/config/sandbox.json');
const stack = new CertServiceStack(app, 'certpoc-cert-service', appStackProps(cfg)); // name MUST start with "certpoc-"
applyAppGuardrails(stack, cfg);  // workload boundary on every role, deploy through the "certapp" bootstrap
```

- **Read foundation values** with `foundationValue(stack, cfg, '<key>')`. The keys are `vpc-id`, `private-subnet-ids`,
  `public-subnet-ids`, `app-security-group-id`, `kms/data-key-arn`, `kms/secrets-key-arn`, `kms/logs-key-arn`,
  `cloudtrail/log-group-name`, `cloudtrail/bucket-name`, `alerts/topic-arn`, `iam/workload-boundary-arn`, and
  `iam/deny-secret-material-arn`.
- **Encryption:** DynamoDB tables and S3 buckets use the **data** key (`kms.Key.fromKeyArn(...)`); Secrets Manager uses the **secrets** key.
- **Lambda: keep it out of the VPC** unless it must reach something inside it. The VPC has no NAT, so a Lambda in the
  isolated subnets can only reach S3 and DynamoDB, plus any interface endpoints you add to `vpc.interfaceEndpoints`
  (these cost money).
- **AI layer (step 7):** attach `denySecretMaterialPolicy(stack, cfg)` to every role that calls Bedrock.
- **Itay, AWS Private CA is the expensive part.** A general-purpose CA costs about $400/month; short-lived certificate
  mode is cheaper, and the first CA in an account has a free trial. Check current pricing, and **delete the CA when you're
  not demoing**. The budget alert will tell you if one is left running.
- **Dan:** `certpoc-admin`, `certpoc-developer` and `certpoc-auditor` control **AWS access for people building the POC**.
  The app's own roles (admin, team owner, auditor) belong in Cedar policies in Verified Permissions: a different layer.
- Denied API calls are expected during access-control testing. The "denied calls" alarm only fires at 5 or more in 5 minutes.

## Tear down

```powershell
npx cdk destroy --all --profile <admin-profile>
```

By design, the CloudTrail bucket, its access-log bucket and the logs key are **kept**. Audit evidence outlives the
stacks, and the key stays so those logs remain readable. Delete them by hand when the POC is over. Schedule the key
for deletion after the buckets are gone. Also delete the `CDKToolkit-certapp` and `CDKToolkit` stacks.

## Notes and limits

- **Nothing here has been deployed to a real account yet.** It is type-checked, unit-tested and synthesized offline.
  The first real deploy may surface account-specific issues. For example, an account created by Control Tower already
  has a Config recorder: set `enableAwsConfig: false` in that case.
- AWS Budgets **alerts; it does not stop spending**.
- cdk-nag v2 is pinned on purpose. v3 requires one acknowledgement per wildcard finding, and the boundary and execution
  policies are wildcard by design. Every acknowledgement in the code has a written reason.
