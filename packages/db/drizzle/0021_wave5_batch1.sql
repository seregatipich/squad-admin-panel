-- Wave 5 batch 1: MSG-1 (message templates), ISSUE-1 (issue tracker),
-- BANNAME-1 (banned-name rules). Hand-authored additive migration
-- (drizzle-kit generate is unreliable against the drifted meta snapshot).

ALTER TABLE roles ADD COLUMN can_manage_issues boolean DEFAULT false NOT NULL;
UPDATE roles SET can_manage_issues = true WHERE name = 'Owner';

CREATE TABLE public.banned_name_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pattern text NOT NULL,
    match_type text DEFAULT 'exact'::text NOT NULL,
    reason text,
    action text DEFAULT 'kick'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    last_hit_at timestamp with time zone,
    CONSTRAINT banned_name_rules_action_enum CHECK ((action = ANY (ARRAY['kick'::text, 'alert'::text]))),
    CONSTRAINT banned_name_rules_match_type_enum CHECK ((match_type = ANY (ARRAY['exact'::text, 'substring'::text, 'regex'::text])))
);

CREATE TABLE public.issue_labels (
    id uuid NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    is_system boolean DEFAULT false NOT NULL
);

CREATE TABLE public.issues (
    id uuid NOT NULL,
    number bigint NOT NULL,
    author_player_id uuid NOT NULL,
    assignee_player_id uuid,
    title text NOT NULL,
    body text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text)))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT issues_body_len CHECK ((char_length(body) <= 4000)),
    CONSTRAINT issues_state_check CHECK ((state = ANY (ARRAY['open'::text, 'in_progress'::text, 'closed'::text]))),
    CONSTRAINT issues_title_len CHECK ((char_length(title) <= 200))
);

CREATE SEQUENCE public.issues_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.issues_number_seq OWNED BY public.issues.number;
ALTER TABLE ONLY public.issues ALTER COLUMN number SET DEFAULT nextval('public.issues_number_seq'::regclass);

CREATE TABLE public.issue_comments (
    id uuid NOT NULL,
    issue_id uuid NOT NULL,
    author_player_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT issue_comments_body_len CHECK ((char_length(body) <= 4000))
);

CREATE TABLE public.issue_label_links (
    issue_id uuid NOT NULL,
    label_id uuid NOT NULL
);

CREATE TABLE public.message_templates (
    id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    category text NOT NULL,
    locale text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.banned_name_rules ADD CONSTRAINT banned_name_rules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.issue_labels ADD CONSTRAINT issue_labels_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.issues ADD CONSTRAINT issues_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.issue_comments ADD CONSTRAINT issue_comments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.issue_label_links ADD CONSTRAINT issue_label_links_issue_id_label_id_pk PRIMARY KEY (issue_id, label_id);
ALTER TABLE ONLY public.message_templates ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX banned_name_rules_pattern_match_type_key ON public.banned_name_rules USING btree (pattern, match_type);
CREATE UNIQUE INDEX issue_labels_name_key ON public.issue_labels USING btree (name);
CREATE UNIQUE INDEX issues_number_key ON public.issues USING btree (number);
CREATE INDEX issues_author_idx ON public.issues USING btree (author_player_id);
CREATE INDEX issues_assignee_idx ON public.issues USING btree (assignee_player_id) WHERE (assignee_player_id IS NOT NULL);
CREATE INDEX issues_state_idx ON public.issues USING btree (state);
CREATE INDEX issues_search_idx ON public.issues USING gin (search_vector);
CREATE INDEX issue_comments_issue_idx ON public.issue_comments USING btree (issue_id, created_at);
CREATE INDEX issue_label_links_label_idx ON public.issue_label_links USING btree (label_id);
CREATE INDEX message_templates_created_by_idx ON public.message_templates USING btree (created_by);
CREATE INDEX message_templates_sort_order_idx ON public.message_templates USING btree (sort_order);

ALTER TABLE ONLY public.banned_name_rules ADD CONSTRAINT banned_name_rules_created_by_players_id_fk FOREIGN KEY (created_by) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.issues ADD CONSTRAINT issues_author_player_id_players_id_fk FOREIGN KEY (author_player_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.issues ADD CONSTRAINT issues_assignee_player_id_players_id_fk FOREIGN KEY (assignee_player_id) REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.issue_comments ADD CONSTRAINT issue_comments_issue_id_issues_id_fk FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.issue_comments ADD CONSTRAINT issue_comments_author_player_id_players_id_fk FOREIGN KEY (author_player_id) REFERENCES public.players(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.issue_label_links ADD CONSTRAINT issue_label_links_issue_id_issues_id_fk FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.issue_label_links ADD CONSTRAINT issue_label_links_label_id_issue_labels_id_fk FOREIGN KEY (label_id) REFERENCES public.issue_labels(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.message_templates ADD CONSTRAINT message_templates_created_by_players_id_fk FOREIGN KEY (created_by) REFERENCES public.players(id) ON DELETE SET NULL;
