#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { runCli } from "./cli.ts";

function openUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
    if (!opener) return resolve();
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.unref();
    resolve();
  });
}

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  openUrl,
});
process.exitCode = exitCode;
