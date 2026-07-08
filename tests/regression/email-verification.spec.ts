import { test, expect } from '@playwright/test';
import { defaultSite, LIVE_MODE } from '../../src/config/sites';
import { getLatestVerificationEmail } from '../../src/utils/gmail';
import { registerForCheckout } from '../functional/checkout-helpers';

// Highest silent-break-risk category in this suite: a prior run found Firebase's default
// email action handler pointed at firebaseapp.com instead of the production domain — a
// defect invisible to every other check here since it only shows up by actually receiving
// and following the real verification email. Requires a real Gmail inbox and a real
// Firebase-sent email, so this is structurally impossible to verify in safe mode.

test.describe('Email verification', { tag: ['@regression'] }, () => {

  test.beforeEach(() => {
    test.skip(!LIVE_MODE, 'requires a real Gmail inbox and a real Firebase-sent email — set SENTINEL_LIVE_MODE=true to run');
  });

  test('verification-email-links-to-production-domain — the verification email arrives and its link stays on the production domain', async ({ page }) => {
    test.slow();
    test.info().annotations.push({
      type: 'description',
      description: 'Registered a fresh account, polled the Sentinel Gmail inbox for the Firebase verification email, and followed its link. Confirms both that the email arrives at all and that the link points at the production domain rather than the default firebaseapp.com action handler.',
    });

    const sentAfter = new Date();
    await registerForCheckout(page);

    const verificationLink = await getLatestVerificationEmail(sentAfter);

    if (!verificationLink) {
      console.error(
        '[FINDING][critical] verification-email-links-to-production-domain: verification email did not arrive within 30 seconds of registration.',
      );
    }
    expect(verificationLink, 'A verification email must arrive within 30 seconds of registration').not.toBeNull();

    console.log(`[INFO] verification-email-links-to-production-domain: link received — ${verificationLink}`);

    const expectedHost = new URL(defaultSite.baseUrl).hostname.replace(/^www\./, '');
    const linkHost      = new URL(verificationLink!).hostname.replace(/^www\./, '');

    if (linkHost !== expectedHost) {
      console.error(
        `[FINDING][high] verification-email-links-to-production-domain: verification link points to ` +
          `"${linkHost}" instead of "${expectedHost}". Firebase is sending users to the default ` +
          'action handler domain — update the "Email action handler URL" in Firebase Console.',
      );
    } else {
      console.log(`[INFO] verification-email-links-to-production-domain: link host matches "${expectedHost}" ✓`);
    }

    await page.goto(verificationLink!, { waitUntil: 'domcontentloaded' });

    const finalHost = new URL(page.url()).hostname.replace(/^www\./, '');
    if (finalHost !== expectedHost) {
      console.error(
        `[FINDING][high] verification-email-links-to-production-domain: after following the link, landed on ` +
          `"${finalHost}" instead of "${expectedHost}".`,
      );
    }

    const pageText = (await page.locator('body').textContent() ?? '').toLowerCase();
    const showsSuccess = pageText.includes('verified') || pageText.includes('verification') ||
      pageText.includes('confirmed') || pageText.includes('success');

    if (!showsSuccess) {
      console.warn(
        `[FINDING][medium] verification-email-links-to-production-domain: verification link was followed ` +
          `but the page on "${finalHost}" shows no recognisable success confirmation.`,
      );
    } else {
      console.log('[INFO] verification-email-links-to-production-domain: success confirmation shown ✓');
    }

    expect(linkHost, `Verification link must point to the production domain "${expectedHost}"`).toBe(expectedHost);
  });

});
