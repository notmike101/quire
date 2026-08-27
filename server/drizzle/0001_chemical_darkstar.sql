ALTER TABLE "shares" ADD COLUMN "upload_id" text NOT NULL DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "upload_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "share_messages" ADD COLUMN "chunk_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_messages" DROP CONSTRAINT "share_messages_share_id_seq_pk";--> statement-breakpoint
ALTER TABLE "share_messages" ADD CONSTRAINT "share_messages_share_id_chunk_seq_seq_pk" PRIMARY KEY("share_id","chunk_seq","seq");--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_upload_id_unique" UNIQUE("upload_id");