ALTER TABLE "deployments" ADD COLUMN "runtime_kind" text NOT NULL DEFAULT 'docker';
ALTER TABLE "deployments" ALTER COLUMN "runtime_kind" DROP DEFAULT;
