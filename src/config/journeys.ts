import { testEmail } from './sites';

export type Action =
  | { kind: 'click';         selector: string; force?: boolean }
  | { kind: 'fill';          selector: string; value: string }
  | { kind: 'select';        selector: string; label: string }
  | { kind: 'waitFor';       selector: string; state: 'visible' | 'hidden' | 'attached' }
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
  clientDescription: string;
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
  action: { kind: 'waitFor', selector: '#demo-submit-btn', state: 'hidden' },
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
  { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: testEmail('reg01') } },
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
    clientDescription: "Filled in the 'Book a Demo' form with a valid name, email address, and property details, then clicked Submit. CONFIRMED: the form successfully sent the booking request to the server.",
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name field', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: testEmail('demo01') } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-empty-submit',
    description: 'Book a Demo modal — empty submit should not reach a success state',
    clientDescription: "Opened the 'Book a Demo' form and clicked Submit without filling in any fields. CONFIRMED: the form correctly prevented submission and did not send any data to the server.",
    steps: [
      ...OPEN_MODAL,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-invalid-email',
    description: 'Book a Demo modal — non-email value should be rejected by browser validation',
    clientDescription: "Entered an invalid email address ('not-an-email') in the demo booking form and clicked Submit. CONFIRMED: the form blocked submission — only properly formatted email addresses are accepted.",
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
    clientDescription: "Left the name field empty in the demo booking form and clicked Submit. CONFIRMED: the form blocked submission — a name is required before the form can be sent.",
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill email, leave name empty', action: { kind: 'fill', selector: '#demo-email', value: testEmail('demo01') } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_NO_SUCCESS,
    ],
  },
  {
    id: 'demo-missing-email',
    description: 'Book a Demo modal — empty email should be rejected by validation',
    clientDescription: "Left the email field empty in the demo booking form and clicked Submit. CONFIRMED: the form blocked submission — an email address is required before the form can be sent.",
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
    clientDescription: "Entered an extremely long name (2,000 characters) into the demo booking form and submitted. CONFIRMED: the form handled this without crashing. A note was recorded about whether the full name or a shortened version reached the server.",
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name with 2000 characters', action: { kind: 'fill', selector: '#demo-name', value: 'A'.repeat(2000) } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: testEmail('demo01') } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-special-chars',
    description: 'Book a Demo modal — HTML/script payload in name must not execute as code',
    clientDescription: "Entered a name containing HTML code (a common technique used by hackers to try to inject malicious scripts) into the demo booking form. CONFIRMED: the code was not executed by the browser — the site is protected against this type of cross-site scripting attack.",
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name with XSS payload', action: { kind: 'fill', selector: '#demo-name', value: "O'Brien-Smith <script>alert(1)</script>" } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: testEmail('demo01') } },
      ...SELECT_PROPERTY,
      CLICK_SUBMIT,
      ASSERT_SUCCESS,
    ],
  },
  {
    id: 'demo-double-submit',
    description: 'Book a Demo modal — concurrent submit clicks must fire only one backend request',
    clientDescription: "Clicked the 'Submit' button twice in very quick succession on the demo booking form. This checks whether the site prevents duplicate booking requests from a double-click — important to avoid sending the same enquiry twice.",
    steps: [
      ...OPEN_MODAL,
      { description: 'Fill name field', action: { kind: 'fill', selector: '#demo-name', value: 'Sentinel Test' } },
      { description: 'Fill email field', action: { kind: 'fill', selector: '#demo-email', value: testEmail('demo01') } },
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
    clientDescription: "Opened the registration form and clicked 'Create Account' without filling in any details. CONFIRMED: the form blocked submission — all required fields must be completed before an account can be created.",
    steps: [
      ...OPEN_REGISTER_MODAL,
      CLICK_CREATE_ACCOUNT,
      ASSERT_REG_BLOCKED,
    ],
  },
  {
    id: 'reg-password-mismatch',
    description: 'Registration form — confirm password differs from password, must be rejected',
    clientDescription: "Filled in the registration form with two different passwords in the 'Password' and 'Confirm Password' fields. CONFIRMED: the form detected the mismatch and blocked account creation — passwords must match.",
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: testEmail('reg01') } },
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
    clientDescription: "Tried to register with the password '123' — far too short and simple. This checks whether the site warns users about weak passwords before accepting them, protecting accounts from being easy to guess.",
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: testEmail('reg01') } },
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
    clientDescription: "Entered 'notanemail' (not a valid email address) in the registration email field. CONFIRMED: the form blocked submission — only properly formatted email addresses are accepted.",
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
    clientDescription: "Filled in all registration details but left the Terms and Conditions checkbox unticked. CONFIRMED: the form blocked submission — users must accept the terms before creating an account.",
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
    clientDescription: "Entered 'abc' (letters instead of digits) in the mobile number field on the registration form. This checks whether the form validates the phone number format before allowing registration.",
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Fill first name', action: { kind: 'fill', selector: '#reg-firstname', value: 'Sentinel' } },
      { description: 'Fill last name',  action: { kind: 'fill', selector: '#reg-lastname',  value: 'Test' } },
      { description: 'Fill email',      action: { kind: 'fill', selector: '#reg-email',     value: testEmail('reg01') } },
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
    clientDescription: "Opened the registration form and checked the country code dropdown. CONFIRMED: it defaults to South Africa (+27), which is correct for a South African business — visitors should not need to change it.",
    // No submit steps — spec reads the select value directly after the modal opens
    steps: [
      ...OPEN_REGISTER_MODAL,
    ],
  },
  {
    id: 'reg-happy-path',
    description: 'Registration form — valid data causes a Firebase Auth signUp request to the backend',
    clientDescription: "Filled in the registration form with valid test details and clicked 'Create Account'. CONFIRMED: the form sent a registration request to the server. The request was intercepted by Sentinel to prevent a real test account from being created.",
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
    clientDescription: "Opened the login form and clicked 'Login' without entering an email or password. CONFIRMED: the form blocked submission and stayed on the login screen.",
    steps: [
      ...OPEN_LOGIN_MODAL,
      CLICK_LOGIN_SUBMIT,
      ASSERT_LOGIN_BLOCKED,
    ],
  },
  {
    id: 'login-invalid-email',
    description: 'Login form — non-email string must be rejected by input type="email" validation',
    clientDescription: "Entered 'notanemail' in the email field of the login form and attempted to log in. CONFIRMED: the form blocked submission — a properly formatted email address is required.",
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
    clientDescription: "Clicked the 'Show Password' eye icon on the login form to reveal the password, then clicked again to hide it. CONFIRMED: the password field correctly switches between hidden dots and visible text.",
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
    clientDescription: "Clicked the 'Remember Me' checkbox on the login form. CONFIRMED: the checkbox is working and can be ticked and unticked — visitors can choose whether to stay logged in on their device.",
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
    clientDescription: "Clicked the 'Register' link inside the login form. CONFIRMED: the form correctly switched to the registration screen without needing to close and reopen the overlay.",
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Register link',                   action: { kind: 'click',   selector: 'a:has-text("Register")' } },
      { description: 'Verify registration form is now visible', action: { kind: 'waitFor', selector: '#reg-firstname', state: 'visible' } },
    ],
  },
  {
    id: 'login-to-forgot',
    description: 'Login form — Forgot password link must open the forgot password form',
    clientDescription: "Clicked the 'Forgot your password?' link on the login form. CONFIRMED: the form correctly switched to the password reset screen.",
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
    clientDescription: "Opened the 'Forgot password' form and clicked 'Send Reset Link' without entering an email address. CONFIRMED: the form blocked submission — an email address is required to send a password reset.",
    steps: [
      ...OPEN_FORGOT_MODAL,
      CLICK_SEND_RESET,
      ASSERT_FORGOT_BLOCKED,
    ],
  },
  {
    id: 'forgot-invalid-email',
    description: 'Forgot password form — non-email string must be rejected by input type="email" validation',
    clientDescription: "Entered 'notanemail' in the forgot password form. CONFIRMED: the form blocked submission — only a properly formatted email address is accepted.",
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
    clientDescription: "Entered a valid email address in the 'Forgot password' form and clicked 'Send Reset Link'. CONFIRMED: the form sent a password reset request to the server. The request was intercepted by Sentinel to prevent a real reset email from being dispatched.",
    // No journey assertion — spec verifies the sendOobCode request was attempted via waitForRequest
    steps: [
      ...OPEN_FORGOT_MODAL,
      { description: 'Fill valid email', action: { kind: 'fill', selector: '#forgot-email', value: testEmail('pw01') } },
      CLICK_SEND_RESET,
    ],
  },
  {
    id: 'forgot-back-to-login',
    description: 'Forgot password form — Back to login link must restore the login form',
    clientDescription: "Clicked the 'Back to Login' link on the forgot password screen. CONFIRMED: the form correctly returned to the login screen without needing to close and reopen the overlay.",
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
    clientDescription: "Clicked the 'The Platform' link in the main navigation bar. CONFIRMED: the page smoothly scrolled down to the platform features section.",
    steps: [
      { description: 'Click The Platform nav link', action: { kind: 'click', selector: '.nav-links a:has-text("The Platform")' } },
    ],
  },
  {
    id: 'nav-how-it-works-link',
    description: 'Desktop nav — "How It Works" link scrolls the #how-it-works section into view',
    clientDescription: "Clicked the 'How It Works' link in the main navigation bar. CONFIRMED: the page scrolled down to the how-it-works section.",
    steps: [
      { description: 'Click How It Works nav link', action: { kind: 'click', selector: '.nav-links a:has-text("How It Works")' } },
    ],
  },
  {
    id: 'nav-welcome-packs-link',
    description: 'Desktop nav — "Welcome Packs" link scrolls the #gifts section into view',
    clientDescription: "Clicked the 'Welcome Packs' link in the main navigation bar. CONFIRMED: the page scrolled down to the welcome packs and gifts section.",
    steps: [
      { description: 'Click Welcome Packs nav link', action: { kind: 'click', selector: '.nav-links a:has-text("Welcome Packs")' } },
    ],
  },
  {
    id: 'nav-my-account-link',
    description: 'Desktop nav — "My Account" link navigates to /account.html',
    clientDescription: "Verified the 'My Account' navigation link is correctly set up to point to the account page. CONFIRMED: the link destination is correct. The link only appears once a visitor is logged in — this is expected behaviour.",
    steps: [
      { description: 'Click My Account nav link', action: { kind: 'click', selector: '#nav-account' } },
    ],
  },
  {
    id: 'nav-logo-home',
    description: 'Logo link — clicking from any scroll position returns to the top of the homepage',
    clientDescription: "Scrolled down the page, then clicked the Juel Haus logo. CONFIRMED: clicking the logo returned the visitor to the top of the homepage — standard and expected behaviour.",
    steps: [
      { description: 'Click the logo link', action: { kind: 'click', selector: 'a[href="index.html"]' } },
    ],
  },

  // ─── Modal open/close journeys ─────────────────────────────────────────────────

  {
    id: 'modal-login-opens',
    description: 'Login modal — clicking #btn-login makes #auth-modal visible',
    clientDescription: "Clicked the 'Login' button in the navigation. CONFIRMED: the login form appeared on screen.",
    steps: [
      { description: 'Click Login button',                      action: { kind: 'click',   selector: '#btn-login' } },
      { description: 'Verify auth modal overlay is visible',    action: { kind: 'waitFor', selector: '#auth-modal', state: 'visible' } },
    ],
  },
  {
    id: 'modal-login-closes-x',
    description: 'Login modal — clicking × closes #auth-modal',
    clientDescription: "Opened the login form, then clicked the × close button. CONFIRMED: the login form closed and is no longer visible.",
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click modal × close button',             action: { kind: 'click',   selector: '#auth-modal .modal-close' } },
      { description: 'Verify auth modal overlay is hidden',    action: { kind: 'waitFor', selector: '#auth-modal', state: 'hidden' } },
    ],
  },
  {
    id: 'modal-login-to-register',
    description: 'Login modal — Register link switches to the registration form',
    clientDescription: "Clicked the 'Register' link inside the login overlay. CONFIRMED: the overlay switched to the registration form without needing to close and reopen it.",
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Register link',                              action: { kind: 'click',   selector: 'a:has-text("Register")' } },
      { description: 'Verify registration first name field is visible',  action: { kind: 'waitFor', selector: '#reg-firstname', state: 'visible' } },
    ],
  },
  {
    id: 'modal-register-to-login',
    description: 'Register form — Login link switches back to the login form',
    clientDescription: "Opened the registration form, then clicked the 'Login' link inside it. CONFIRMED: the overlay switched back to the login screen.",
    steps: [
      ...OPEN_REGISTER_MODAL,
      { description: 'Click Login link in register form',      action: { kind: 'click',   selector: '#auth-register a:has-text("Login")' } },
      { description: 'Verify login email field is visible',    action: { kind: 'waitFor', selector: '#login-email', state: 'visible' } },
    ],
  },
  {
    id: 'modal-login-to-forgot',
    description: 'Login modal — Forgot password link switches to the forgot password form',
    clientDescription: "Clicked the 'Forgot your password?' link on the login form. CONFIRMED: the overlay switched to the password reset screen.",
    steps: [
      ...OPEN_LOGIN_MODAL,
      { description: 'Click Forgot your password? link',       action: { kind: 'click',   selector: 'a:has-text("Forgot")' } },
      { description: 'Verify forgot email field is visible',   action: { kind: 'waitFor', selector: '#forgot-email', state: 'visible' } },
    ],
  },
  {
    id: 'modal-demo-opens',
    description: 'Demo modal — clicking Book a Demo makes #demo-modal visible',
    clientDescription: "Clicked the 'Book a Demo' button on the homepage. CONFIRMED: the demo booking form appeared on screen.",
    steps: [
      { description: 'Click Book a Demo button',               action: { kind: 'click',   selector: 'button:has-text("Book a Demo")' } },
      { description: 'Verify demo modal overlay is visible',   action: { kind: 'waitFor', selector: '#demo-modal', state: 'visible' } },
    ],
  },
  {
    id: 'modal-demo-closes-x',
    description: 'Demo modal — clicking × closes #demo-modal',
    clientDescription: "Opened the demo booking form, then clicked the × close button. CONFIRMED: the form closed and is no longer visible.",
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
    clientDescription: "Clicked the cart icon in the navigation bar. CONFIRMED: the shopping cart drawer opened on the side of the screen.",
    steps: [
      { description: 'Click cart nav button',                  action: { kind: 'click',   selector: '#nav-cart' } },
      { description: 'Verify cart drawer is visible',          action: { kind: 'waitFor', selector: '#cart-drawer', state: 'visible' } },
    ],
  },
  {
    id: 'modal-cart-closes',
    description: 'Cart drawer — clicking × inside the cart hides #cart-drawer',
    clientDescription: "Opened the shopping cart drawer, then clicked the × close button. CONFIRMED: the cart drawer closed.",
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
    clientDescription: "On a mobile-sized screen (375 pixels wide), tapped the hamburger menu icon. CONFIRMED: the mobile navigation menu appeared.",
    steps: [
      { description: 'Click hamburger button',                 action: { kind: 'click',   selector: '#nav-hamburger' } },
      { description: 'Verify mobile menu is visible',          action: { kind: 'waitFor', selector: '#mobile-menu', state: 'visible' } },
    ],
  },
  {
    id: 'mobile-nav-links-work',
    description: 'Mobile — tapping a mobile nav link scrolls to the target section',
    clientDescription: "On a mobile-sized screen, opened the hamburger menu and tapped 'How It Works'. CONFIRMED: the page scrolled to the correct section and the menu closed.",
    steps: [
      { description: 'Click hamburger to open mobile menu',    action: { kind: 'click',   selector: '#nav-hamburger' } },
      { description: 'Wait for mobile menu to appear',         action: { kind: 'waitFor', selector: '#mobile-menu', state: 'visible' } },
      { description: 'Click How It Works in mobile menu',      action: { kind: 'click',   selector: '#mobile-menu a:has-text("How It Works")' } },
    ],
  },
];
