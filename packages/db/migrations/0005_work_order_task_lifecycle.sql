ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'));

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED'));

CREATE TABLE order_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_requirements (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, requirement_id)
);

CREATE INDEX idx_order_state_history_order
  ON order_state_history(order_id, created_at);
CREATE INDEX idx_task_state_history_task
  ON task_state_history(task_id, created_at);
CREATE INDEX idx_task_requirements_requirement
  ON task_requirements(requirement_id);

CREATE OR REPLACE FUNCTION validate_order_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('READY', 'CANCELLED')) OR
    (OLD.status = 'READY' AND NEW.status IN ('IN_PROGRESS', 'BLOCKED', 'CANCELLED')) OR
    (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('BLOCKED', 'COMPLETED', 'CANCELLED')) OR
    (OLD.status = 'BLOCKED' AND NEW.status IN ('READY', 'IN_PROGRESS', 'CANCELLED')) OR
    (OLD.status = 'CANCELLED' AND NEW.status = 'PLANNED')
  ) THEN
    RAISE EXCEPTION 'illegal order status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_task_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('READY', 'CANCELLED')) OR
    (OLD.status = 'READY' AND NEW.status IN ('IN_PROGRESS', 'BLOCKED', 'CANCELLED')) OR
    (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('BLOCKED', 'VERIFYING', 'FAILED', 'CANCELLED')) OR
    (OLD.status = 'BLOCKED' AND NEW.status IN ('READY', 'IN_PROGRESS', 'CANCELLED')) OR
    (OLD.status = 'VERIFYING' AND NEW.status IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'CANCELLED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('READY', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'illegal task status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_order_state_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_state_history (order_id, from_status, to_status)
    VALUES (NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_state_history (order_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_task_state_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_state_history (task_id, from_status, to_status)
    VALUES (NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO task_state_history (task_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_order_status_transition
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION validate_order_status_transition();

CREATE TRIGGER trg_validate_task_status_transition
BEFORE UPDATE OF status ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_task_status_transition();

CREATE TRIGGER trg_record_order_state_history
AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION record_order_state_history();

CREATE TRIGGER trg_record_task_state_history
AFTER INSERT OR UPDATE OF status ON tasks
FOR EACH ROW EXECUTE FUNCTION record_task_state_history();
