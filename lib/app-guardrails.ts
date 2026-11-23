import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { FoundationConfig, foundationParameterName } from "./config";
import { policyNames } from "./iam-baseline-stack";

/**
 * Helpers for the app stacks built on top of the foundation (cert service, access control,
 * AI layer, ...). Usage:
 *
 *   const stack = new CertServiceStack(app, 'certpoc-cert-service', appStackProps(cfg));
 *   applyAppGuardrails(stack, cfg);
 *   const vpcId = foundationValue(stack, cfg, 'vpc-id');
 */

/** Pins the stack to the sandbox account and deploys it through the restricted app bootstrap. */
export function appStackProps(
    cfg: FoundationConfig,
    extra: cdk.StackProps = {},
): cdk.StackProps {
    return {
        ...extra,
        env: { account: cfg.sandboxAccountId, region: cfg.region },
        synthesizer: new cdk.DefaultStackSynthesizer({
            qualifier: cfg.appBootstrapQualifier,
        }),
    };
}

/**
 * Puts the workload permissions boundary on every role in the stack (Lambda, Step Functions,
 * custom resources). The app bootstrap refuses to create a role without it, and only allows
 * role names that start with the project prefix, which CloudFormation derives from the stack name.
 */
export function applyAppGuardrails(
    stack: cdk.Stack,
    cfg: FoundationConfig,
): void {
    const p = cfg.prefix;
    if (
        !stack.stackName.startsWith(`${p}-`) ||
        stack.stackName.startsWith(`${p}-foundation-`)
    ) {
        throw new Error(
            `App stack "${stack.stackName}" must be named "${p}-<something>" and must not start with "${p}-foundation-".`,
        );
    }
    iam.PermissionsBoundary.of(stack).apply(
        iam.ManagedPolicy.fromManagedPolicyName(
            stack,
            "FoundationWorkloadBoundary",
            policyNames(p).workloadBoundary,
        ),
    );
    cdk.Tags.of(stack).add("Project", p);
    cdk.Tags.of(stack).add("Environment", "sandbox");
}

/** Reads a value the foundation published, e.g. "vpc-id", "kms/data-key-arn", "iam/workload-boundary-arn". */
export function foundationValue(
    scope: Construct,
    cfg: FoundationConfig,
    key: string,
): string {
    return ssm.StringParameter.valueForStringParameter(
        scope,
        foundationParameterName(cfg.prefix, key),
    );
}

/** Attach to every role that calls Bedrock: no secret values, private keys or permission changes. */
export function denySecretMaterialPolicy(
    scope: Construct,
    cfg: FoundationConfig,
): iam.IManagedPolicy {
    return iam.ManagedPolicy.fromManagedPolicyName(
        scope,
        "FoundationDenySecretMaterial",
        policyNames(cfg.prefix).denySecretMaterial,
    );
}
