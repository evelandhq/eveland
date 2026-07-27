export type DotenvImportEntry = {
  line: number;
  key: string;
  value: string;
  kind: "secret";
};

export type DotenvImportError = {
  line: number;
  message: string;
};

const environmentVariablePattern = /^[A-Z][A-Z0-9_]*$/;

export function parseDotenvImport(source: string): {
  entries: DotenvImportEntry[];
  errors: DotenvImportError[];
} {
  const parsed: DotenvImportEntry[] = [];
  const errors: DotenvImportError[] = [];

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    let content = rawLine.trim();
    if (!content || content.startsWith("#")) return;
    if (content.startsWith("export ")) content = content.slice("export ".length).trimStart();

    const separator = content.indexOf("=");
    if (separator <= 0) {
      errors.push({ line, message: "Use KEY=value format." });
      return;
    }

    const key = content.slice(0, separator).trim();
    if (!environmentVariablePattern.test(key)) {
      errors.push({
        line,
        message: "Use uppercase letters, numbers, and underscores, starting with a letter.",
      });
      return;
    }

    let value = content.slice(separator + 1).trim();
    if (!value) {
      errors.push({ line, message: "Enter a value after the equals sign." });
      return;
    }

    const quote = value[0];
    if (quote === "'" || quote === "\"") {
      if (value.length < 2 || value.at(-1) !== quote) {
        errors.push({ line, message: "Close the surrounding value quote." });
        return;
      }
      value = value.slice(1, -1);
      if (!value) {
        errors.push({ line, message: "Enter a value after the equals sign." });
        return;
      }
    }

    parsed.push({ line, key, value, kind: "secret" });
  });

  const keyCounts = new Map<string, number>();
  parsed.forEach((entry) => {
    keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
  });

  const entries: DotenvImportEntry[] = [];
  parsed.forEach((entry) => {
    if ((keyCounts.get(entry.key) ?? 0) > 1) {
      errors.push({
        line: entry.line,
        message: "Environment variable names must be unique.",
      });
      return;
    }
    entries.push(entry);
  });

  return {
    entries,
    errors: errors.sort((left, right) => left.line - right.line),
  };
}
