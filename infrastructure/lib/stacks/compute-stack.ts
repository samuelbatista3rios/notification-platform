import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  environment: string;
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  mskCluster: msk.CfnServerlessCluster;
  archiveBucket: s3.Bucket;
  notificationTopic: sns.Topic;
  emailQueue: sqs.Queue;
  smsQueue: sqs.Queue;
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const lambdasDir = path.join(__dirname, '..', '..', '..', '..', 'lambdas');

    // ─── Configuração base para todas as NodejsFunction ──────────────────────
    // NodejsFunction usa esbuild internamente (bundling feito no deploy).
    // Você não precisa rodar `tsc` nas lambdas — CDK cuida disso.
    const commonLambdaProps: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,    // Graviton2 = ~20% mais barato e rápido
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        // Exclui o SDK do bundle — Runtime Node 20 já inclui @aws-sdk v3
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        LOG_LEVEL: props.environment === 'prod' ? 'INFO' : 'DEBUG',
        ENVIRONMENT: props.environment,
      },
    };

    // ────────────────────────────────────────────────────────────────────────
    // STEP FUNCTIONS — Tasks (Lambdas invocadas pelo orquestrador)
    // ────────────────────────────────────────────────────────────────────────

    // Task 1: Valida o evento (campos obrigatórios, formato, etc.)
    const validateFn = new lambdaNode.NodejsFunction(this, 'ValidateFn', {
      ...commonLambdaProps,
      functionName: `notification-validate-${props.environment}`,
      entry: path.join(lambdasDir, 'step-functions', 'src', 'validate.ts'),
      handler: 'handler',
    });

    // Task 2: Publica no SNS (fanout para email/sms/push filas)
    const routeFn = new lambdaNode.NodejsFunction(this, 'RouteFn', {
      ...commonLambdaProps,
      functionName: `notification-route-${props.environment}`,
      entry: path.join(lambdasDir, 'step-functions', 'src', 'route.ts'),
      handler: 'handler',
      environment: {
        ...commonLambdaProps.environment,
        SNS_TOPIC_ARN: props.notificationTopic.topicArn,
      },
    });
    props.notificationTopic.grantPublish(routeFn);

    // Task 3: Arquiva o evento no S3
    const archiveFn = new lambdaNode.NodejsFunction(this, 'ArchiveFn', {
      ...commonLambdaProps,
      functionName: `notification-archive-${props.environment}`,
      entry: path.join(lambdasDir, 'step-functions', 'src', 'archive.ts'),
      handler: 'handler',
      environment: {
        ...commonLambdaProps.environment,
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
      },
    });
    props.archiveBucket.grantWrite(archiveFn);

    // ────────────────────────────────────────────────────────────────────────
    // STEP FUNCTIONS — State Machine (Express Workflow)
    // ────────────────────────────────────────────────────────────────────────
    // Express Workflow = síncrono, ideal para orquestração de curta duração.
    // Standard Workflow = para workflows longos (dias/semanas).

    const validateState = new tasks.LambdaInvoke(this, 'ValidateEvent', {
      lambdaFunction: validateFn,
      // OutputPath: extrai apenas o campo "Payload" do response da Lambda
      // (Lambda retorna { StatusCode, Payload, ... })
      outputPath: '$.Payload',
      comment: 'Valida estrutura e campos obrigatórios do evento',
    });

    const routeState = new tasks.LambdaInvoke(this, 'RouteToChannels', {
      lambdaFunction: routeFn,
      outputPath: '$.Payload',
      comment: 'Publica no SNS para fanout aos canais (email/sms/push)',
    });

    const archiveState = new tasks.LambdaInvoke(this, 'ArchiveEvent', {
      lambdaFunction: archiveFn,
      outputPath: '$.Payload',
      comment: 'Persiste evento processado no S3 para auditoria',
    });

    // Estado de falha na validação
    const validationFailed = new sfn.Fail(this, 'ValidationFailed', {
      error: 'ValidationError',
      causePath: sfn.JsonPath.stringAt('$.errors'),
    });

    // Choice: se validação passou, continua; se não, falha
    const validationChoice = new sfn.Choice(this, 'IsValid?')
      .when(
        sfn.Condition.booleanEquals('$.valid', true),
        // Parallel: Route e Archive rodam em paralelo (independentes)
        new sfn.Parallel(this, 'RouteAndArchive', {
          comment: 'Route e Archive são independentes — rodam em paralelo',
        })
          .branch(routeState)
          .branch(archiveState)
      )
      .otherwise(validationFailed);

    // Definição da state machine
    const definition = validateState.next(validationChoice);

    const stateMachineLogGroup = new logs.LogGroup(this, 'SfnLogGroup', {
      logGroupName: `/aws/states/notification-orchestrator-${props.environment}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const stateMachine = new sfn.StateMachine(this, 'NotificationOrchestrator', {
      stateMachineName: `notification-orchestrator-${props.environment}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.EXPRESS,   // Síncrono, ótimo para este caso
      timeout: cdk.Duration.minutes(2),
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL,                        // Em prod use ERROR para reduzir custo
        includeExecutionData: true,
      },
    });

    // ────────────────────────────────────────────────────────────────────────
    // KAFKA CONSUMER LAMBDA (MSK Event Source Mapping)
    // ────────────────────────────────────────────────────────────────────────
    const kafkaConsumerFn = new lambdaNode.NodejsFunction(this, 'KafkaConsumerFn', {
      ...commonLambdaProps,
      functionName: `notification-kafka-consumer-${props.environment}`,
      entry: path.join(lambdasDir, 'kafka-consumer', 'src', 'handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),   // Mais tempo para processar batches
      environment: {
        ...commonLambdaProps.environment,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
        KAFKA_TOPIC: 'notification.events',
      },
    });

    stateMachine.grantStartSyncExecution(kafkaConsumerFn);

    // MSK Event Source: Lambda é invocada automaticamente quando há mensagens no topic
    // batchSize = quantas mensagens processa por invocação (1-10000)
    // startingPosition = de onde começa a ler (LATEST = só novas mensagens)
    kafkaConsumerFn.addEventSource(
      new lambdaEventSources.ManagedKafkaEventSource({
        clusterArn: props.mskCluster.attrArn,
        topic: 'notification.events',
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,                              // Processa até 10 mensagens por vez
        bisectBatchOnError: true,                  // Se o batch falhar, divide ao meio (isolamento)
      })
    );

    // Permissão para o Lambda acessar o MSK via IAM
    kafkaConsumerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kafka-cluster:Connect',
          'kafka-cluster:DescribeGroup',
          'kafka-cluster:AlterGroup',
          'kafka-cluster:DescribeTopic',
          'kafka-cluster:ReadData',
          'kafka-cluster:DescribeClusterDynamicConfiguration',
        ],
        resources: [
          props.mskCluster.attrArn,
          `${props.mskCluster.attrArn}/*`,
        ],
      })
    );

    // ────────────────────────────────────────────────────────────────────────
    // EMAIL WORKER LAMBDA (SQS Consumer)
    // ────────────────────────────────────────────────────────────────────────
    const emailWorkerFn = new lambdaNode.NodejsFunction(this, 'EmailWorkerFn', {
      ...commonLambdaProps,
      functionName: `notification-email-worker-${props.environment}`,
      entry: path.join(lambdasDir, 'email-worker', 'src', 'handler.ts'),
      handler: 'handler',
      environment: {
        ...commonLambdaProps.environment,
        SES_FROM_EMAIL: process.env.SES_FROM_EMAIL ?? 'no-reply@example.com',
      },
    });

    // Permissão para enviar emails via SES
    emailWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    emailWorkerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(props.emailQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(10),  // Aguarda até 10s para acumular batch
        reportBatchItemFailures: true,                // Só re-processa mensagens que falharam
      })
    );

    // ────────────────────────────────────────────────────────────────────────
    // SMS WORKER LAMBDA (SQS Consumer)
    // ────────────────────────────────────────────────────────────────────────
    const smsWorkerFn = new lambdaNode.NodejsFunction(this, 'SmsWorkerFn', {
      ...commonLambdaProps,
      functionName: `notification-sms-worker-${props.environment}`,
      entry: path.join(lambdasDir, 'sms-worker', 'src', 'handler.ts'),
      handler: 'handler',
    });

    // Permissão para enviar SMS via SNS
    smsWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: ['*'],
      })
    );

    smsWorkerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(props.smsQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(10),
        reportBatchItemFailures: true,
      })
    );

    // ────────────────────────────────────────────────────────────────────────
    // EVENT INGESTER LAMBDA + API GATEWAY
    // ────────────────────────────────────────────────────────────────────────
    const eventIngesterFn = new lambdaNode.NodejsFunction(this, 'EventIngesterFn', {
      ...commonLambdaProps,
      functionName: `notification-event-ingester-${props.environment}`,
      entry: path.join(lambdasDir, 'event-ingester', 'src', 'handler.ts'),
      handler: 'handler',
      environment: {
        ...commonLambdaProps.environment,
        MSK_CLUSTER_ARN: props.mskCluster.attrArn,
        KAFKA_TOPIC: 'notification.events',
      },
    });

    // Permissão para publicar no MSK via IAM
    eventIngesterFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kafka-cluster:Connect',
          'kafka-cluster:DescribeTopic',
          'kafka-cluster:WriteData',
          'kafka-cluster:DescribeClusterDynamicConfiguration',
        ],
        resources: [
          props.mskCluster.attrArn,
          `${props.mskCluster.attrArn}/*`,
        ],
      })
    );

    // API Gateway REST API
    const api = new apigw.RestApi(this, 'NotificationApi', {
      restApiName: `notification-api-${props.environment}`,
      description: 'Notification Platform — Event Ingestion API',
      deployOptions: {
        stageName: props.environment,
        // Access log para ver cada request
        accessLogDestination: new apigw.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLog', {
            logGroupName: `/aws/apigateway/notification-api-${props.environment}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
          })
        ),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        // Throttling: protege contra burst de requests
        throttlingRateLimit: 100,     // requests/segundo
        throttlingBurstLimit: 200,
      },
    });

    const notificationsResource = api.root.addResource('notifications');
    notificationsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(eventIngesterFn, {
        proxy: true,           // Passa o request completo para a Lambda
      })
    );

    // Health check endpoint
    const healthResource = api.root.addResource('health');
    healthResource.addMethod(
      'GET',
      new apigw.MockIntegration({
        integrationResponses: [{ statusCode: '200' }],
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] }
    );

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}notifications`,
      description: 'POST aqui para enviar uma notificação',
    });
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, 'KafkaConsumerFnName', {
      value: kafkaConsumerFn.functionName,
    });
  }
}
