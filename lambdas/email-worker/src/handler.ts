
import { SQSEvent, SQSRecord, SQSBatchResponse } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { createLogger } from '../../shared/src/utils/logger';
import type { ChannelMessage } from '../../shared/src/types/events';

const logger = createLogger('email-worker');
const sesClient = new SESClient({ region: process.env.AWS_REGION });

const FROM_EMAIL = process.env.SES_FROM_EMAIL ?? 'no-reply@example.com';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  logger.info('Processing SQS email batch', { count: event.Records.length });

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  // Processamos em paralelo (Promise.allSettled não lança exceção se um falha)
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

  logger.info('Email batch complete', { failures: batchItemFailures.length });

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  // Com rawMessageDelivery=true no SNS subscription,
  // o body da mensagem SQS é diretamente o JSON publicado no SNS
  const message = JSON.parse(record.body) as ChannelMessage;

  logger.withCorrelationId(message.correlationId).info('Sending email', {
    userId: message.userId,
    eventType: message.eventType,
    priority: message.priority,
  });

  // ─── Lookup de email do usuário ───────────────────────────────────────────
  // Em produção: buscar no DynamoDB/RDS o email do userId.
  // Aqui usamos um mock para fins didáticos.
  const recipientEmail = await resolveUserEmail(message.userId);

  // ─── Renderização do template ─────────────────────────────────────────────
  const { subject, htmlBody, textBody } = renderTemplate(message);

  // ─── Envio via SES ────────────────────────────────────────────────────────
  const command = new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [recipientEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
        Text: { Data: textBody, Charset: 'UTF-8' },
      },
    },
    // Tags para tracking no SES
    Tags: [
      { Name: 'correlationId', Value: message.correlationId },
      { Name: 'eventType', Value: message.eventType },
      { Name: 'userId', Value: message.userId },
    ],
  });

  const result = await sesClient.send(command);

  logger.info('Email sent successfully', {
    sesMessageId: result.MessageId,
    recipient: recipientEmail,
  });
}

// ─── Mock: Em produção, consultar banco de dados ──────────────────────────────
async function resolveUserEmail(userId: string): Promise<string> {
  // TODO: Substituir por query ao DynamoDB ou User Service
  return `user-${userId}@example.com`;
}

// ─── Renderização simples de template ─────────────────────────────────────────
function renderTemplate(message: ChannelMessage): {
  subject: string;
  htmlBody: string;
  textBody: string;
} {
  const subject = message.subject ?? `[${message.eventType}] Notification`;

  // Se houver templateId, aqui você buscaria o template no S3 ou DynamoDB
  // e faria o merge com templateData. Por simplicidade, usamos o body direto.
  const textBody = message.body;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${subject}</h2>
      <p>${message.body.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <small style="color: #888">
        Event ID: ${message.correlationId}<br/>
        Sent at: ${message.timestamp}
      </small>
    </body>
    </html>
  `.trim();

  return { subject, htmlBody, textBody };
}
