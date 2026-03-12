/**
 * Step Functions Task: archive
 * ─────────────────────────────
 * Persiste o evento no S3 para auditoria, replay e analytics.
 *
 * Estratégia de particionamento: year/month/day/hour/correlationId.json
 * Isso facilita queries com Athena (partition pruning) e
 * evita arquivos grandes com muitos eventos.
 *
 * Input:  ValidationResult { valid, errors, event }
 * Output: ArchiveResult    { s3Key, event }
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../../shared/src/utils/logger';
import type { ValidationResult, ArchiveResult } from '../../shared/src/types/events';

const logger = createLogger('sfn-archive');
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET!;

export const handler = async (input: ValidationResult): Promise<ArchiveResult> => {
  const { event } = input;

  logger.withCorrelationId(event.correlationId).info('Archiving event to S3', {
    userId: event.userId,
    eventType: event.eventType,
  });

  // ─── Particionamento por data/hora ────────────────────────────────────────
  // Seguimos a convenção Hive partitioning: year=YYYY/month=MM/day=DD/hour=HH
  // Isso permite que o Athena faça partition pruning (consultas muito mais rápidas).
  const eventDate = new Date(event.timestamp);
  const year = eventDate.getUTCFullYear();
  const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(eventDate.getUTCDate()).padStart(2, '0');
  const hour = String(eventDate.getUTCHours()).padStart(2, '0');

  const s3Key = `events/year=${year}/month=${month}/day=${day}/hour=${hour}/${event.correlationId}.json`;

  // Payload que salvamos no S3 — inclui tudo para replay completo
  const archivePayload = {
    _schemaVersion: '1.0',
    _archivedAt: new Date().toISOString(),
    ...event,
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: ARCHIVE_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(archivePayload, null, 2),
      ContentType: 'application/json',
      // Metadata visível sem fazer download do objeto
      Metadata: {
        correlationId: event.correlationId,
        userId: event.userId,
        eventType: event.eventType,
        channels: event.channels.join(','),
      },
      // Server-side encryption (SSE-S3 já é default no bucket, mas explicitamos)
      ServerSideEncryption: 'AES256',
    })
  );

  logger.info('Event archived successfully', { s3Key });

  return { s3Key, event };
};
