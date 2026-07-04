-- Wave 5 batch 2: DISCORD-1, CBAN-1, CLAN-1, MARK-1, PNOTE-1, REPORT-1.
-- Hand-authored additive migration (drizzle generate unreliable vs drifted snapshot).
-- mark_types rows are seeded idempotently in code (ensureMarkTypes at route registration).

ALTER TABLE roles ADD COLUMN can_manage_ban_sources boolean DEFAULT false NOT NULL;
ALTER TABLE roles ADD COLUMN can_manage_integrations boolean DEFAULT false NOT NULL;
UPDATE roles SET can_manage_ban_sources = true, can_manage_integrations = true WHERE name = 'Owner';

-- ===== tables =====
CREATE TABLE public.clan_members (
    clan_id uuid NOT NULL,
    player_id uuid NOT NULL,
    member_role text NOT NULL,
    has_priority boolean DEFAULT false NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clan_members_role_enum CHECK ((member_role = ANY (ARRAY['leader'::text, 'deputy'::text, 'member'::text])))
);
CREATE TABLE public.clans (
    id uuid NOT NULL,
    name text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    max_priority_slots integer DEFAULT 10 NOT NULL,
    priority_expires_at timestamp with time zone,
    is_tag_protected boolean DEFAULT false NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    primary_server_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT clans_max_priority_slots_nonneg CHECK ((max_priority_slots >= 0)),
    CONSTRAINT clans_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 32)))
);
CREATE TABLE public.discord_integration (
    id uuid NOT NULL,
    guild_id text,
    bot_token_encrypted bytea,
    enabled boolean DEFAULT false NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.discord_webhooks (
    id uuid NOT NULL,
    event_type text NOT NULL,
    webhook_url_encrypted bytea NOT NULL,
    channel_label text,
    enabled boolean DEFAULT true NOT NULL,
    mention_everyone boolean DEFAULT false NOT NULL,
    server_id uuid,
    key_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.external_ban_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    format text NOT NULL,
    auth_header_encrypted bytea,
    trust_level text DEFAULT 'normal'::text NOT NULL,
    discord_url text,
    enabled boolean DEFAULT true NOT NULL,
    poll_interval_minutes integer DEFAULT 60 NOT NULL,
    last_sync_at timestamp with time zone,
    last_sync_status text,
    last_sync_error text,
    imported_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT external_ban_sources_format_chk CHECK ((format = ANY (ARRAY['squad_bans_cfg'::text, 'battlemetrics_json'::text, 'json_generic'::text, 'csv'::text]))),
    CONSTRAINT external_ban_sources_last_sync_status_chk CHECK (((last_sync_status IS NULL) OR (last_sync_status = ANY (ARRAY['ok'::text, 'error'::text])))),
    CONSTRAINT external_ban_sources_poll_interval_chk CHECK ((poll_interval_minutes >= 15)),
    CONSTRAINT external_ban_sources_trust_level_chk CHECK ((trust_level = ANY (ARRAY['trusted'::text, 'normal'::text, 'low'::text])))
);
CREATE TABLE public.external_bans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    steam_id64 text,
    eos_id text,
    nickname text,
    reason text,
    admin_name text,
    issued_at timestamp with time zone,
    expires_at timestamp with time zone,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT external_bans_identity_chk CHECK (((steam_id64 IS NOT NULL) OR (eos_id IS NOT NULL)))
);
CREATE TABLE public.mark_types (
    id smallint NOT NULL,
    slug text NOT NULL,
    label_en text NOT NULL,
    label_ru text NOT NULL,
    icon text NOT NULL,
    severity smallint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order smallint NOT NULL
);
CREATE TABLE public.player_marks (
    id uuid NOT NULL,
    player_id uuid NOT NULL,
    mark_type_id smallint NOT NULL,
    comment text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_by uuid,
    cleared_at timestamp with time zone,
    clear_reason text,
    CONSTRAINT player_marks_comment_len CHECK ((char_length(comment) <= 512))
);
CREATE TABLE public.player_notes (
    id uuid NOT NULL,
    player_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by uuid
);
CREATE TABLE public.player_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    reporter_player_id uuid,
    target_player_id uuid,
    target_raw text,
    body text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    handler_player_id uuid,
    resolution_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT player_reports_source_enum CHECK ((source = ANY (ARRAY['ingame'::text, 'ui'::text]))),
    CONSTRAINT player_reports_status_enum CHECK ((status = ANY (ARRAY['pending'::text, 'in_review'::text, 'resolved'::text, 'rejected'::text])))
);
ALTER TABLE ONLY public.clan_members
    ADD CONSTRAINT clan_members_clan_id_player_id_pk PRIMARY KEY (clan_id, player_id);
ALTER TABLE ONLY public.clans
    ADD CONSTRAINT clans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.discord_integration
    ADD CONSTRAINT discord_integration_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.discord_webhooks
    ADD CONSTRAINT discord_webhooks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.external_ban_sources
    ADD CONSTRAINT external_ban_sources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.external_bans
    ADD CONSTRAINT external_bans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.mark_types
    ADD CONSTRAINT mark_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_marks
    ADD CONSTRAINT player_marks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_notes
    ADD CONSTRAINT player_notes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_reports
    ADD CONSTRAINT player_reports_pkey PRIMARY KEY (id);
CREATE INDEX clan_members_clan_role_idx ON public.clan_members USING btree (clan_id, member_role);
CREATE UNIQUE INDEX clan_members_player_unique_idx ON public.clan_members USING btree (player_id);
CREATE INDEX clans_is_public_idx ON public.clans USING btree (is_public) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX clans_name_active_key ON public.clans USING btree (name) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX external_bans_dedup_key ON public.external_bans USING btree (source_id, COALESCE(steam_id64, ''::text), COALESCE(eos_id, ''::text), COALESCE(issued_at, '1970-01-01 00:00:00+00'::timestamp with time zone));
CREATE INDEX external_bans_eos_id_idx ON public.external_bans USING btree (eos_id) WHERE (eos_id IS NOT NULL);
CREATE INDEX external_bans_source_id_idx ON public.external_bans USING btree (source_id);
CREATE INDEX external_bans_steam_id64_idx ON public.external_bans USING btree (steam_id64) WHERE (steam_id64 IS NOT NULL);
CREATE UNIQUE INDEX mark_types_slug_key ON public.mark_types USING btree (slug);
CREATE UNIQUE INDEX player_marks_active_type_unique_idx ON public.player_marks USING btree (player_id, mark_type_id) WHERE (cleared_at IS NULL);
CREATE INDEX player_marks_player_id_idx ON public.player_marks USING btree (player_id);
CREATE INDEX player_notes_player_id_created_at_idx ON public.player_notes USING btree (player_id, created_at);
CREATE INDEX player_reports_server_idx ON public.player_reports USING btree (server_id);
CREATE INDEX player_reports_status_created_idx ON public.player_reports USING btree (status, created_at);
CREATE INDEX player_reports_target_player_idx ON public.player_reports USING btree (target_player_id);
ALTER TABLE ONLY public.clan_members
    ADD CONSTRAINT clan_members_clan_id_clans_id_fk FOREIGN KEY (clan_id) REFERENCES public.clans(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.clan_members
    ADD CONSTRAINT clan_members_player_id_players_id_fk FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.clans
    ADD CONSTRAINT clans_primary_server_id_servers_id_fk FOREIGN KEY (primary_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.discord_webhooks
    ADD CONSTRAINT discord_webhooks_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.external_bans
    ADD CONSTRAINT external_bans_source_id_external_ban_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.external_ban_sources(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_marks
    ADD CONSTRAINT player_marks_cleared_by_players_id_fk FOREIGN KEY (cleared_by) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.player_marks
    ADD CONSTRAINT player_marks_created_by_players_id_fk FOREIGN KEY (created_by) REFERENCES public.players(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.player_marks
    ADD CONSTRAINT player_marks_mark_type_id_mark_types_id_fk FOREIGN KEY (mark_type_id) REFERENCES public.mark_types(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.player_marks
    ADD CONSTRAINT player_marks_player_id_players_id_fk FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_notes
    ADD CONSTRAINT player_notes_author_id_players_id_fk FOREIGN KEY (author_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_notes
    ADD CONSTRAINT player_notes_deleted_by_players_id_fk FOREIGN KEY (deleted_by) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.player_notes
    ADD CONSTRAINT player_notes_player_id_players_id_fk FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_reports
    ADD CONSTRAINT player_reports_handler_player_id_players_id_fk FOREIGN KEY (handler_player_id) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.player_reports
    ADD CONSTRAINT player_reports_reporter_player_id_players_id_fk FOREIGN KEY (reporter_player_id) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.player_reports
    ADD CONSTRAINT player_reports_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_reports
    ADD CONSTRAINT player_reports_target_player_id_players_id_fk FOREIGN KEY (target_player_id) REFERENCES public.players(id) ON DELETE SET NULL;

-- ===== clan constraint functions + triggers =====
CREATE FUNCTION public.clan_members_enforce_priority_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_clan uuid;
  used integer;
  slots integer;
BEGIN
  target_clan := COALESCE(NEW.clan_id, OLD.clan_id);
  SELECT max_priority_slots INTO slots FROM clans WHERE id = target_clan;
  IF slots IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO used FROM clan_members
  WHERE clan_id = target_clan AND has_priority;
  IF used > slots THEN
    RAISE EXCEPTION
      'clan % priority slots exhausted: % assigned exceeds limit of %',
      target_clan, used, slots
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.clan_members_enforce_single_leader() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_clan uuid;
  member_total integer;
  leader_total integer;
BEGIN
  target_clan := COALESCE(NEW.clan_id, OLD.clan_id);
  SELECT count(*), count(*) FILTER (WHERE member_role = 'leader')
    INTO member_total, leader_total
    FROM clan_members WHERE clan_id = target_clan;
  IF member_total = 0 THEN
    RETURN NULL;
  END IF;
  IF leader_total <> 1 THEN
    RAISE EXCEPTION
      'clan % must have exactly one leader, found %', target_clan, leader_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.clans_enforce_priority_capacity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  used integer;
BEGIN
  SELECT count(*) INTO used FROM clan_members
  WHERE clan_id = NEW.id AND has_priority;
  IF NEW.max_priority_slots < used THEN
    RAISE EXCEPTION
      'cannot lower max_priority_slots to % for clan %: % priority members are already assigned',
      NEW.max_priority_slots, NEW.id, used
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.clans_enforce_unique_tags() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  taken text;
BEGIN
  IF array_length(NEW.tags, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT other_tag INTO taken
  FROM clans AS other, unnest(other.tags) AS other_tag
  WHERE other.deleted_at IS NULL
    AND other.id <> NEW.id
    AND other_tag = ANY (NEW.tags)
  LIMIT 1;
  IF taken IS NOT NULL THEN
    RAISE EXCEPTION 'clan tag "%" already belongs to another clan', taken
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER clan_members_priority_limit AFTER INSERT OR UPDATE OF has_priority, clan_id ON public.clan_members DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.clan_members_enforce_priority_limit();
CREATE CONSTRAINT TRIGGER clan_members_single_leader AFTER INSERT OR DELETE OR UPDATE OF member_role, clan_id ON public.clan_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.clan_members_enforce_single_leader();
CREATE TRIGGER clans_priority_capacity BEFORE UPDATE OF max_priority_slots ON public.clans FOR EACH ROW WHEN ((new.max_priority_slots < old.max_priority_slots)) EXECUTE FUNCTION public.clans_enforce_priority_capacity();
CREATE TRIGGER clans_unique_tags BEFORE INSERT OR UPDATE OF tags ON public.clans FOR EACH ROW EXECUTE FUNCTION public.clans_enforce_unique_tags();
