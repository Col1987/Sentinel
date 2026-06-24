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

// ─── Login form shared steps ──────────────────────────────────────────────────

const OPEN_LOGIN_MODAL: JourneyStep[] = [
  {
    description: 'Click Login button to open the login modal',
    action: { kind: 'click', selector: '#btn-login' },
  },
  {
    description: 'Wait for login modal to appear',
    action: { kind: 'waitFor', selector: '#login-email', state: 'visible' },
  },
];

const CLICK_LOGIN_SUBMIT: JourneyStep = {
  description: 'Click Login submit button',
  action: { kind: 'click', selector: 'button[type="submit"]:has-text("Login")' },
};

const ASSERT_LOGIN_BLOCKED: JourneyStep = {
  description: 'Assert Login button is still visible — submission was blocked by validation',
  action: { kind: 'assertVisible', selector: 'button[type="submit"]:has-text("Login")' },
};

// ─── Forgot password shared steps ────────────────────────────────────────────

const OPEN_FORGOT_MODAL: JourneyStep[] = [
  ...OPEN_LOGIN_MODAL,
  {
    description: 'Click "Forgot your password?" link',
    action: { kind: 'click', selector: 'a:has-text("Forgot")' },
  },
  {
    description: 'Wait for forgot password form to appear',
    action: { kind: 'waitFor', selector: '#forgot-email', state: 'visible' },
  },
];

const CLICK_SEND_RESET: JourneyStep = {
  description: 'Click Send Reset Link button',
  action: { kind: 'click', selector: 'button[type="submit"]:has-text("Send Reset Link")' },
};

const ASSERT_FORGOT_BLOCKED: JourneyStep = {
  description: 'Assert Send Reset Link button is still visible — submission was blocked',
  action: { kind: 'assertVisible', selector: 'button[type="submit"]:has-text("Send Reset Link")' },
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

  // ─── Login form journeys ─────────────────────────────────────────────────────

  {
    id: 'login-empty-submit',
    description: 'Login form — empty submit must be blocked by validation',
    steps: [
      ...OPEN_LOGIN_MODAL,
      CLICK_LOGIN_SUBMIT,
      ASSERT_LOGIN_BLOCKED,
    ],
  },
  {
    id: 'login-invalid-email',
    description: 'Login form — non-email string must be rejected by input type="email" validation',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Fill non-email string', action: { kind: 'fill', selector: '#login-email',    value: 'notanemail' } },
      { description: 'Fill any password',     action: { kind: 'fill', selector: '#login-password', value: 'AnyPassword1' } },
      CLICK_LOGIN_SUBMIT,
      ASSERT_LOGIN_BLOCKED,
    ],
  },
  {
    id: 'login-password-toggle',
    description: 'Login form — show/hide toggle must switch input type between "password" and "text"',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Fill password field with a test value',      action: { kind: 'fill',          selector: '#login-password',               value: 'TestPassword123' } },
      { description: 'Assert input type is "password" initially',  action: { kind: 'assertVisible', selector: '#login-password[type="password"]' } },
      { description: 'Click Show Password toggle',                 action: { kind: 'click',         selector: '#login-password ~ button[aria-label="Show password"]' } },
      { description: 'Assert input type changed to "text"',        action: { kind: 'assertVisible', selector: '#login-password[type="text"]' } },
      { description: 'Click Hide Password toggle',                 action: { kind: 'click',         selector: '#login-password ~ button[aria-label="Hide password"]' } },
      { description: 'Assert input type reverted to "password"',   action: { kind: 'assertVisible', selector: '#login-password[type="password"]' } },
    ],
  },
  {
    id: 'login-remember-me',
    description: 'Login form — remember-me checkbox must be present and interactive',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Verify checkbox is unchecked by default', action: { kind: 'assertVisible', selector: '#login-remember:not(:checked)' } },
      { description: 'Click checkbox to check it',              action: { kind: 'click',         selector: '#login-remember' } },
      { description: 'Verify checkbox is now checked',          action: { kind: 'assertVisible', selector: '#login-remember:checked' } },
    ],
  },
  {
    id: 'login-to-register',
    description: 'Login form — Register link must open the registration form',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Register link',                   action: { kind: 'click',   selector: 'a:has-text("Register")' } },
      { description: 'Verify registration form is now visible', action: { kind: 'waitFor', selector: '#reg-firstname', state: 'visible' } },
    ],
  },
  {
    id: 'login-to-forgot',
    description: 'Login form — Forgot password link must open the forgot password form',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Forgot your password? link',       action: { kind: 'click',   selector: 'a:has-text("Forgot")' } },
      { description: 'Verify forgot password form is visible', action: { kind: 'waitFor', selector: '#forgot-email', state: 'visible' } },
    ],
  },

  // ─── Forgot password form journeys ──────────────────────────────────────────

  {
    id: 'forgot-empty-submit',
    description: 'Forgot password form — empty submit must be blocked by validation',
    steps: [
      ...OPEN_FORGOT_MODAL,
      CLICK_SEND_RESET,
      ASSERT_FORGOT_BLOCKED,
    ],
  },
  {
    id: 'forgot-invalid-email',
    description: 'Forgot password form — non-email string must be rejected by input type="email" validation',
    steps: [
      ...OPEN_FORGOT_MODAL,
      { description: 'Fill non-email string', action: { kind: 'fill', selector: '#forgot-email', value: 'notanemail' } },
      CLICK_SEND_RESET,
      ASSERT_FORGOT_BLOCKED,
    ],
  },
  {
    id: 'forgot-happy-path',
    description: 'Forgot password form — valid email must trigger a Firebase Auth password-reset request',
    // No journey assertion — spec verifies the sendOobCode request was attempted via waitForRequest
    steps: [
      ...OPEN_FORGOT_MODAL,
      { description: 'Fill valid email', action: { kind: 'fill', selector: '#forgot-email', value: 'sentinel-test@sentinel.dev' } },
      CLICK_SEND_RESET,
    ],
  },
  {
    id: 'forgot-back-to-login',
    description: 'Forgot password form — Back to login link must restore the login form',
    steps: [
      ...OPEN_FORGOT_MODAL,
      { description: 'Click Back to login link',            action: { kind: 'click',   selector: '#auth-forgot a:has-text("Back")' } },
      { description: 'Verify login email field reappears', action: { kind: 'waitFor', selector: '#login-email', state: 'visible' } },
    ],
  },

  // ─── Navigation journeys ──────────────────────────────────────────────────────

  {
    id: 'nav-platform-link',
    description: 'Desktop nav — "The Platform" link scrolls the #platform section into view',
    steps: [
      { description: 'Click The Platform nav link', action: { kind: 'click', selector: '.nav-links a:has-text("The Platform")' } },
    ],
  },
  {
    id: 'nav-how-it-works-link',
    description: 'Desktop nav — "How It Works" link scrolls the #how-it-works section into view',
    steps: [
      { description: 'Click How It Works nav link', action: { kind: 'click', selector: '.nav-links a:has-text("How It Works")' } },
    ],
  },
  {
    id: 'nav-welcome-packs-link',
    description: 'Desktop nav — "Welcome Packs" link scrolls the #gifts section into view',
    steps: [
      { description: 'Click Welcome Packs nav link', action: { kind: 'click', selector: '.nav-links a:has-text("Welcome Packs")' } },
    ],
  },
  {
    id: 'nav-my-account-link',
    description: 'Desktop nav — "My Account" link navigates to /account.html',
    steps: [
      { description: 'Click My Account nav link', action: { kind: 'click', selector: '#nav-account' } },
    ],
  },
  {
    id: 'nav-logo-home',
    description: 'Logo link — clicking from any scroll position returns to the top of the homepage',
    steps: [
      { description: 'Click the logo link', action: { kind: 'click', selector: 'a[href="index.html"]' } },
    ],
  },

  // ─── Modal open/close journeys ─────────────────────────────────────────────────

  {
    id: 'modal-login-opens',
    description: 'Login modal — clicking #btn-login makes #auth-modal visible',
    steps: [
      { description: 'Click Login button',                      action: { kind: 'click',   selector: '#btn-login' } },
      { description: 'Verify auth modal overlay is visible',    action: { kind: 'waitFor', selector: '#auth-modal', state: 'visible' } },
    ],
  },
  {
    id: 'modal-login-closes-x',
    description: 'Login modal — clicking × closes #auth-modal',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click modal × close button',             action: { kind: 'click',   selector: '#auth-modal .modal-close' } },
      { description: 'Verify auth modal overlay is hidden',    action: { kind: 'waitFor', selector: '#auth-modal', state: 'hidden' } },
    ],
  },
  {
    id: 'modal-login-to-register',
    description: 'Login modal — Register link switches to the registration form',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Register link',                              action: { kind: 'click',   selector: 'a:has-text("Register")' } },
      { description: 'Verify registration first name field is visible',  action: { kind: 'waitFor', selector: '#reg-firstname', state: 'visible' } },
    ],
  },
  {
    id: 'modal-register-to-login',
    description: 'Register form — Login link switches back to the login form',
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Click Login link in register form',      action: { kind: 'click',   selector: '#auth-register a:has-text("Login")' } },
      { description: 'Verify login email field is visible',    action: { kind: 'waitFor', selector: '#login-email', state: 'visible' } },
    ],
  },
  {
    id: 'modal-login-to-forgot',
    description: 'Login modal — Forgot password link switches to the forgot password form',
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Forgot your password? link',       action: { kind: 'click',   selector: 'a:has-text("Forgot")' } },
      { description: 'Verify forgot email field is visible',   action: { kind: 'waitFor', selector: '#forgot-email', state: 'visible' } },
    ],
  },
  {
    id: 'modal-demo-opens',
    description: 'Demo modal — clicking Book a Demo makes #demo-modal visible',
    steps: [
      { description: 'Click Book a Demo button',               action: { kind: 'click',   selector: 'button:has-text("Book a Demo")' } },
      { description: 'Verify demo modal overlay is visible',   action: { kind: 'waitFor', selector: '#demo-modal', state: 'visible' } },
    ],
  },
  {
    id: 'modal-demo-closes-x',
    description: 'Demo modal — clicking × closes #demo-modal',
    steps: [
      { description: 'Click Book a Demo button',               action: { kind: 'click',   selector: 'button:has-text("Book a Demo")' } },
      { description: 'Verify demo modal overlay is visible',   action: { kind: 'waitFor', selector: '#demo-modal', state: 'visible' } },
      { description: 'Click modal × close button',             action: { kind: 'click',   selector: '#demo-modal .modal-close' } },
      { description: 'Verify demo modal overlay is hidden',    action: { kind: 'waitFor', selector: '#demo-modal', state: 'hidden' } },
    ],
  },
  {
    id: 'modal-cart-opens',
    description: 'Cart drawer — clicking #nav-cart makes #cart-drawer visible',
    steps: [
      { description: 'Click cart nav button',                  action: { kind: 'click',   selector: '#nav-cart' } },
      { description: 'Verify cart drawer is visible',          action: { kind: 'waitFor', selector: '#cart-drawer', state: 'visible' } },
    ],
  },
  {
    id: 'modal-cart-closes',
    description: 'Cart drawer — clicking × inside the cart hides #cart-drawer',
    steps: [
      { description: 'Click cart nav button',                  action: { kind: 'click',   selector: '#nav-cart' } },
      { description: 'Verify cart drawer is visible',          action: { kind: 'waitFor', selector: '#cart-drawer', state: 'visible' } },
      { description: 'Click × close button in cart header',    action: { kind: 'click',   selector: '.cart-header button:has-text("×")' } },
      { description: 'Verify cart drawer is hidden',           action: { kind: 'waitFor', selector: '#cart-drawer', state: 'hidden' } },
    ],
  },

  // ─── Mobile/responsive journeys ────────────────────────────────────────────────

  {
    id: 'mobile-hamburger-opens',
    description: 'Mobile — hamburger button makes #mobile-menu visible',
    steps: [
      { description: 'Click hamburger button',                 action: { kind: 'click',   selector: '#nav-hamburger' } },
      { description: 'Verify mobile menu is visible',          action: { kind: 'waitFor', selector: '#mobile-menu', state: 'visible' } },
    ],
  },
  {
    id: 'mobile-nav-links-work',
    description: 'Mobile — tapping a mobile nav link scrolls to the target section',
    steps: [
      { description: 'Click hamburger to open mobile menu',    action: { kind: 'click',   selector: '#nav-hamburger' } },
      { description: 'Wait for mobile menu to appear',         action: { kind: 'waitFor', selector: '#mobile-menu', state: 'visible' } },
      { description: 'Click How It Works in mobile menu',      action: { kind: 'click',   selector: '#mobile-menu a:has-text("How It Works")' } },
    ],
  },
];
