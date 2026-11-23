import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { FoundationConfig, foundationParameterName } from "./config";

export interface NetworkStackProps extends cdk.StackProps {
    readonly cfg: FoundationConfig;
    readonly logsKey: kms.IKey;
}

/**
 * The sandbox VPC. No NAT gateway (about $32/month each): workloads run in isolated
 * subnets and reach AWS services through VPC endpoints. The S3 and DynamoDB gateway
 * endpoints are free; interface endpoints are opt-in through the config.
 */
export class NetworkStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly appSecurityGroup: ec2.SecurityGroup;
    readonly flowLogGroup: logs.LogGroup;
    private readonly azs: string[];

    constructor(scope: Construct, id: string, props: NetworkStackProps) {
        super(scope, id, props);
        const { cfg } = props;
        const p = cfg.prefix;
        // The account's first N available AZs, resolved by CloudFormation at deploy time (Fn::GetAZs),
        // so synth needs no AWS credentials and no AZ name is hardcoded.
        const available = cdk.Fn.getAzs();
        this.azs = Array.from({ length: cfg.vpc.maxAzs }, (_, i) =>
            cdk.Fn.select(i, available),
        );

        this.vpc = new ec2.Vpc(this, "Vpc", {
            vpcName: `${p}-vpc`,
            ipAddresses: ec2.IpAddresses.cidr(cfg.vpc.cidr),
            availabilityZones: this.azs,
            natGateways: 0,
            restrictDefaultSecurityGroup: true,
            subnetConfiguration: [
                // For the step-8 demo app or a load balancer only; nothing gets a public IP by default.
                {
                    name: "public",
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                    mapPublicIpOnLaunch: false,
                },
                {
                    name: "private",
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 22,
                },
            ],
            gatewayEndpoints: {
                S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
                DynamoDB: {
                    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                },
            },
        });

        this.flowLogGroup = new logs.LogGroup(this, "FlowLogGroup", {
            logGroupName: `/${p}/vpc-flow-logs`,
            encryptionKey: props.logsKey,
            retention: cfg.logRetentionDays as logs.RetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.vpc.addFlowLog("FlowLog", {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(
                this.flowLogGroup,
            ),
            trafficType: ec2.FlowLogTrafficType.ALL,
        });

        // Default group for Lambda functions / tasks that run in the VPC: HTTPS out, nothing in.
        // Isolated subnets have no route to the internet, so outbound 443 only reaches VPC endpoints.
        this.appSecurityGroup = new ec2.SecurityGroup(
            this,
            "AppSecurityGroup",
            {
                vpc: this.vpc,
                securityGroupName: `${p}-app`,
                description: `${p} workloads: outbound HTTPS only`,
                allowAllOutbound: false,
            },
        );
        this.appSecurityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            "HTTPS to AWS service endpoints",
        );

        if (cfg.vpc.interfaceEndpoints.length) {
            const endpointSg = new ec2.SecurityGroup(
                this,
                "EndpointSecurityGroup",
                {
                    vpc: this.vpc,
                    securityGroupName: `${p}-endpoints`,
                    description: `${p} interface endpoints: HTTPS from workloads`,
                    allowAllOutbound: false,
                },
            );
            endpointSg.addIngressRule(
                this.appSecurityGroup,
                ec2.Port.tcp(443),
                "HTTPS from workloads",
            );
            for (const service of cfg.vpc.interfaceEndpoints) {
                this.vpc.addInterfaceEndpoint(`Endpoint-${service}`, {
                    service: new ec2.InterfaceVpcEndpointAwsService(service),
                    subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
                    securityGroups: [endpointSg],
                    privateDnsEnabled: true,
                });
            }
        }

        const param = (paramKey: string, value: string, description: string) =>
            new ssm.StringParameter(this, `Param-${paramKey}`, {
                parameterName: foundationParameterName(p, paramKey),
                stringValue: value,
                description,
            });
        param("vpc-id", this.vpc.vpcId, "Sandbox VPC id");
        param(
            "private-subnet-ids",
            this.vpc.isolatedSubnets.map((s) => s.subnetId).join(","),
            "Isolated subnets, comma separated",
        );
        param(
            "public-subnet-ids",
            this.vpc.publicSubnets.map((s) => s.subnetId).join(","),
            "Public subnets, comma separated",
        );
        param(
            "availability-zones",
            this.vpc.availabilityZones.join(","),
            "AZs of the subnets, same order",
        );
        param(
            "app-security-group-id",
            this.appSecurityGroup.securityGroupId,
            "Security group for VPC workloads",
        );
    }

    // Stack.availabilityZones would otherwise be fetched from the account at synth time.
    get availabilityZones(): string[] {
        return this.azs ?? super.availabilityZones;
    }
}
