import type postgres from "postgres";

const routeNotifyDdl = `
CREATE OR REPLACE FUNCTION eveland_notify_route_change() RETURNS trigger AS $$
DECLARE
  slug_value text;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    PERFORM pg_notify('eveland_routes', OLD.slug);
    IF TG_OP = 'UPDATE' AND NEW.slug IS DISTINCT FROM OLD.slug THEN
      PERFORM pg_notify('eveland_routes', NEW.slug);
    END IF;
  ELSE
    SELECT slug INTO slug_value FROM projects WHERE id = COALESCE(NEW.project_id, OLD.project_id);
    IF slug_value IS NOT NULL THEN
      PERFORM pg_notify('eveland_routes', slug_value);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS eveland_projects_route_notify ON projects;
CREATE TRIGGER eveland_projects_route_notify
AFTER UPDATE OF slug, deployment_id, deployment_status OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION eveland_notify_route_change();

DROP TRIGGER IF EXISTS eveland_deployments_route_notify ON deployments;
CREATE TRIGGER eveland_deployments_route_notify
AFTER UPDATE OF status, host_port, host_address OR DELETE ON deployments
FOR EACH ROW EXECUTE FUNCTION eveland_notify_route_change();
`;

export async function ensureRouteNotifyTriggers(client: postgres.Sql): Promise<void> {
  await client.unsafe(routeNotifyDdl);
}
