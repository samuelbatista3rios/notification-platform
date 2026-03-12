import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';

interface KafkaStackProps extends cdk.StackProps {
  environment: string;
  vpc: ec2.IVpc;
  kafkaSecurityGroup: ec2.SecurityGroup;
}

export class KafkaStack extends cdk.Stack {
  public readonly cluster: msk.CfnServerlessCluster;
  public readonly clusterArn: string;

  constructor(scope: Construct, id: string, props: KafkaStackProps) {
    super(scope, id, props);

    // ─── MSK Serverless ───────────────────────────────────────────────────────
    // Serverless = sem necessidade de provisionar brokers.
    // Você paga por MB trafegado e por hora de retenção.
    // Ideal para dev/sandbox e workloads com tráfego variável.
    //
    // Autenticação: IAM (sem senha/certificado, usa a role da Lambda)
    this.cluster = new msk.CfnServerlessCluster(this, 'MskCluster', {
      clusterName: `notification-platform-${props.environment}`,

      // IAM = autenticação via role (sem SASL/SCRAM ou mTLS)
      clientAuthentication: {
        sasl: {
          iam: { enabled: true },
        },
      },

      vpcConfigs: [
        {
          subnetIds: props.vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          }).subnetIds,
          securityGroups: [props.kafkaSecurityGroup.securityGroupId],
        },
      ],
    });

    this.clusterArn = this.cluster.attrArn;

    // ─── Outputs ──────────────────────────────────────────────────────────────
    // O bootstrap server do MSK Serverless segue o padrão abaixo.
    // Só fica disponível após o cluster estar ACTIVE (~10-15 min no first deploy).
    new cdk.CfnOutput(this, 'MskClusterArn', {
      value: this.clusterArn,
      exportName: `notification-msk-arn-${props.environment}`,
    });

    // Nota: O endpoint bootstrap é gerado automaticamente pelo MSK e não é um
    // CfnOutput direto. Você o obtém via console ou AWS CLI:
    //   aws kafka describe-cluster --cluster-arn <ARN> (para MSK Provisioned)
    //   aws kafka get-bootstrap-brokers --cluster-arn <ARN> (para Serverless)
    new cdk.CfnOutput(this, 'GetBootstrapCmd', {
      value: `aws kafka get-bootstrap-brokers --cluster-arn ${this.clusterArn}`,
      description: 'Execute para obter o bootstrap server após o cluster estar ACTIVE',
    });
  }
}
