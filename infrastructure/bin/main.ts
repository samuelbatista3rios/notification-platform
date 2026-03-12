#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { KafkaStack } from '../lib/stacks/kafka-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';

const app = new cdk.App();

const env = {
  account: process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const prefix = process.env.STACK_PREFIX ?? 'notification-platform';
const environment = process.env.ENVIRONMENT ?? 'dev';

// ─── 1. VPC e Networking (MSK precisa de VPC) ────────────────────────────────
const networkingStack = new NetworkingStack(app, `${prefix}-NetworkingStack`, {
  env,
  environment,
  stackName: `${prefix}-networking-${environment}`,
  description: 'VPC, subnets e security groups para o MSK cluster',
});

// ─── 2. MSK Serverless (Apache Kafka gerenciado) ──────────────────────────────
const kafkaStack = new KafkaStack(app, `${prefix}-KafkaStack`, {
  env,
  environment,
  vpc: networkingStack.vpc,
  kafkaSecurityGroup: networkingStack.kafkaSecurityGroup,
  stackName: `${prefix}-kafka-${environment}`,
  description: 'MSK Serverless cluster + Kafka topics',
});
kafkaStack.addDependency(networkingStack);

// ─── 3. Storage: S3, SQS, SNS ─────────────────────────────────────────────────
const storageStack = new StorageStack(app, `${prefix}-StorageStack`, {
  env,
  environment,
  stackName: `${prefix}-storage-${environment}`,
  description: 'S3 (arquivo), SNS (fanout), SQS (email/sms queues + DLQs)',
});

// ─── 4. Compute: Lambdas + Step Functions ─────────────────────────────────────
new ComputeStack(app, `${prefix}-ComputeStack`, {
  env,
  environment,
  vpc: networkingStack.vpc,
  lambdaSecurityGroup: networkingStack.lambdaSecurityGroup,
  mskCluster: kafkaStack.cluster,
  archiveBucket: storageStack.archiveBucket,
  notificationTopic: storageStack.notificationTopic,
  emailQueue: storageStack.emailQueue,
  smsQueue: storageStack.smsQueue,
  stackName: `${prefix}-compute-${environment}`,
  description: 'API Gateway, Lambdas, MSK event sources, Step Functions',
});

app.synth();
