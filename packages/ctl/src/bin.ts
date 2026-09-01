#!/usr/bin/env node
import process from "node:process";
import { runCtl } from "./ctl.ts";

const exitCode = await runCtl(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
process.exitCode = exitCode;
