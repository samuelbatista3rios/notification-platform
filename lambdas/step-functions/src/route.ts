
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { createLogger } from '../../shared/src/utils/logger';
import type {
  ValidationResult,
  RoutingResult,
  NotificationChannel,
  ChannelMessage,
} from '../../shared/src/types/events';

const logger = createLogger('sfn-route');
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN!;

export const handler = async (input: ValidationResult): Promise<RoutingResult> => {
  const { event } = input;

  logger.withCorrelationId(event.correlationId).info('Routing event to channels', {
    userId: event.userId,
    channels: event.channels,
  });

  const snsMessageIds: Record<NotificationChannel, string> = {} as Record<NotificationChannel, string>;
  const channelsRouted: NotificationChannel[] = [];

  await Promise.all(
    event.channels.map(async (channel) => {
      const message: ChannelMessage = {
        correlationId: event.correlationId,
        userId: event.userId,
        channel,
        priority: event.priority,
        eventType: event.eventType,
        subject: event.payload.subject,
        body: event.payload.body,
        templateId: event.payload.templateId,
        templateData: event.payload.templateData,
        timestamp: event.timestamp,
      };

      const command = new PublishCommand({
        TopicArn: SNS_TOPIC_ARN,
        Message: JSON.stringify(message),

        MessageAttributes: {
          channel: {
            DataType: 'String',
            StringValue: channel,
          },
          priority: {
            DataType: 'String',
            StringValue: event.priority,
          },
          eventType: {
            DataType: 'String',
            StringValue: event.eventType,
          },
        },

        Subject: `[${channel.toUpperCase()}] ${event.eventType}`,
      });

      const result = await snsClient.send(command);

      logger.info(`Published to SNS for channel '${channel}'`, {
        messageId: result.MessageId,
      });

      snsMessageIds[channel] = result.MessageId!;
      channelsRouted.push(channel);
    })
  );

  return { channelsRouted, snsMessageIds, event };
};
