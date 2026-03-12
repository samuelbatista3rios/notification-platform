

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { AwsMskIamSaslSigner } from 'aws-msk-iam-sasl-signer-js';
import { v4 as uuidv4 } from 'uuid';
import type { NotificationRequest, NotificationEvent } from '../../shared/src/types/events';
import { createLogger } from '../../shared/src/utils/logger';

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = createLogger('event-ingester');


let producer: Producer | null = null;

async function getProducer(): Promise<Producer> {
  if (producer) return producer;

  const bootstrapServers = process.env.MSK_BOOTSTRAP_SERVERS;
  if (!bootstrapServers) throw new Error('MSK_BOOTSTRAP_SERVERS not set');

  // ─── IAM Auth para MSK Serverless ────────────────────────────────────────
  // MSK Serverless só aceita IAM auth (SASL/OAUTHBEARER com token da role Lambda).
  // O pacote aws-msk-iam-sasl-signer-js gera o token automaticamente usando as
  // credenciais da execution role da Lambda.
  const kafka = new Kafka({
    clientId: 'notification-event-ingester',
    brokers: bootstrapServers.split(','),
    ssl: true,                              // MSK Serverless exige TLS
    sasl: {
      mechanism: 'oauthbearer',
      oauthBearerProvider: async () => {
        const signer = new AwsMskIamSaslSigner({
          region: process.env.AWS_REGION ?? 'us-east-1',
        });
        const { token, tokenExpiry } = await signer.generateAuthToken();
        return {
          value: token,
          lifetime: tokenExpiry,
        };
      },
    },
  });

  producer = kafka.producer({
    // Idempotência garante que mesmo se a Lambda retentar, não haverá duplicatas
    idempotent: true,
    // acks: -1 = todos os brokers confirmam (mais seguro, ligeiramente mais lento)
    transactionTimeout: 30000,
  });

  await producer.connect();
  logger.info('Kafka producer connected');
  return producer;
}

// ─── Validação de schema ──────────────────────────────────────────────────────
function validateRequest(body: unknown): body is NotificationRequest {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;

  return (
    typeof b.requestId === 'string' &&
    typeof b.userId === 'string' &&
    Array.isArray(b.channels) &&
    b.channels.length > 0 &&
    typeof b.priority === 'string' &&
    typeof b.eventType === 'string' &&
    typeof b.payload === 'object' &&
    b.payload !== null &&
    typeof (b.payload as Record<string, unknown>).body === 'string'
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const correlationId = uuidv4();
  logger.withCorrelationId(correlationId);

  try {
    // 1. Parse do body
    if (!event.body) {
      return response(400, { error: 'Body is required' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.body);
    } catch {
      return response(400, { error: 'Invalid JSON' });
    }

    // 2. Validação
    if (!validateRequest(parsed)) {
      return response(400, {
        error: 'Invalid request',
        required: ['requestId', 'userId', 'channels', 'priority', 'eventType', 'payload.body'],
      });
    }

    // 3. Enriquecimento do evento (adiciona campos de infra)
    const notificationEvent: NotificationEvent = {
      ...parsed,
      timestamp: new Date().toISOString(),
      correlationId,
      source: 'api',
    };

    logger.info('Publishing event to Kafka', {
      requestId: notificationEvent.requestId,
      userId: notificationEvent.userId,
      channels: notificationEvent.channels,
      eventType: notificationEvent.eventType,
    });

    // 4. Publica no Kafka
    const p = await getProducer();
    const result = await p.send({
      topic: process.env.KAFKA_TOPIC ?? 'notification.events',
      compression: CompressionTypes.GZIP,
      messages: [
        {
          // Key = userId: garante que eventos do mesmo usuário vão para a mesma partition
          // Isso preserva a ordem dos eventos por usuário
          key: notificationEvent.userId,
          value: JSON.stringify(notificationEvent),
          headers: {
            correlationId,
            eventType: notificationEvent.eventType,
            source: 'api',
          },
        },
      ],
    });

    logger.info('Event published successfully', {
      partition: result[0]?.partition,
      offset: result[0]?.baseOffset,
    });

    return response(202, {
      correlationId,
      requestId: notificationEvent.requestId,
      status: 'accepted',
      message: 'Notification event queued for processing',
    });
  } catch (err) {
    logger.error('Failed to publish event', err);
    return response(500, { error: 'Internal server error', correlationId });
  }
};

function response(statusCode: number, body: object): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': 'correlationId' in body ? String(body.correlationId) : '',
    },
    body: JSON.stringify(body),
  };
}
