-- PLT-040 (PR 1): storage of IntentBrief and AcceptanceContract.
-- Forward-only and additive: two append-only tables, one column on orders and
-- one trigger function. No GRANT is issued here (privileges live in
-- packages/db/security/provision-runtime-role.sql, like every other grant).
--
-- Design decisions (operator, 2026-11-19):
--  * Rows are immutable. A change is a new version (a new row with a new id);
--    UPDATE and DELETE are rejected by trigger even for the owner, and the
--    runtime role only receives INSERT (SELECT comes from the schema-wide
--    SELECT grant). There is therefore no updated_at column.
--  * The id of an intent_briefs row is the Platform-assigned `intent_id` that
--    an AcceptanceContract document refers to (the Foundation schema has no id).
--  * The complete Foundation document is stored as JSONB (validated against the
--    versioned JSON Schema by the service). The flat columns hold what is
--    queried and a CHECK keeps them equal to the document.
--  * organization_id is stored on both tables. orders has no organization
--    column (the organization is that of its project), so the order/organization
--    match is verified by the service; the contract/intent organization match is
--    enforced here with a composite foreign key.

CREATE TABLE intent_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- NULL for a brief captured before (or without) an order.
  order_id UUID REFERENCES orders(id),
  version INTEGER NOT NULL DEFAULT 1,
  document JSONB NOT NULL,
  ambiguity_score NUMERIC NOT NULL,
  change_radius TEXT NOT NULL,
  documentation_depth TEXT NOT NULL,
  clarification_required BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intent_briefs_version_check CHECK (version >= 1),
  CONSTRAINT intent_briefs_document_check CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT intent_briefs_ambiguity_score_check
    CHECK (ambiguity_score >= 0 AND ambiguity_score <= 1),
  CONSTRAINT intent_briefs_change_radius_check
    CHECK (change_radius IN ('LOCAL', 'COMPONENT', 'CROSS_LAYER', 'ARCHITECTURAL', 'PRODUCT')),
  CONSTRAINT intent_briefs_documentation_depth_check
    CHECK (documentation_depth IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  -- Strictly true: a missing key or a wrong JSON type gives NULL/false, and a
  -- CHECK that evaluates to NULL would otherwise pass. COALESCE makes it fail.
  CONSTRAINT intent_briefs_columns_match_document_check CHECK (COALESCE(
    jsonb_typeof(document -> 'ambiguity_score') = 'number'
    AND jsonb_typeof(document -> 'change_radius') = 'string'
    AND jsonb_typeof(document -> 'documentation_depth') = 'string'
    AND jsonb_typeof(document -> 'clarification_required') = 'boolean'
    AND document -> 'ambiguity_score' = to_jsonb(ambiguity_score)
    AND document ->> 'change_radius' = change_radius
    AND document ->> 'documentation_depth' = documentation_depth
    AND document -> 'clarification_required' = to_jsonb(clarification_required),
    false
  )),
  CONSTRAINT intent_briefs_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT intent_briefs_order_version_key UNIQUE (order_id, version)
);
CREATE INDEX idx_intent_briefs_organization_order ON intent_briefs(organization_id, order_id);

CREATE TABLE acceptance_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  intent_id UUID NOT NULL,
  -- Copied from the intent brief by the service; NULL when the brief has none.
  order_id UUID REFERENCES orders(id),
  version INTEGER NOT NULL DEFAULT 1,
  document JSONB NOT NULL,
  specification_depth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acceptance_contracts_intent_fkey
    FOREIGN KEY (intent_id, organization_id) REFERENCES intent_briefs(id, organization_id),
  CONSTRAINT acceptance_contracts_version_check CHECK (version >= 1),
  CONSTRAINT acceptance_contracts_document_check CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT acceptance_contracts_specification_depth_check
    CHECK (specification_depth IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  -- Strictly true (see intent_briefs_columns_match_document_check). The document's
  -- intent_id must be the canonical lowercase text of the column (the service
  -- normalizes it before saving).
  CONSTRAINT acceptance_contracts_columns_match_document_check CHECK (COALESCE(
    jsonb_typeof(document -> 'intent_id') = 'string'
    AND jsonb_typeof(document -> 'specification_depth') = 'string'
    AND document ->> 'intent_id' = intent_id::text
    AND document ->> 'specification_depth' = specification_depth,
    false
  )),
  CONSTRAINT acceptance_contracts_intent_version_key UNIQUE (intent_id, version)
);
CREATE INDEX idx_acceptance_contracts_organization_order
  ON acceptance_contracts(organization_id, order_id);

CREATE FUNCTION jev_immutable_intent_record()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $jev$
BEGIN
  RAISE EXCEPTION 'intent briefs and acceptance contracts are append-only; save a new version'
    USING ERRCODE='23514';
END;
$jev$;
CREATE TRIGGER trg_immutable_intent_briefs
BEFORE UPDATE OR DELETE ON intent_briefs
FOR EACH ROW EXECUTE FUNCTION jev_immutable_intent_record();
CREATE TRIGGER trg_immutable_acceptance_contracts
BEFORE UPDATE OR DELETE ON acceptance_contracts
FOR EACH ROW EXECUTE FUNCTION jev_immutable_intent_record();

-- LEGACY marker: every order that exists when this migration runs has no
-- IntentBrief and keeps working. Adding the column with DEFAULT TRUE marks
-- those rows without rewriting them (and without firing the order triggers);
-- the default is then switched so orders created from now on are NOT legacy.
-- This PR only records the marker; requiring a brief for non-legacy orders is
-- done later (PLT-040 PR 3). The runtime role can neither UPDATE this column
-- nor set it on INSERT: both provisioning scripts grant it INSERT on orders by
-- column, excluding intent_legacy, so a new order can never be born legacy.
ALTER TABLE orders ADD COLUMN intent_legacy BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE orders ALTER COLUMN intent_legacy SET DEFAULT FALSE;
