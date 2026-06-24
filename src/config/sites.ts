export interface SiteConfig {
  name: string;
  baseUrl: string;
  timeout?: number;
  pages?: string[];
}

export const sites: Record<string, SiteConfig> = {
  juelhaus: {
    name: 'Juel Haus',
    baseUrl: 'https://www.juelhaus.co.za',
    timeout: 30_000,
    pages: ['/'],
  },
};

export const defaultSite = sites[process.env.TARGET_SITE ?? 'juelhaus'];
