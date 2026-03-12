# Notification Platform

Plataforma de notificações event-driven usando AWS Lambda, MSK (Kafka), S3, SQS, SNS e Step Functions.

## Arquitetura

```
Client
  │ POST /notifications
  ▼
API Gateway ──► Lambda (event-ingester) ──► MSK Kafka
                     [publica evento]         [topic: notification.events]
                                                      │
                                          Lambda (kafka-consumer)
                                          [MSK Event Source Mapping]
                                                      │
                                          Step Functions (Express)
                                          ┌───────────┴────────────┐
                                          │  1. validate           │
                                          │  2. Parallel:          │
                                          │     ├── route → SNS    │
                                          │     └── archive → S3   │
                                          └────────────────────────┘
                                                      │
                              SNS Filter Policy por canal
                              ┌───────────────────────┐
                              ▼                       ▼
                        SQS (email)            SQS (sms)
                              │                       │
                        Lambda (email-worker)  Lambda (sms-worker)
                              │                       │
                             SES                    SNS SMS
```

## Pré-requisitos

- Node.js 20+
- AWS CLI configurado (`aws configure`)
- AWS CDK instalado (`npm install -g aws-cdk`)
- Conta AWS com permissões para criar os recursos

## Setup inicial

```bash
# 1. Instalar dependências
npm install

# 2. Copiar e preencher variáveis de ambiente
cp .env.example .env

# 3. Bootstrap do CDK (só na primeira vez por conta/região)
cd infrastructure
npm run bootstrap
```

## Deploy

```bash
# Deploy de todos os stacks (ordem: Networking → Kafka → Storage → Compute)
npm run deploy:all

# Ou stack por stack:
cd infrastructure
cdk deploy notification-platform-networking-dev
cdk deploy notification-platform-kafka-dev       # ~10-15 min (MSK provision)
cdk deploy notification-platform-storage-dev
cdk deploy notification-platform-compute-dev
```

## Obter o bootstrap server do MSK

Após o Kafka Stack estar ativo:

```bash
# Pegar o ARN do Output do stack
MSK_ARN=$(aws cloudformation describe-stacks \
  --stack-name notification-platform-kafka-dev \
  --query "Stacks[0].Outputs[?OutputKey=='MskClusterArn'].OutputValue" \
  --output text)

# Obter o bootstrap server
aws kafka get-bootstrap-brokers --cluster-arn $MSK_ARN
```

Adicione o valor de `BootstrapBrokerStringSaslIam` na variável `MSK_BOOTSTRAP_SERVERS` do ambiente da Lambda `notification-event-ingester`.

## Testar

```bash
# Pegar a URL da API do Output do stack Compute
API_URL=$(aws cloudformation describe-stacks \
  --stack-name notification-platform-compute-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

# Enviar uma notificação de teste
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test-001",
    "userId": "user-123",
    "channels": ["email", "sms"],
    "priority": "high",
    "eventType": "order.placed",
    "payload": {
      "subject": "Seu pedido foi confirmado!",
      "body": "Olá! Seu pedido #12345 foi confirmado e está sendo processado."
    }
  }'
```

## Monitoramento

```bash
# Logs do kafka-consumer (ver eventos sendo processados)
aws logs tail /aws/lambda/notification-kafka-consumer-dev --follow

# Logs do Step Functions
aws logs tail /aws/states/notification-orchestrator-dev --follow

# Mensagens na DLQ (email que falharam)
aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name notification-email-dlq-dev --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages

# Eventos arquivados no S3
aws s3 ls s3://notification-archive-dev-<ACCOUNT_ID>/events/ --recursive
```

## Estrutura do projeto

```
notification-platform/
├── infrastructure/          # AWS CDK (IaC)
│   ├── bin/main.ts          # Entry point — define os stacks
│   └── lib/stacks/
│       ├── networking-stack.ts  # VPC, Security Groups, VPC Endpoints
│       ├── kafka-stack.ts       # MSK Serverless cluster
│       ├── storage-stack.ts     # S3, SNS (fanout), SQS + DLQs
│       └── compute-stack.ts     # Lambdas, API GW, Step Functions
├── lambdas/
│   ├── event-ingester/      # API GW → Kafka producer
│   ├── kafka-consumer/      # MSK event source → Step Functions
│   ├── step-functions/      # Tasks: validate, route, archive
│   ├── email-worker/        # SQS consumer → SES
│   └── sms-worker/          # SQS consumer → SNS SMS
└── shared/                  # Types e utils compartilhados
    ├── types/events.ts
    └── utils/logger.ts
```

## Conceitos-chave abordados

| Serviço | Conceito |
|---|---|
| **Lambda** | Singleton de conexão (warm start), Partial Batch Response, ARM64 |
| **MSK/Kafka** | IAM auth, Event Source Mapping, partition key por userId, offset commit |
| **S3** | Hive partitioning, lifecycle rules, SSE, metadata |
| **SQS** | DLQ, Visibility Timeout, Partial Batch Response, maxBatchingWindow |
| **SNS** | Fanout, Filter Policy por Message Attribute, rawMessageDelivery |
| **Step Functions** | Express Workflow, Parallel state, Choice state, StartSyncExecution |
| **CDK** | NodejsFunction (esbuild), VPC Endpoints, MSK Event Source |
