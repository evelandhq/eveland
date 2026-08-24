import { readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { frontmatter } from "fumadocs-core/content/md/frontmatter";

const languages = ["en", "zh"];

async function listMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(entryPath)));
    if (entry.isFile() && [".md", ".mdx"].includes(extname(entry.name))) files.push(entryPath);
  }

  return files;
}

function pageLocation(language, relativeFile) {
  const sourceSlug = relativeFile.slice(0, -extname(relativeFile).length).split(sep).join("/");
  const slug = sourceSlug === "index" ? "" : sourceSlug.replace(/\/index$/, "");
  const prefix = language === "en" ? "/docs" : `/${language}/docs`;

  return {
    slug,
    pageUrl: `${prefix}${slug ? `/${slug}` : ""}`,
  };
}

export async function generateLlmPages({ docsDirectory, publicDirectory }) {
  if (basename(resolve(publicDirectory)) !== "public") {
    throw new Error('Refusing to replace generated assets outside a directory named "public".');
  }

  const destinations = {
    en: {
      root: join(publicDirectory, "docs.md"),
      directory: join(publicDirectory, "docs"),
    },
    zh: {
      root: join(publicDirectory, "zh", "docs.md"),
      directory: join(publicDirectory, "zh", "docs"),
    },
  };

  await Promise.all([
    rm(destinations.en.root, { force: true }),
    rm(destinations.en.directory, { recursive: true, force: true }),
    rm(destinations.zh.root, { force: true }),
    rm(destinations.zh.directory, { recursive: true, force: true }),
    rm(join(publicDirectory, "_llms"), { recursive: true, force: true }),
  ]);
  let pages = 0;

  for (const language of languages) {
    const languageDirectory = join(docsDirectory, language);
    const files = await listMarkdownFiles(languageDirectory);

    for (const file of files) {
      const parsed = frontmatter(await readFile(file, "utf8"));
      if (typeof parsed.data.title !== "string" || parsed.data.title.length === 0) {
        throw new Error(`Missing title in ${file}`);
      }

      const title = parsed.data.title;
      const { slug, pageUrl } = pageLocation(language, relative(languageDirectory, file));
      const destination = slug
        ? join(destinations[language].directory, `${slug}.md`)
        : destinations[language].root;
      const body = parsed.content.trim();
      const markdown = `# ${title} (${pageUrl})\n${body ? `\n${body}\n` : ""}`;

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, markdown);
      pages += 1;
    }
  }

  return { pages };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const appDirectory = resolve(dirname(scriptPath), "..");
  const result = await generateLlmPages({
    docsDirectory: resolve(appDirectory, "../../docs"),
    publicDirectory: resolve(appDirectory, "public"),
  });

  console.log(`Generated ${result.pages} page-action Markdown assets.`);
}
