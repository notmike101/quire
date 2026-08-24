CREATE TABLE "share_messages" (
	"share_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"time" timestamp with time zone,
	"parts" jsonb NOT NULL,
	CONSTRAINT "share_messages_share_id_seq_pk" PRIMARY KEY("share_id","seq")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"session_id" text NOT NULL,
	"title" text NOT NULL,
	"model" text,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"password_hash" text,
	"revoked_at" timestamp with time zone,
	"preset" text DEFAULT 'strict' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"redactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "share_messages" ADD CONSTRAINT "share_messages_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;