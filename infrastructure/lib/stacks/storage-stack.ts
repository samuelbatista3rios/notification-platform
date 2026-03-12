import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

interface StorageStackProps extends cdk.StackProps {
  environment: string;
}

export class StorageStack extends cdk.Stack {
  public readonly archiveBucket: s3.Bucket;
  public readonly notificationTopic: sns.Topic;
  public readonly emailQueue: sqs.Queue;
  public readonly smsQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // ─── S3: Arquivo de eventos ───────────────────────────────────────────────
    // Todos os eventos processados são persistidos aqui para:
    // - Auditoria e compliance
    // - Replay de eventos (re-drive)
    // - Analytics (Athena, Glue, etc.)
    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `notification-archive-${props.environment}-${this.account}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,    // Só para dev — produção: RETAIN
      autoDeleteObjects: true,                      // Só para dev
      lifecycleRules: [
        {
          id: 'archive-old-events',
          // Após 30 dias: move para Infrequent Access (mais barato)
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          // Após 90 dias: deleta (ajuste para seu compliance)
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // ─── SNS: Fanout de notificações ──────────────────────────────────────────
    // Um único tópico recebe todas as notificações.
    // Filter policies nas subscriptions garantem que cada fila
    // só recebe mensagens do seu canal (email, sms, push).
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: `notification-fanout-${props.environment}`,
      displayName: 'Notification Platform — Fanout Topic',
    });

    // ─── SQS: Dead Letter Queues ──────────────────────────────────────────────
    // Mensagens que falharam N vezes vão para a DLQ.
    // De lá você pode: inspecionar, re-drive ou alertar.
    const emailDlq = new sqs.Queue(this, 'EmailDlq', {
      queueName: `notification-email-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),      // Guarda por 14 dias para análise
    });

    const smsDlq = new sqs.Queue(this, 'SmsDlq', {
      queueName: `notification-sms-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ─── SQS: Filas de processamento por canal ────────────────────────────────
    this.emailQueue = new sqs.Queue(this, 'EmailQueue', {
      queueName: `notification-email-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(30), // >= timeout da Lambda consumer
      // Após 3 falhas: vai para DLQ
      deadLetterQueue: {
        queue: emailDlq,
        maxReceiveCount: 3,
      },
    });

    this.smsQueue = new sqs.Queue(this, 'SmsQueue', {
      queueName: `notification-sms-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: smsDlq,
        maxReceiveCount: 3,
      },
    });

    // ─── SNS → SQS Subscriptions com Filter Policy ───────────────────────────
    // Filter Policy = SNS só entrega para esta fila se o atributo
    // "channel" da mensagem for "email" (ou "sms").
    // Isso evita que a fila de email receba mensagens de SMS (e vice-versa).
    this.notificationTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.emailQueue, {
        rawMessageDelivery: true,  // Sem wrapper do SNS — Lambda recebe o JSON diretamente
        filterPolicy: {
          channel: sns.SubscriptionFilter.stringFilter({
            allowlist: ['email'],
          }),
        },
      })
    );

    this.notificationTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.smsQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          channel: sns.SubscriptionFilter.stringFilter({
            allowlist: ['sms'],
          }),
        },
      })
    );

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ArchiveBucketName', { value: this.archiveBucket.bucketName });
    new cdk.CfnOutput(this, 'NotificationTopicArn', { value: this.notificationTopic.topicArn });
    new cdk.CfnOutput(this, 'EmailQueueUrl', { value: this.emailQueue.queueUrl });
    new cdk.CfnOutput(this, 'SmsQueueUrl', { value: this.smsQueue.queueUrl });
    new cdk.CfnOutput(this, 'EmailDlqUrl', { value: emailDlq.queueUrl });
    new cdk.CfnOutput(this, 'SmsDlqUrl', { value: smsDlq.queueUrl });
  }
}
