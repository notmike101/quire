CREATE TABLE "share_blobs_v2" (
	"share_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"ciphertext_bytes" integer NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "share_blobs_v2_share_id_kind_seq_pk" PRIMARY KEY("share_id","kind","seq")
);
--> statement-breakpoint
CREATE TABLE "share_source_chunks_v2" (
	"share_id" uuid NOT NULL,
	"source_seq" integer NOT NULL,
	"request_digest" text NOT NULL,
	CONSTRAINT "share_source_chunks_v2_share_id_source_seq_pk" PRIMARY KEY("share_id","source_seq")
);
--> statement-breakpoint
CREATE TABLE "shares_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"upload_request_id" text NOT NULL,
	"upload_token_hash" text NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"preset" text DEFAULT 'strict' NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"source_chunk_count" integer NOT NULL,
	"received_chunk_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"redactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text,
	"model" text,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_v2_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "shares_v2_upload_request_id_unique" UNIQUE("upload_request_id")
);
--> statement-breakpoint
ALTER TABLE "share_blobs_v2" ADD CONSTRAINT "share_blobs_v2_share_id_shares_v2_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares_v2"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_source_chunks_v2" ADD CONSTRAINT "share_source_chunks_v2_share_id_shares_v2_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares_v2"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_v2_created_at_idx" ON "shares_v2" USING btree ("created_at");