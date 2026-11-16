-- The shared workflow world's own database. Every Deployment holds its DSN,
-- so it never shares the platform database.
CREATE DATABASE eveland_workflow OWNER eveland;
