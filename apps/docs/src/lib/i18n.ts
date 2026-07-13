import { defineI18n } from 'fumadocs-core/i18n';

export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'zh'],
  hideLocale: 'default-locale',
  parser: 'dir',
});

export type Language = (typeof i18n.languages)[number];

export function isLanguage(value: string): value is Language {
  return (i18n.languages as readonly string[]).includes(value);
}
