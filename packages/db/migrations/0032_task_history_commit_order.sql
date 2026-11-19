-- PLT-040: order task_state_history by wall-clock time of the write, not by the
-- start of the transaction. Every writer of this table (trigger
-- record_task_state_history, fired from jev_create_task and jev_transition_task)
-- holds the project lock (FOR NO KEY UPDATE) until commit, so rows written with
-- clock_timestamp() are ordered exactly like their commits. With NOW() a
-- transaction that began earlier but took the lock later could stamp an older
-- created_at than an already committed row.
-- Reversible: ALTER TABLE task_state_history ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE task_state_history ALTER COLUMN created_at SET DEFAULT clock_timestamp();
