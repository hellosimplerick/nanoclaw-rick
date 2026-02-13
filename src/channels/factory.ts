import { logger } from '../logger.js';
import { OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { DevChannel } from './dev.js';

export type SelectedChannel = 'whatsapp' | 'dev';

export interface ChannelFactoryOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface AppChannel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  prefixAssistantName?: boolean;
  syncGroupMetadata?(force: boolean): Promise<void>;
}

export function resolveChannel(envValue: string | undefined = process.env.CHANNEL): SelectedChannel {
  const normalized = envValue?.trim().toLowerCase();
  if (!normalized || normalized === 'whatsapp') return 'whatsapp';
  if (normalized === 'dev') return 'dev';
  logger.warn({ channel: envValue }, 'Unknown CHANNEL value, defaulting to whatsapp');
  return 'whatsapp';
}

export async function createChannel(opts: ChannelFactoryOpts): Promise<AppChannel> {
  const selected = resolveChannel();
  if (selected === 'dev') {
    return new DevChannel({
      onMessage: opts.onMessage,
      onChatMetadata: opts.onChatMetadata,
    });
  }

  const { WhatsAppChannel } = await import('./whatsapp.js');
  return new WhatsAppChannel(opts);
}
