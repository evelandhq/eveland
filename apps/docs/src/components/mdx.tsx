import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { RuntimeTopology } from "@/components/runtime-topology";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    RuntimeTopology,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
