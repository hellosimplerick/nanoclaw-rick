import readline from 'readline';

import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';

const DEV_CHAT_JID = 'dev@local';
const DEV_SENDER = 'dev-user@local';

export interface DevChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class DevChannel implements Channel {
  name = 'dev';
  prefixAssistantName = true;

  private connected = false;
  private rl: readline.Interface | null = null;
  private opts: DevChannelOpts;

  constructor(opts: DevChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    logger.info('Dev channel active');

    this.rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) return;

      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(DEV_CHAT_JID, timestamp, 'Dev Channel');
      this.opts.onMessage(DEV_CHAT_JID, {
        id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: DEV_CHAT_JID,
        sender: DEV_SENDER,
        sender_name: 'Dev User',
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ jid: DEV_CHAT_JID, content }, 'DEV inbound');
    });

    this.rl.on('close', () => {
      this.connected = false;
      logger.info('Dev channel stdin closed');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    logger.info({ jid, text }, 'DEV outbound');
    process.stdout.write(`[DEV OUTBOUND ${jid}] ${text}\n`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(_jid: string): boolean {
    return true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
  }
}
