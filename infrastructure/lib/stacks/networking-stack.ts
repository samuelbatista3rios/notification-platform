import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface NetworkingStackProps extends cdk.StackProps {
  environment: string;
}

export class NetworkingStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly kafkaSecurityGroup: ec2.SecurityGroup;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    // ─── VPC com subnets privadas (MSK deve ficar em subnets privadas) ────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `notification-platform-${props.environment}`,
      maxAzs: 2,                   // 2 AZs para alta disponibilidade
      natGateways: 1,              // 1 NAT Gateway (custo reduzido em dev/sandbox)
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ─── Security Group: MSK ──────────────────────────────────────────────────
    // Só aceita conexões das Lambdas na porta 9098 (IAM auth via TLS)
    this.kafkaSecurityGroup = new ec2.SecurityGroup(this, 'KafkaSg', {
      vpc: this.vpc,
      securityGroupName: `notification-kafka-${props.environment}`,
      description: 'MSK Serverless — aceita tráfego das Lambdas',
      allowAllOutbound: false,
    });

    // ─── Security Group: Lambdas ──────────────────────────────────────────────
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: `notification-lambda-${props.environment}`,
      description: 'Lambdas da Notification Platform',
      allowAllOutbound: true,      // Lambdas precisam chamar AWS APIs (STS, SNS, S3...)
    });

    // ─── Regra: Lambdas -> MSK (porta 9098 = IAM/TLS) ────────────────────────
    this.kafkaSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(9098),
      'Lambdas podem conectar no MSK via IAM auth'
    );

    // ─── VPC Endpoints para que Lambdas em subnet privada acessem AWS APIs ────
    // Sem isso, tráfego para S3/SNS/SFN vai pelo NAT Gateway (custo + latência)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    new ec2.InterfaceVpcEndpoint(this, 'SnsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SNS,
      securityGroups: [this.lambdaSecurityGroup],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'SfnEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      securityGroups: [this.lambdaSecurityGroup],
      privateDnsEnabled: true,
    });

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'KafkaSgId', { value: this.kafkaSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, 'LambdaSgId', { value: this.lambdaSecurityGroup.securityGroupId });
  }
}
