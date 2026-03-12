
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


  const eventDate = new Date(event.timestamp);
  const year = eventDate.getUTCFullYear();
  const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(eventDate.getUTCDate()).padStart(2, '0');
  const hour = String(eventDate.getUTCHours()).padStart(2, '0');

  const s3Key = `events/year=${year}/month=${month}/day=${day}/hour=${hour}/${event.correlationId}.json`;

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

      Metadata: {
        correlationId: event.correlationId,
        userId: event.userId,
        eventType: event.eventType,
        channels: event.channels.join(','),
      },

      ServerSideEncryption: 'AES256',
    })
  );

  logger.info('Event archived successfully', { s3Key });

  return { s3Key, event };
};
