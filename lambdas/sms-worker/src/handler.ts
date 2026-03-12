/**
 * sms-worker
 * ───────────
 * Consumer da SQS sms-queue. Envia SMS via AWS SNS (não confundir com o
 * SNS de fanout — SNS também tem API para envio direto de SMS).
 *
 * Nota: SNS tem dois usos distintos neste projeto:
 *   1. Fanout (pub/sub): NotificationTopic → SQS queues (feito no route.ts)
 *   2. SMS direto: SNS.publish({ PhoneNumber }) (feito aqui)
 *
 * Fluxo: SQS (sms-queue) → esta Lambda → SNS SMS → telefone do usuário
 */

import { SQSEvent, SQSRecord, SQSBatchResponse } from 'aws-lambda';
import { SNSClient, PublishCommand, MessageAttributeValue } from '@aws-sdk/client-sns';
import { createLogger } from '../../shared/src/utils/logger';
import type { ChannelMessage } from '../../shared/src/types/events';

const logger = createLogger('sms-worker');
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  logger.info('Processing SQS SMS batch', { count: event.Records.length });

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error('Failed to process SQS record', result.reason, {
        messageId: event.Records[index].messageId,
      });
      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
    }
  });

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const message = JSON.parse(record.body) as ChannelMessage;

  logger.withCorrelationId(message.correlationId).info('Sending SMS', {
    userId: message.userId,
    priority: message.priority,
  });

  const phoneNumber = await resolveUserPhone(message.userId);

  // ─── Trunca mensagem para o limite de SMS (160 chars por segmento) ────────
  const smsBody = truncateSms(message.body, 160);

  // ─── SNS SMS Publish ──────────────────────────────────────────────────────
  // SNS SMS tem dois tipos:
  //   - Promotional: mais barato, pode ser bloqueado pelo carrier
  //   - Transactional: mais caro, entrega garantida (usar para OTP, alertas)
  const smsType: MessageAttributeValue = {
    DataType: 'String',
    StringValue: message.priority === 'critical' || message.priority === 'high'
      ? 'Transactional'
      : 'Promotional',
  };

  const command = new PublishCommand({
    PhoneNumber: phoneNumber,
    Message: smsBody,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': smsType,
      'AWS.SNS.SMS.SenderID': {
        DataType: 'String',
        StringValue: 'NOTIFAPP',  // Sender ID (nem todos os países suportam)
      },
    },
  });

  const result = await snsClient.send(command);

  logger.info('SMS sent successfully', {
    snsMessageId: result.MessageId,
    phoneNumber: maskPhone(phoneNumber),
  });
}

async function resolveUserPhone(userId: string): Promise<string> {
  // TODO: Substituir por query ao User Service / DynamoDB
  return `+5511999${userId.slice(0, 6)}`;
}

function truncateSms(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// Mascara o telefone para logs (LGPD/privacidade)
function maskPhone(phone: string): string {
  return phone.slice(0, 4) + '****' + phone.slice(-4);
}
