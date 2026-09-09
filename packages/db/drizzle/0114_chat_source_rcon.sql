-- Chat arrives over RCON, not the log.
--
-- Current Squad builds never write in-game chat to SquadGame.log; the server
-- pushes each message to authenticated RCON clients as an unsolicited
-- broadcast packet. worker-rcon now parses those and writes the archive row,
-- so `chat_messages.source` needs a value that names that producer — without
-- it every RCON-sourced insert violates chat_messages_source_chk.

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_source_chk;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_source_chk CHECK (source IN ('log', 'panel', 'rcon'));
