import fs from 'fs';
import path from 'path';
import { braveSearch, formatSearchResultsBlock } from './search/brave.js';
import { fetchRepoForks, formatForkResults } from './search/github.js';


import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { createChannel, AppChannel } from './channels/factory.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  resetStaleSendingReplies,
  setRegisteredGroup,
  setRouterState,
  setSession,
  markInboundReplyFailed,
  markInboundReplySent,
  storeChatMetadata,
  storeMessage,
  tryClaimInboundReply,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  createContainerRuntime,
  resolveContainerEngine,
} from './runtime/container-runtime.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const containerRuntime = createContainerRuntime();
const containerEngine = resolveContainerEngine();

let channel: AppChannel;
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

async function dispatchOutboundMessage(chatJid: string, text: string): Promise<void> {
  await channel.sendMessage(chatJid, text);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function ensureDevChannelGroup(): void {
  if (channel.name !== 'dev') return;
  if (registeredGroups['dev@local']) return;

  const usedFolders = new Set(Object.values(registeredGroups).map((g) => g.folder));
  let folder = MAIN_GROUP_FOLDER;
  if (usedFolders.has(folder)) {
    folder = 'dev';
    let suffix = 1;
    while (usedFolders.has(folder)) {
      folder = `dev-${suffix}`;
      suffix += 1;
    }
  }

  registerGroup('dev@local', {
    name: 'Dev Local',
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  });
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Detect /search at beginning of latest message (explicit trigger only)
  const latest = missedMessages[missedMessages.length - 1];
  const trimmed = latest.content.trim();

  let searchQuery: string | null = null;
  let messagesForPrompt = missedMessages;

  if (trimmed.startsWith('/search ')) {
    const q = trimmed.slice('/search '.length).trim();
    if (q.length > 0) {
      searchQuery = q;

      // Replace latest message content so the model doesn't see the /search command
      messagesForPrompt = missedMessages.map((m, i) =>
        i === missedMessages.length - 1 ? { ...m, content: q } : m,
      );
    }
  }

  let prompt = formatMessages(messagesForPrompt);

  if (searchQuery) {
    // Hybrid router: GitHub forks (structured) vs Brave (web)
    const m = searchQuery.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
    const wantsForks = /\bforks?\b/i.test(searchQuery);

    let block = '';

    if (m && wantsForks) {
      const owner = m[1];
      const repo = m[2];
      const forks = await fetchRepoForks(owner, repo);
      block = formatForkResults(owner, repo, forks);
    } else {
      const results = await braveSearch(searchQuery);
      block = formatSearchResultsBlock(searchQuery, results);
    }

    prompt =
      `You are in SEARCH MODE.\n` +
      `Use ONLY the provided search results to answer.\n` +
      `If the answer is not contained in the results, say: "No relevant results found."\n` +
      `Do NOT fabricate repositories, forks, or URLs.\n` +
      `Cite URLs exactly as given.\n` +
      `---\n` +
      block +
      prompt;

    logger.info(
      { group: group.name },
      `Search-injected prompt prefix: ${prompt.slice(0, 300).replace(/\n/g, '\\n')}`,
    );
  }


  const deliveryInboundMessageIds = missedMessages.map((m) => m.id);
  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  if (channel.setTyping) await channel.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        for (const inboundMessageId of deliveryInboundMessageIds) {
          const claimed = tryClaimInboundReply(inboundMessageId);
          if (!claimed) {
            logger.info(
              { group: group.name, chatJid, inboundMessageId },
              'Send skipped (already sent)',
            );
            continue;
          }
          logger.info(
            { group: group.name, chatJid, inboundMessageId },
            'Claimed inbound reply',
          );
          try {
            await dispatchOutboundMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
            markInboundReplySent(inboundMessageId);
            outputSentToUser = true;
            logger.info(
              { group: group.name, chatJid, inboundMessageId },
              'Send success',
            );
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            markInboundReplyFailed(inboundMessageId, errorMessage);
            logger.error(
              { group: group.name, chatJid, inboundMessageId, errorMessage },
              'Send failure',
            );
            throw err;
          }
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  if (channel.setTyping) await channel.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }
      await onOutput(output);
    }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Interactive follow-up injection into an active container is
          // intentionally disabled until we have per-message correlation IDs
          // for deterministic reply attribution.
          // Force active sessions to wind down so pending inbound messages are
          // picked up by a fresh standard processing run.
          queue.closeStdin(chatJid);
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  if (containerEngine === 'docker') {
    try {
      containerRuntime.systemStatus();
      logger.debug('Docker daemon is reachable');
    } catch (err) {
      logger.error({ err }, 'Docker daemon not running');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Docker daemon not running                              ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Docker daemon not running - ensure it is installed and       ║',
      );
      console.error(
        '║  started.                                                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Suggested checks:                                             ║',
      );
      console.error(
        '║  1. Verify Docker is installed: docker --version              ║',
      );
      console.error(
        '║  2. Start daemon: sudo systemctl start docker                 ║',
      );
      console.error(
        '║  3. Retry: docker info                                        ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Docker daemon not running — ensure it is installed and started.');
    }
  } else {
    try {
      containerRuntime.systemStatus();
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        containerRuntime.systemStart(30000);
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: Apple Container system failed to start                 ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Agents cannot run without Apple Container. To fix:           ║',
        );
        console.error(
          '║  1. Install from: https://github.com/apple/container/releases ║',
        );
        console.error(
          '║  2. Run: container system start                               ║',
        );
        console.error(
          '║  3. Restart NanoClaw                                          ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = containerRuntime.listContainersJson();
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        containerRuntime.stopContainerSync(name);
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  logger.info(`Container runtime selected: ${containerEngine}`);
  ensureContainerSystemRunning();
  initDatabase();
  const staleSeconds = 300;
  const recoveredStaleCount = resetStaleSendingReplies(staleSeconds);
  if (recoveredStaleCount > 0) {
    logger.info(
      { count: recoveredStaleCount, staleSeconds },
      'Recovered stale sending replies',
    );
  }
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await channel.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create selected channel (default: WhatsApp)
  channel = await createChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp, name) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  });
  ensureDevChannelGroup();

  // Connect — resolves when first connected
  await channel.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(channel, rawText);
      if (text) await dispatchOutboundMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => dispatchOutboundMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      channel.syncGroupMetadata ? channel.syncGroupMetadata(force) : Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
