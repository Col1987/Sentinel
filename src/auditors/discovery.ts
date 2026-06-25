import { Page } from '@playwright/test';
import type { AuditResult, AuditFinding } from './types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DiscoveredElement {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelText?: string;
  selector: string;
  textContent?: string;
  hasAccessibleName: boolean;
}

export interface FormGroup {
  formId?: string;
  formName?: string;
  formAction?: string;
  elements: DiscoveredElement[];
}

export interface PageDiscovery {
  url: string;
  forms: FormGroup[];
  orphans: DiscoveredElement[];
}

// ─── Serialisable types for page.evaluate() return ────────────────────────────
// Must mirror the public types but with null instead of undefined (JSON safe).

interface RawElement {
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  labelText: string | null;
  selector: string;
  textContent: string | null;
  hasAccessibleName: boolean;
}

interface RawForm {
  formId: string | null;
  formName: string | null;
  formAction: string | null;
  elements: RawElement[];
}

interface RawPageData {
  forms: RawForm[];
  orphans: RawElement[];
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalise(raw: RawElement): DiscoveredElement {
  const el: DiscoveredElement = {
    tag: raw.tag,
    selector: raw.selector,
    hasAccessibleName: raw.hasAccessibleName,
  };
  if (raw.type)        el.type        = raw.type;
  if (raw.id)          el.id          = raw.id;
  if (raw.name)        el.name        = raw.name;
  if (raw.placeholder) el.placeholder = raw.placeholder;
  if (raw.ariaLabel)   el.ariaLabel   = raw.ariaLabel;
  if (raw.labelText)   el.labelText   = raw.labelText;
  if (raw.textContent) el.textContent = raw.textContent;
  return el;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function discoverInteractiveElements(
  page: Page,
  targetUrl: string,
): Promise<{ result: AuditResult; discovery: PageDiscovery }> {
  const start = Date.now();
  const findings: AuditFinding[] = [];

  const raw = await page.evaluate((): RawPageData => {
    // ── Helpers (all run in browser context) ──────────────────────────────────

    function getLabelText(el: Element): string | null {
      // 1. aria-labelledby (may reference multiple ids)
      const labelledBy = el.getAttribute('aria-labelledby')?.trim();
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (text) return text;
      }

      // 2. <label for="id">
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
        if (label) return label.textContent?.trim() ?? null;
      }

      // 3. Ancestor <label> — strip the control's own value to get only label copy
      const ancestor = el.closest('label');
      if (ancestor) {
        const clone = ancestor.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
        const text = clone.textContent?.trim();
        return text || null;
      }

      return null;
    }

    function checkAccessibleName(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type')?.toLowerCase() ?? '';

      if (el.getAttribute('aria-label')?.trim()) return true;

      const labelledBy = el.getAttribute('aria-labelledby')?.trim();
      if (labelledBy) {
        const hasText = labelledBy
          .split(/\s+/)
          .some(id => (document.getElementById(id)?.textContent?.trim() ?? '').length > 0);
        if (hasText) return true;
      }

      const id = el.getAttribute('id');
      if (id && document.querySelector(`label[for="${id}"]`)) return true;

      if (el.closest('label')) return true;

      // Buttons and links: text content
      if (tag === 'button' || tag === 'a') {
        if ((el as HTMLElement).innerText?.trim() || el.textContent?.trim()) return true;
      }

      // input[type=submit|button|reset]: value or implicit browser label
      if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) {
        return true; // browser provides default label if value is absent
      }

      // input[type=image]: alt attribute (even empty alt is intentional)
      if (tag === 'input' && type === 'image') {
        return el.hasAttribute('alt');
      }

      // title as last-resort accessible name
      if (el.getAttribute('title')?.trim()) return true;

      return false;
    }

    function getBestSelector(el: Element): string {
      const tag = el.tagName.toLowerCase();

      // 1. Unique id
      const id = el.getAttribute('id');
      if (id) {
        try {
          if (document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
            return '#' + CSS.escape(id);
          }
        } catch (_) { /* fall through */ }
      }

      // 2. data-testid and common test-selector conventions
      const testId =
        el.getAttribute('data-testid') ??
        el.getAttribute('data-test-id') ??
        el.getAttribute('data-cy') ??
        el.getAttribute('data-qa');
      if (testId) return `[data-testid="${testId}"]`;

      // 3. name attribute for form controls
      const name = el.getAttribute('name');
      if (name && ['input', 'select', 'textarea', 'button'].includes(tag)) {
        return `${tag}[name="${name}"]`;
      }

      // 4. Unique href for links
      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href) {
          const escaped = href.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          if (document.querySelectorAll(`a[href="${escaped}"]`).length === 1) {
            return `a[href="${escaped}"]`;
          }
        }
      }

      // 5. Tag + type (best effort; may not be unique)
      const type = el.getAttribute('type');
      return type ? `${tag}[type="${type}"]` : tag;
    }

    function extractElement(el: Element): RawElement {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const id = el.getAttribute('id');
      const name = el.getAttribute('name');

      let textContent: string | null = null;
      if (tag === 'button' || tag === 'a') {
        const raw = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || '';
        textContent = raw.length > 0 ? raw.slice(0, 200) : null;
      }

      return {
        tag,
        type:             type             ?? null,
        id:               id               ?? null,
        name:             name             ?? null,
        placeholder:      el.getAttribute('placeholder') ?? null,
        ariaLabel:        el.getAttribute('aria-label')  ?? null,
        labelText:        getLabelText(el),
        selector:         getBestSelector(el),
        textContent,
        hasAccessibleName: checkAccessibleName(el),
      };
    }

    // ── Collect interactive elements ──────────────────────────────────────────

    const allInteractive = Array.from(
      document.querySelectorAll<Element>(
        'input:not([type="hidden"]), button, a[href], select, textarea',
      ),
    );

    // Map each element to its closest <form> ancestor
    const formBuckets = new Map<HTMLFormElement, Element[]>();
    const orphanEls: Element[] = [];

    for (const el of allInteractive) {
      const form = el.closest<HTMLFormElement>('form');
      if (form) {
        if (!formBuckets.has(form)) formBuckets.set(form, []);
        formBuckets.get(form)!.push(el);
      } else {
        orphanEls.push(el);
      }
    }

    // Iterate forms in document order, skip empty forms
    const forms: RawForm[] = Array.from(
      document.querySelectorAll<HTMLFormElement>('form'),
    )
      .filter(f => formBuckets.has(f))
      .map(f => ({
        formId:     f.id               || null,
        formName:   f.getAttribute('name')   ?? null,
        formAction: f.getAttribute('action') ?? null,
        elements:   formBuckets.get(f)!.map(extractElement),
      }));

    return { forms, orphans: orphanEls.map(extractElement) };
  });

  // ── Convert raw browser data to public types ───────────────────────────────

  const discovery: PageDiscovery = {
    url: targetUrl,
    forms: raw.forms.map(f => {
      const group: FormGroup = { elements: f.elements.map(normalise) };
      if (f.formId)     group.formId     = f.formId;
      if (f.formName)   group.formName   = f.formName;
      if (f.formAction) group.formAction = f.formAction;
      return group;
    }),
    orphans: raw.orphans.map(normalise),
  };

  // ── Generate findings for elements with no accessible name ─────────────────

  const allElements = [
    ...discovery.forms.flatMap(f => f.elements),
    ...discovery.orphans,
  ];

  for (const el of allElements) {
    if (el.hasAccessibleName) continue;

    const isButton =
      el.tag === 'button' ||
      (el.tag === 'input' &&
        ['submit', 'button', 'reset', 'image'].includes(el.type ?? ''));
    const isFormControl =
      ['input', 'select', 'textarea'].includes(el.tag) && !isButton;
    const isLink = el.tag === 'a';

    if (isFormControl) {
      findings.push({
        url: targetUrl,
        severity: 'high',
        category: 'discovery',
        message: 'Form control with no accessible label',
        selector: el.selector,
        detail: `<${el.tag}${el.type ? ` type="${el.type}"` : ''}> has no <label>, aria-label, or aria-labelledby`,
      });
    } else if (isButton) {
      findings.push({
        url: targetUrl,
        severity: 'high',
        category: 'discovery',
        message: 'Interactive control with no accessible name',
        selector: el.selector,
        detail: `<${el.tag}> has no visible text content, aria-label, or aria-labelledby`,
      });
    } else if (isLink) {
      findings.push({
        url: targetUrl,
        severity: 'medium',
        category: 'discovery',
        message: 'Link with no accessible name',
        selector: el.selector,
        detail: `<a> has no text content, aria-label, or aria-labelledby`,
      });
    }
  }

  return {
    result: {
      auditor: 'discovery',
      targetUrl,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      passed: true,
      warning: findings.length > 0,
      findings,
    },
    discovery,
  };
}
