// ─── Canal de entrega ───────────────────────────────────────────────────────
export type NotificationChannel = 'email' | 'sms' | 'push';

// ─── Prioridade ──────────────────────────────────────────────────────────────
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

// ─── Evento bruto recebido pelo cliente via API ──────────────────────────────
export interface NotificationRequest {
  /** ID único gerado pelo cliente */
  requestId: string;

  /** ID do usuário destino */
  userId: string;

  /** Canais desejados */
  channels: NotificationChannel[];

  priority: NotificationPriority;

  /** Tipo semântico do evento (ex: 'order.placed', 'auth.otp') */
  eventType: string;

  payload: {
    subject?: string;
    body: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
  };

  metadata?: Record<string, unknown>;
}

// ─── Evento enriquecido que trafega no Kafka ─────────────────────────────────
export interface NotificationEvent extends NotificationRequest {
  /** Adicionado pelo event-ingester */
  timestamp: string;
  correlationId: string;
  source: 'api';
}

// ─── Input para o Step Functions ─────────────────────────────────────────────
export interface OrchestratorInput {
  event: NotificationEvent;
}

// ─── Output de cada estado do Step Functions ─────────────────────────────────
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  event: NotificationEvent;
}

export interface RoutingResult {
  channelsRouted: NotificationChannel[];
  snsMessageIds: Record<NotificationChannel, string>;
  event: NotificationEvent;
}

export interface ArchiveResult {
  s3Key: string;
  event: NotificationEvent;
}

// ─── Mensagem publicada no SNS (payload por canal) ───────────────────────────
export interface ChannelMessage {
  correlationId: string;
  userId: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  eventType: string;
  subject?: string;
  body: string;
  templateId?: string;
  templateData?: Record<string, unknown>;
  timestamp: string;
}

// ─── Resultado dos workers ───────────────────────────────────────────────────
export interface DeliveryResult {
  correlationId: string;
  channel: NotificationChannel;
  userId: string;
  status: 'delivered' | 'failed';
  providerMessageId?: string;
  error?: string;
  deliveredAt: string;
}
