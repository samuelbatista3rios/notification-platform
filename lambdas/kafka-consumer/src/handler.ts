/**
 * kafka-consumer
 * ──────────────
 * Triggered automaticamente pelo MSK Event Source Mapping quando há
 * mensagens no topic 'notification.events'.
 *
 * Para cada mensagem no batch:
 *   1. Desserializa o NotificationEvent
 *   2. Inicia uma execução síncrona do Step Functions (Express Workflow)
 *   3. Retorna sucesso/falha por mensagem (Partial Batch Response)
 *
 * Fluxo: MSK Kafka → esta Lambda → Step Functions (síncrono)
 *
 * CONCEITO IMPORTANTE — MSK Event Source:
 * O Lambda service (não sua Lambda!) é quem faz o poll no Kafka.
 * Você configura o topic e o batch size no CDK — a AWS cuida do resto.
 * O `event` que chega tem o formato MSKEvent com records agrupados por partition.
 */

import { MSKEvent, MSKRecord, Context } from 'aws-lambda';
import {
  SFNClient,
  StartSyncExecutionCommand,
  ExecutionStatus,
} from '@aws-sdk/client-sfn';
import { createLogger } from '../../shared/src/utils/logger';
import type { NotificationEvent, OrchestratorInput } from '../../shared/src/types/events';

const logger = createLogger('kafka-consumer');

// SDK client singleton (reutilizado entre warm starts)
const sfnClient = new SFNClient({ region: process.env.AWS_REGION });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

// ─── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (
  event: MSKEvent,
  context: Context
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  logger.info('MSK batch received', {
    eventSourceArn: event.eventSourceArn,
    totalRecords: Object.values(event.records).reduce((acc, recs) => acc + recs.length, 0),
    remainingTimeMs: context.getRemainingTimeInMillis(),
  });

  // Partial Batch Response: ao invés de falhar o batch inteiro,
  // retornamos quais mensagens individualmente falharam.
  // O MSK Event Source vai re-tentar APENAS as mensagens com falha.
  const batchItemFailures: { itemIdentifier: string }[] = [];

  // event.records = { "topic-partition": [MSKRecord, ...] }
  // Iteramos por todas as partitions e todos os records
  for (const [topicPartition, records] of Object.entries(event.records)) {
    for (const record of records) {
      await processRecord(record, topicPartition, batchItemFailures);
    }
  }

  logger.info('Batch processing complete', {
    failures: batchItemFailures.length,
    failedIds: batchItemFailures.map((f) => f.itemIdentifier),
  });

  return { batchItemFailures };
};

// ─── Processa um único record do Kafka ───────────────────────────────────────
async function processRecord(
  record: MSKRecord,
  topicPartition: string,
  failures: { itemIdentifier: string }[]
): Promise<void> {
  // O offset é o identificador único para o Partial Batch Response
  const itemIdentifier = `${topicPartition}:${record.offset}`;

  try {
    // MSK Event Source entrega o value em Base64
    const rawValue = Buffer.from(record.value, 'base64').toString('utf-8');
    const notificationEvent = JSON.parse(rawValue) as NotificationEvent;

    logger.withCorrelationId(notificationEvent.correlationId).info(
      'Processing Kafka record',
      {
        partition: record.partition,
        offset: record.offset,
        userId: notificationEvent.userId,
        eventType: notificationEvent.eventType,
      }
    );

    const input: OrchestratorInput = { event: notificationEvent };

    // StartSyncExecution = invoca o Express Workflow e AGUARDA a conclusão.
    // Ideal aqui porque queremos saber se falhou antes de "commitar" o offset.
    // Timeout: 2min (definido na state machine) — nosso Lambda tem 60s de timeout,
    // então o SFN vai concluir antes do Lambda expirar.
    const command = new StartSyncExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `${notificationEvent.correlationId}-${record.offset}`,
      input: JSON.stringify(input),
    });

    const result = await sfnClient.send(command);

    if (result.status === ExecutionStatus.FAILED) {
      logger.error('Step Functions execution failed', undefined, {
        cause: result.cause,
        error: result.error,
        correlationId: notificationEvent.correlationId,
      });
      // Marca como falha — MSK vai re-tentar esta mensagem
      failures.push({ itemIdentifier });
    } else {
      logger.info('Step Functions execution succeeded', {
        executionArn: result.executionArn,
        correlationId: notificationEvent.correlationId,
      });
    }
  } catch (err) {
    logger.error('Failed to process Kafka record', err, {
      topicPartition,
      offset: record.offset,
    });
    failures.push({ itemIdentifier });
  }
}
