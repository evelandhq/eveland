CREATE TABLE "git_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"host" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_user_host_idx" ON "git_credentials" USING btree ("user_id","host");--> statement-breakpoint
CREATE INDEX "git_credentials_user_idx" ON "git_credentials" USING btree ("user_id");