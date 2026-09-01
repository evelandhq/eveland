import readline from "node:readline/promises";

/**
 * Interactive input for first-boot bootstrap. One narrow seam: `ask` returns
 * the answer or the default, and a non-interactive run (--no-prompt, or no
 * TTY) never blocks — every question must carry a workable default.
 */

export type Prompter = {
  interactive: boolean;
  ask: (question: string, defaultValue: string) => Promise<string>;
  confirm: (question: string, defaultValue: boolean) => Promise<boolean>;
};

export function nonInteractivePrompter(): Prompter {
  return {
    interactive: false,
    ask: async (_question, defaultValue) => defaultValue,
    confirm: async (_question, defaultValue) => defaultValue,
  };
}

export function createPrompter(options?: {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}): Prompter {
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stderr;
  if (!input.isTTY) return nonInteractivePrompter();
  return {
    interactive: true,
    ask: async (question, defaultValue) => {
      const rl = readline.createInterface({ input, output });
      try {
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        const answer = (await rl.question(`${question}${suffix}: `)).trim();
        return answer || defaultValue;
      } finally {
        rl.close();
      }
    },
    confirm: async (question, defaultValue) => {
      const rl = readline.createInterface({ input, output });
      try {
        const suffix = defaultValue ? " [Y/n]" : " [y/N]";
        const answer = (await rl.question(`${question}${suffix}: `)).trim().toLowerCase();
        if (!answer) return defaultValue;
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },
  };
}
