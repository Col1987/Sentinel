export type Action =
  | { kind: 'click';         selector: string }
  | { kind: 'fill';          selector: string; value: string }
  | { kind: 'select';        selector: string; label: string }
  | { kind: 'waitFor';       selector: string; state: 'visible' | 'hidden' | 'attached'; timeoutMs?: number }
  | { kind: 'assertVisible'; selector: string }
  | { kind: 'assertHidden';  selector: string }
  | { kind: 'assertText';    selector: string; contains: string };

export interface JourneyStep {
  description: string;
  action: Action;
}

export interface Journey {
  id: string;
  description: string;
  steps: JourneyStep[];
}

export const journeys: Journey[] = [
  {
    id: 'demo-happy-path',
    description: 'Book a Demo modal — complete submission with valid data',
    steps: [
      {
        description: 'Click "Book a Demo" to open the modal',
        action: { kind: 'click', selector: 'button:has-text("Book a Demo")' },
      },
      {
        description: 'Wait for demo form to become visible',
        action: { kind: 'waitFor', selector: '#demo-name', state: 'visible' },
      },
      {
        description: 'Fill name field',
        action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' },
      },
      {
        description: 'Fill email field',
        action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' },
      },
      {
        description: 'Select property type: Airbnb',
        action: { kind: 'select', selector: '#demo-property-type', label: 'Airbnb' },
      },
      {
        description: 'Select number of properties: 1',
        action: { kind: 'select', selector: '#demo-num-properties', label: '1' },
      },
      {
        description: 'Click submit button',
        action: { kind: 'click', selector: '#demo-submit-btn' },
      },
      {
        description: 'Assert submit button is no longer visible — form transitioned to success state',
        action: { kind: 'waitFor', selector: '#demo-submit-btn', state: 'hidden', timeoutMs: 10_000 },
      },
    ],
  },
  {
    id: 'demo-empty-submit',
    description: 'Book a Demo modal — empty submit should not reach a success state',
    steps: [
      {
        description: 'Click "Book a Demo" to open the modal',
        action: { kind: 'click', selector: 'button:has-text("Book a Demo")' },
      },
      {
        description: 'Wait for demo form to become visible',
        action: { kind: 'waitFor', selector: '#demo-name', state: 'visible' },
      },
      {
        description: 'Click submit without filling any fields',
        action: { kind: 'click', selector: '#demo-submit-btn' },
      },
      {
        description: 'Assert submit button is still visible — form did not reach a success state',
        action: { kind: 'assertVisible', selector: '#demo-submit-btn' },
      },
    ],
  },
];
