import * as fs from "node:fs";
import * as path from "node:path";

/** Settings for the sandbox foundation. Lives in config/sandbox.json (see config/sandbox.example.json). */
export interface FoundationConfig {
    /** Short lowercase name used in every resource name, e.g. "certpoc". */
    readonly prefix: string;
    /** The dedicated sandbox account. Every stack is pinned to it, so a deploy with other credentials fails. */
    readonly sandboxAccountId: string;
    readonly region: string;
    /** Receives budget, security-alarm and AWS Config notifications. */
    readonly alertEmail: string;
    readonly monthlyBudgetUsd: number;
    /** Require MFA to assume the admin / developer / auditor roles. */
    readonly requireMfa: boolean;
    readonly enableAwsConfig: boolean;
    /** CDK bootstrap qualifier for the app stacks (cert service, access control, AI layer). Max 10 chars, a-z0-9. */
    readonly appBootstrapQualifier: string;
    readonly logRetentionDays: number;
    readonly vpc: {
        readonly cidr: string;
        readonly maxAzs: number;
        /** Interface endpoint service names, e.g. ["kms", "secretsmanager"]. Each costs about $7.30/month per AZ. */
        readonly interfaceEndpoints: string[];
    };
    /** Accounts the foundation must never be deployed to (production, the management account, ...). */
    readonly forbiddenAccountIds: string[];
}

const PLACEHOLDER_ACCOUNT = "000000000000";

// Values CloudWatch Logs accepts for retentionInDays.
const LOG_RETENTION_DAYS = [
    1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
    2192, 2557, 2922, 3288, 3653,
];

export function validateConfig(raw: unknown): FoundationConfig {
    const c = raw as FoundationConfig;
    const errors: string[] = [];
    const check = (ok: boolean, msg: string) => {
        if (!ok) errors.push(msg);
    };

    check(
        typeof c?.prefix === "string" &&
            /^[a-z][a-z0-9-]{1,14}$/.test(c.prefix),
        'prefix must be 2-15 chars of a-z, 0-9 and "-", starting with a letter',
    );
    check(
        typeof c?.sandboxAccountId === "string" &&
            /^\d{12}$/.test(c.sandboxAccountId),
        "sandboxAccountId must be a 12-digit AWS account id",
    );
    check(
        c?.sandboxAccountId !== PLACEHOLDER_ACCOUNT,
        "sandboxAccountId is still the placeholder: put the id of the dedicated sandbox account in config/sandbox.json",
    );
    check(
        !(c?.forbiddenAccountIds ?? []).includes(c?.sandboxAccountId),
        `account ${c?.sandboxAccountId} is listed in forbiddenAccountIds: the foundation only deploys to a dedicated sandbox account`,
    );
    check(
        typeof c?.region === "string" &&
            /^[a-z]{2}(-[a-z]+)+-\d$/.test(c.region),
        'region must look like "us-east-1"',
    );
    check(
        typeof c?.alertEmail === "string" &&
            /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.alertEmail),
        "alertEmail must be an email address",
    );
    check(
        typeof c?.monthlyBudgetUsd === "number" && c.monthlyBudgetUsd > 0,
        "monthlyBudgetUsd must be a positive number",
    );
    check(
        typeof c?.requireMfa === "boolean",
        "requireMfa must be true or false",
    );
    check(
        typeof c?.enableAwsConfig === "boolean",
        "enableAwsConfig must be true or false",
    );
    check(
        typeof c?.appBootstrapQualifier === "string" &&
            /^[a-z0-9]{1,10}$/.test(c.appBootstrapQualifier),
        "appBootstrapQualifier must be 1-10 chars of a-z and 0-9",
    );
    check(
        c?.appBootstrapQualifier !== "hnb659fds",
        "appBootstrapQualifier must differ from the default CDK qualifier (hnb659fds) used by the foundation itself",
    );
    check(
        LOG_RETENTION_DAYS.includes(c?.logRetentionDays),
        `logRetentionDays must be one of ${LOG_RETENTION_DAYS.join(", ")}`,
    );
    check(
        typeof c?.vpc?.cidr === "string" &&
            /^\d{1,3}(\.\d{1,3}){3}\/(1[6-9]|2[0-4])$/.test(c.vpc.cidr),
        "vpc.cidr must be an IPv4 CIDR between /16 and /24",
    );
    check(
        Number.isInteger(c?.vpc?.maxAzs) &&
            c.vpc.maxAzs >= 1 &&
            c.vpc.maxAzs <= 3,
        "vpc.maxAzs must be 1, 2 or 3",
    );
    check(
        Array.isArray(c?.vpc?.interfaceEndpoints) &&
            c.vpc.interfaceEndpoints.every((e) =>
                /^[a-z0-9][a-z0-9.-]*$/.test(e),
            ),
        'vpc.interfaceEndpoints must be a list of service names such as "kms"',
    );
    check(
        Array.isArray(c?.forbiddenAccountIds),
        "forbiddenAccountIds must be a list (it may be empty)",
    );

    if (errors.length) {
        throw new Error(
            `Invalid foundation config:\n - ${errors.join("\n - ")}`,
        );
    }
    return c;
}

export function loadConfig(file: string): FoundationConfig {
    const full = path.resolve(file);
    if (!fs.existsSync(full)) {
        throw new Error(
            `Config file ${full} not found. Copy config/sandbox.example.json to config/sandbox.json and fill it in.`,
        );
    }
    // Strip a UTF-8 byte-order mark: Notepad and PowerShell 5 add one, and JSON.parse rejects it.
    return validateConfig(
        JSON.parse(fs.readFileSync(full, "utf8").replace(/^﻿/, "")),
    );
}

/** SSM parameter path the foundation publishes its outputs under, e.g. /certpoc/foundation/vpc-id. */
export function foundationParameterName(prefix: string, key: string): string {
    return `/${prefix}/foundation/${key}`;
}
