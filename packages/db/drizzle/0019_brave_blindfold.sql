CREATE TABLE "platform_secret_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_secret_profiles_name_unique" UNIQUE("name"),
	CONSTRAINT "platform_secret_profiles_revision_check" CHECK ("platform_secret_profiles"."revision" > 0)
);
