
import { createLogger } from '../../shared/src/utils/logger';
import type { OrchestratorInput, ValidationResult } from '../../shared/src/types/events';

const logger = createLogger('sfn-validate');

const SUPPORTED_CHANNELS = new Set(['email', 'sms', 'push']);
const SUPPORTED_PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);

export const handler = async (input: OrchestratorInput): Promise<ValidationResult> => {
  const { event } = input;

  logger.withCorrelationId(event.correlationId).info('Validating event', {
    userId: event.userId,
    channels: event.channels,
    eventType: event.eventType,
  });

  const errors: string[] = [];


  if (!event.userId?.trim()) {
    errors.push('userId is required and cannot be empty');
  }

  if (!event.channels || event.channels.length === 0) {
    errors.push('At least one channel is required');
  } else {
    const unsupported = event.channels.filter((c) => !SUPPORTED_CHANNELS.has(c));
    if (unsupported.length > 0) {
      errors.push(`Unsupported channels: ${unsupported.join(', ')}`);
    }
  }

  if (!SUPPORTED_PRIORITIES.has(event.priority)) {
    errors.push(`Invalid priority '${event.priority}'. Must be one of: ${[...SUPPORTED_PRIORITIES].join(', ')}`);
  }

  if (!event.payload?.body?.trim()) {
    errors.push('payload.body is required and cannot be empty');
  }

  if (!event.eventType?.trim()) {
    errors.push('eventType is required');
  }

  const valid = errors.length === 0;

  logger.info(`Validation ${valid ? 'passed' : 'failed'}`, { errors });

  return { valid, errors, event };
};
