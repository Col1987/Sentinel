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

// ─── Registration form shared steps ──────────────────────────────────────────

const OPEN_REGISTER_MODAL: JourneyStep[] = [
  {
    description: 'Click Login button to open the login modal',
    action: { kind: 'click', selector: '#btn-login' },
  },
  {
    description: 'Wait for login modal to appear',
    action: { kind: 'waitFor', selector: '#login-email', state: 'visible' },
  },
  {
    description: 'Click Register link to switch to registration form',
    action: { kind: 'click', selector: 'a:has-text("Register")' },
  },
  {
    description: 'Wait for registration form to appear',
    action: { kind: 'waitFor', selector: '#reg-firstname', state: 'visible' },
  },
];

// Standard valid test data — all fields populated with non-real values
const FILL_REG_VALID: JourneyStep[] = [
  { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
  { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
  { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: 'sentinel-test@sentinel.dev' } },
  { description: 'Fill mobile number', action: { kind: 'fill', selector: '#reg-mobile-num', value: '821234567' } },
  { description: 'Fill password',         action: { kind: 'fill', selector: '#reg-password',         value: 'Test@12345!' } },
  { description: 'Fill confirm password', action: { kind: 'fill', selector: '#reg-confirm-password', value: 'Test@12345!' } },
];

const CHECK_TERMS: JourneyStep = {
  description: 'Check the terms and conditions checkbox',
  action: { kind: 'click', selector: '#reg-terms' },
};

const CLICK_CREATE_ACCOUNT: JourneyStep = {
  description: 'Click Create Account button',
  action: { kind: 'click', selector: 'button:has-text("Create Account")' },
};

const ASSERT_REG_BLOCKED: JourneyStep = {
  description: 'Assert Create Account button is still visible — submission was blocked',
  action: { kind: 'assertVisible', selector: 'button:has-text("Create Account")' },
};

// ─── Journeys ────────────────────────────────────────────────────────────────

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

  // ─── Registration form journeys ─────────────────────────────────────────────

  {
    id: 'reg-empty-submit',
    description: 'Registration form — all fields empty, submit should be blocked by validation',
    steps: [
      ...OPEN_REGISTER_MODAL,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-password-mismatch',
    description: 'Registration form — confirm password differs from password, must be rejected',
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: 'sentinel-test@sentinel.dev' } },
      { description: 'Fill mobile number', action: { kind: 'fill', selector: '#reg-mobile-num', value: '821234567' } },
      { description: 'Fill password',                           action: { kind: 'fill', selector: '#reg-password',         value: 'Test@12345' } },
      { description: 'Fill confirm password with different value', action: { kind: 'fill', selector: '#reg-confirm-password', value: 'Different@99' } },
      CHECK_TERMS,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-weak-password',
    description: 'Registration form — password "123" should fail strength validation or backend minimum-length check',
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: 'sentinel-test@sentinel.dev' } },
      { description: 'Fill mobile number', action: { kind: 'fill', selector: '#reg-mobile-num', value: '821234567' } },
      { description: 'Fill weak password "123"',          action: { kind: 'fill', selector: '#reg-password',         value: '123' } },
      { description: 'Fill confirm with same weak value', action: { kind: 'fill', selector: '#reg-confirm-password', value: '123' } },
      CHECK_TERMS,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-invalid-email',
    description: 'Registration form — non-email string should be rejected by input type="email" validation',
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill non-email string in email field', action: { kind: 'fill', selector: '#reg-email', value: 'notanemail' } },
      { description: 'Fill mobile number', action: { kind: 'fill', selector: '#reg-mobile-num', value: '821234567' } },
      { description: 'Fill password',         action: { kind: 'fill', selector: '#reg-password',         value: 'Test@12345!' } },
      { description: 'Fill confirm password', action: { kind: 'fill', selector: '#reg-confirm-password', value: 'Test@12345!' } },
      CHECK_TERMS,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-terms-unchecked',
    description: 'Registration form — unchecked terms checkbox must block submission',
    steps: [
      ...OPEN_REGISTER_MODAL,
      ...FILL_REG_VALID,
      // Intentionally omit CHECK_TERMS
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-invalid-phone',
    description: 'Registration form — non-numeric mobile number: check if format validation exists',
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: 'sentinel-test@sentinel.dev' } },
      { description: 'Fill non-numeric mobile number "abc"', action: { kind: 'fill', selector: '#reg-mobile-num', value: 'abc' } },
      { description: 'Fill password',         action: { kind: 'fill', selector: '#reg-password',         value: 'Test@12345!' } },
      { description: 'Fill confirm password', action: { kind: 'fill', selector: '#reg-confirm-password', value: 'Test@12345!' } },
      CHECK_TERMS,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-country-code-default',
    description: 'Registration form — country code select should default to South Africa (+27)',
    // No submit steps — spec reads the select value directly after the modal opens
    steps: [
      ...OPEN_REGISTER_MODAL,
    ],
  },
  {
    id: 'reg-happy-path',
    description: 'Registration form — valid data causes a Firebase Auth signUp request to the backend',
    // No final assertion in journey — spec verifies the auth request was attempted via waitForRequest
    steps: [
      ...OPEN_REGISTER_MODAL,
      ...FILL_REG_VALID,
      CHECK_TERMS,
      CLICK_CREATE_ACCOUNT,
    ],
  },
];
