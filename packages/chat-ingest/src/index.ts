/**
 * Shared chat ingestion pipeline.
 *
 * Chat reaches the panel from two independent producers — the log tailer
 * (`@squad/worker-log-ingest`) and the RCON broadcast listener
 * (`@squad/worker-rcon`) — and both must store and fan out a message the same
 * way. Everything downstream of "a chat line was observed" lives here so the
 * two cannot drift apart.
 */
export { ChatFlagDetector } from './flag-rules.js';
export {
  buildChatFrame,
  type ChatChannel,
  type ChatInput,
  type ChatMessageData,
  type ChatMessageFrame,
  type ChatPublisher,
  type ChatRecord,
  handleChat,
  LIVE_BUS_CHANNEL,
  recordChatMessage,
  resolvePlayerId,
} from './store.js';
