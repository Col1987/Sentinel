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

// When true, tests skip route interception and interact with real backends.
// Set SENTINEL_LIVE_MODE=true only when intentional end-to-end verification is needed.
export const LIVE_MODE = process.env.SENTINEL_LIVE_MODE === 'true';
