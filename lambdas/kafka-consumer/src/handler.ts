

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

  const batchItemFailures: { itemIdentifier: string }[] = [];

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
