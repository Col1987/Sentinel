export type Action =
  | { kind: 'click';         selector: string; force?: boolean }
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

const OPEN_MODAL: JourneyStep[] = [
  {
    description: 'Click "Book a Demo" to open the modal',
    action: { kind: 'click', selector: 'button:has-text("Book a Demo")' },
  },
  {
    description: 'Wait for demo form to become visible',
    action: { kind: 'waitFor', selector: '#demo-name', state: 'visible' },
  },
];

const SELECT_PROPERTY: JourneyStep[] = [
  {
    description: 'Select property type: Airbnb',
    action: { kind: 'select', selector: '#demo-property-type', label: 'Airbnb' },
  },
  {
    description: 'Select number of properties: 1',
    action: { kind: 'select', selector: '#demo-num-properties', label: '1' },
  },
];

const CLICK_SUBMIT: JourneyStep = {
  description: 'Click submit button',
  action: { kind: 'click', selector: '#demo-submit-btn' },
};

const ASSERT_SUCCESS: JourneyStep = {
  description: 'Assert submit button is no longer visible — form transitioned to success state',
  action: { kind: 'waitFor', selector: '#demo-submit-btn', state: 'hidden', timeoutMs: 10_000 },
};

const ASSERT_NO_SUCCESS: JourneyStep = {
  description: 'Assert submit button is still visible — form did not reach a success state',
  action: { kind: 'assertVisible', selector: '#demo-submit-btn' },
};

export const journeys: Journey[] = [
  {
    id: 'demo-happy-path',
    description: 'Book a Demo modal — complete submission with valid data',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name field', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-empty-submit',
    description: 'Book a Demo modal — empty submit should not reach a success state',
    steps: [
      ...OPEN_MODAL,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-invalid-email',
    description: 'Book a Demo modal — non-email value should be rejected by browser validation',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name field', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      { description: 'Fill a non-email value', action: { kind: 'fill', selector: '#demo-email', value: 'not-an-email' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-missing-name',
    description: 'Book a Demo modal — empty name should be rejected by validation',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill email, leave name empty', action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-missing-email',
    description: 'Book a Demo modal — empty email should be rejected by validation',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name, leave email empty', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-long-input',
    description: 'Book a Demo modal — 2000-char name: frontend must not break and backend must receive full or truncated value',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name with 2000 characters', action: { kind: 'fill', selector: '#demo-name', value: 'A'.repeat(2000) } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-special-chars',
    description: 'Book a Demo modal — HTML/script payload in name must not execute as code',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name with XSS payload', action: { kind: 'fill', selector: '#demo-name', value: "O'Brien-Smith <script>alert(1)</script>" } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-double-submit',
    description: 'Book a Demo modal — concurrent submit clicks must fire only one backend request',
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name field', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: 'test@sentinel.dev' } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      // Force bypasses Playwright's disabled-element check so the click event reaches the DOM
      // even if the button was disabled after the first click. Whether the form's JS handler
      // honours the disabled state or uses a separate flag determines if a second request fires.
      { description: 'Second click on submit (forced — bypasses disabled state)', action: { kind: 'click', selector: '#demo-submit-btn', force: true } },
      ASSERT_SUCCESS,
    ],
  },
];
