ALTER TABLE "deployments" ADD COLUMN "host_address" text NOT NULL DEFAULT '127.0.0.1';--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "host_address" DROP DEFAULT;
