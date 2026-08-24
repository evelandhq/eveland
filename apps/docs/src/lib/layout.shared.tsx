import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { uiTranslations } from "fumadocs-ui/i18n";
import { Brand } from "@/components/brand";
import { i18n, type Language } from "@/lib/i18n";
import { localizedHref } from "@/lib/urls";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add("ui", {
    en: { displayName: "English" },
    zh: {
      displayName: "简体中文",
      search: "搜索",
      searchNoResult: "没有找到结果",
      searchOpen: "打开搜索",
      searchClose: "关闭搜索",
      toc: "本页内容",
      tocNoHeadings: "本页没有标题",
      tocInline: "目录",
      lastUpdate: "最后更新于",
      chooseLanguage: "选择语言",
      nextPage: "下一页",
      previousPage: "上一页",
      chooseTheme: "主题",
      editOnGithub: "在 GitHub 编辑",
      themeToggle: "切换主题",
      themeLight: "浅色",
      themeDark: "深色",
      themeSystem: "跟随系统",
      codeBlockCopy: "复制代码",
      codeBlockCopied: "已复制",
      accordionCopyAnchor: "复制链接",
      headingCopyAnchor: "复制标题链接",
      sidebarOpen: "打开侧边栏",
      sidebarCollapse: "收起侧边栏",
      menuToggle: "切换菜单",
      notFoundTitle: "页面不存在",
      notFoundDescription: "页面可能已被移动、重命名或删除。",
      notFoundLink: "返回首页",
      "Copy Markdown(page actions)": "复制页面",
      "Open(page actions)": "打开",
      "Open in GitHub(page actions)": "在 GitHub 中打开",
      "View as Markdown(page actions)": "查看 Markdown",
      "Open in Scira AI(page actions)": "在 Scira AI 中打开",
      "Open in ChatGPT(page actions)": "在 ChatGPT 中打开",
      "Open in Claude(page actions)": "在 Claude 中打开",
      "Open in Cursor(page actions)": "在 Cursor 中打开",
      "Read {url}, I want to ask questions about it.(page actions)":
        "阅读 {url}，我想询问与此页面有关的问题。",
    },
  });

export function baseOptions(lang: Language): BaseLayoutProps {
  return {
    nav: {
      title: <Brand lang={lang} linked={false} />,
      url: localizedHref(lang),
    },
    links: [],
    githubUrl: "https://github.com/evelandhq/eveland",
    i18n: true,
  };
}
